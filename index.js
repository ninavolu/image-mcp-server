import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createClerkClient } from "@clerk/backend";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { createServer } from "http";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env if present (local dev). Railway injects env vars directly.
try {
  const env = readFileSync(new URL(".env", import.meta.url), "utf8");
  for (const line of env.split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
  }
} catch {}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const BASE_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : "http://localhost:3000";

const CLERK_FRONTEND_API = "https://clerk.pixlib.app";

// ─── Opaque token store (in-memory) ──────────────────────────────────────────
// Maps our random token → { clerkToken, expiresAt }
const tokenStore = new Map();

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Auth helper ─────────────────────────────────────────────────────────────
async function validateToken(req) {
  const auth = req.headers["authorization"];
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);

  // Allow static inspector key for MCP Inspector testing
  if (process.env.INSPECTOR_KEY && token === process.env.INSPECTOR_KEY) {
    return { sub: "inspector" };
  }

  // Look up opaque token in store
  const entry = tokenStore.get(token);
  if (!entry) { console.log("[validateToken] token not found in store"); return null; }
  if (Date.now() > entry.expiresAt) { tokenStore.delete(token); console.log("[validateToken] token expired"); return null; }

  console.log("[validateToken] valid token for sub:", entry.sub);
  return { sub: entry.sub };
}

function unauthorized(res) {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

// ─── MCP Server factory ───────────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({ name: "image-library", version: "1.0.0" });

  // ─── search_images ──────────────────────────────────────────────────────────
  server.tool(
    "search_images",
    "Search the image library by purpose and/or tags. Returns matching images with their public URLs, purpose, tags, and description.",
    {
      purpose: z
        .enum(["landing-page","hero","document","thumbnail","icon","background","product","avatar","other"])
        .optional()
        .describe("Filter by intended use-case"),
      tags: z.array(z.string()).default([]).describe("Filter by tags — returns images that have ALL of these tags"),
      limit: z.number().default(10).describe("Max results to return"),
    },
    {
      title: "Search Images",
      readOnlyHint: true,
      openWorldHint: false,
    },
    async ({ purpose, tags, limit }) => {
      let query = supabase.from("images").select("*").limit(limit);
      if (purpose) query = query.eq("purpose", purpose);
      if (tags.length > 0) query = query.contains("tags", tags);
      const { data, error } = await query.order("created_at", { ascending: false });

      if (error) return { content: [{ type: "text", text: `Error querying images: ${error.message}` }] };
      if (!data.length) return { content: [{ type: "text", text: "No images found matching those criteria." }] };

      const results = data.map(img =>
        `• [${img.id}] ${img.name}\n  URL: ${img.file_path}\n  Purpose: ${img.purpose} | Tags: ${img.tags?.join(", ") || "none"}\n  ${img.description || ""}`
      ).join("\n\n");

      return { content: [{ type: "text", text: `Found ${data.length} image(s):\n\n${results}` }] };
    }
  );

  // ─── list_images ────────────────────────────────────────────────────────────
  server.tool(
    "list_images",
    "List all images in the library with their URLs, purpose, and tags. Supports pagination.",
    {
      limit: z.number().default(20).describe("Max results"),
      offset: z.number().default(0).describe("Offset for pagination"),
    },
    {
      title: "List Images",
      readOnlyHint: true,
      openWorldHint: false,
    },
    async ({ limit, offset }) => {
      const { data, error, count } = await supabase
        .from("images").select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) return { content: [{ type: "text", text: `Error: ${error.message}` }] };
      if (!data.length) return { content: [{ type: "text", text: "No images in library yet." }] };

      const results = data.map(img =>
        `• [${img.id}] ${img.name} — ${img.purpose}\n  Path: ${img.file_path}\n  Tags: ${img.tags?.join(", ") || "none"}`
      ).join("\n\n");

      return { content: [{ type: "text", text: `Showing ${offset + 1}–${offset + data.length} of ${count} image(s):\n\n${results}` }] };
    }
  );

  return server;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT;

if (PORT) {
  const transports = {};

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost`);
    console.log(`[req] ${req.method} ${url.pathname} auth:${req.headers["authorization"] ? "yes" : "no"}`);

    // ── Health check (public) ──
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "image-library" }));
      return;
    }

    // ── OAuth metadata discovery (required by MCP spec) ──
    if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        issuer: BASE_URL,
        authorization_endpoint: `${BASE_URL}/oauth/authorize`,
        token_endpoint: `${BASE_URL}/oauth/token`,
        userinfo_endpoint: `${BASE_URL}/oauth/userinfo`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
        scopes_supported: ["profile", "email", "offline_access"],
      }));
      return;
    }

    // ── Userinfo proxy ──
    if (url.pathname === "/oauth/userinfo") {
      const auth = req.headers["authorization"];
      const proxyRes = await fetch(`${CLERK_FRONTEND_API}/oauth/userinfo`, {
        headers: { Authorization: auth },
      });
      const data = await proxyRes.json();
      res.writeHead(proxyRes.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
      return;
    }

    // ── OAuth authorize — redirect to Clerk OAuth ──
    if (url.pathname === "/oauth/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const codeChallenge = url.searchParams.get("code_challenge");
      const codeChallengeMethod = url.searchParams.get("code_challenge_method");

      const clerkAuthUrl = new URL(`${CLERK_FRONTEND_API}/oauth/authorize`);
      clerkAuthUrl.searchParams.set("client_id", process.env.CLERK_OAUTH_CLIENT_ID);
      clerkAuthUrl.searchParams.set("redirect_uri", `${BASE_URL}/oauth/callback`);
      clerkAuthUrl.searchParams.set("response_type", "code");
      clerkAuthUrl.searchParams.set("scope", "profile email");
      clerkAuthUrl.searchParams.set("state", Buffer.from(JSON.stringify({ state, redirectUri })).toString("base64"));
      if (codeChallenge) clerkAuthUrl.searchParams.set("code_challenge", codeChallenge);
      if (codeChallengeMethod) clerkAuthUrl.searchParams.set("code_challenge_method", codeChallengeMethod);

      res.writeHead(302, { Location: clerkAuthUrl.toString() });
      res.end();
      return;
    }

    // ── OAuth callback — exchange Clerk code for token ──
    if (url.pathname === "/oauth/callback") {
      const code = url.searchParams.get("code");
      const stateRaw = url.searchParams.get("state");

      let redirectUri, originalState;
      try {
        ({ redirectUri, state: originalState } = JSON.parse(Buffer.from(stateRaw, "base64").toString()));
      } catch {
        res.writeHead(400); res.end("Bad request"); return;
      }

      const redirect = `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(originalState || "")}`;
      res.writeHead(302, { Location: redirect });
      res.end();
      return;
    }

    // ── OAuth token exchange ──
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", async () => {
        const params = new URLSearchParams(body);
        const code = params.get("code");
        const codeVerifier = params.get("code_verifier");

        // Exchange code with Clerk
        console.log("[token] exchanging code with Clerk, redirect_uri:", `${BASE_URL}/oauth/callback`);
        const tokenRes = await fetch(`${CLERK_FRONTEND_API}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: `${BASE_URL}/oauth/callback`,
            client_id: process.env.CLERK_OAUTH_CLIENT_ID,
            client_secret: process.env.CLERK_OAUTH_CLIENT_SECRET,
            ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
          }),
        });

        const tokenData = await tokenRes.json();
        console.log("[token] Clerk response status:", tokenRes.status);

        if (!tokenData.access_token) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "token_exchange_failed", details: tokenData }));
          return;
        }

        // Get user info from Clerk to store sub
        const userRes = await fetch(`${CLERK_FRONTEND_API}/oauth/userinfo`, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const userData = await userRes.json();
        const sub = userData.sub || "unknown";

        // Generate opaque token and store it
        const opaqueToken = generateToken();
        const expiresIn = tokenData.expires_in || 86400;
        tokenStore.set(opaqueToken, {
          clerkToken: tokenData.access_token,
          sub,
          expiresAt: Date.now() + expiresIn * 1000,
        });

        console.log("[token] issued opaque token for sub:", sub);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          access_token: opaqueToken,
          token_type: "Bearer",
          expires_in: expiresIn,
          scope: tokenData.scope,
        }));
      });
      return;
    }

    // ── SSE (protected) ──
    if (url.pathname === "/sse") {
      const user = await validateToken(req);
      if (!user) { unauthorized(res); return; }

      const transport = new SSEServerTransport("/message", res);
      transports[transport.sessionId] = transport;
      res.on("close", () => delete transports[transport.sessionId]);

      const server = createMcpServer();
      await server.connect(transport);
      return;
    }

    // ── Message endpoint (protected) ──
    if (url.pathname === "/message") {
      const user = await validateToken(req);
      if (!user) { unauthorized(res); return; }

      const sessionId = url.searchParams.get("sessionId");
      const transport = transports[sessionId];
      if (!transport) { res.writeHead(404); res.end("Session not found"); return; }
      await transport.handlePostMessage(req, res);
      return;
    }

    // ── Serve public docs/privacy page ──
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const filePath = join(__dirname, "public", "index.html");
      if (existsSync(filePath)) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(readFileSync(filePath));
        return;
      }
    }

    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.listen(PORT, () => {
    console.log(`image-library MCP server running on port ${PORT}`);
  });
} else {
  // Local Claude Desktop: stdio (no auth needed)
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

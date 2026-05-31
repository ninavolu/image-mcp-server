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

// ─── Auth helper ─────────────────────────────────────────────────────────────
async function validateToken(req) {
  const auth = req.headers["authorization"];
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  try {
    const payload = await clerk.verifyToken(token);
    return payload;
  } catch {
    return null;
  }
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
    {
      title: "Search Images",
      description: "Search the image library by purpose and/or tags. Returns matching images with their file paths.",
      readOnlyHint: true,
      openWorldHint: false,
    },
    {
      purpose: z
        .enum(["landing-page","hero","document","thumbnail","icon","background","product","avatar","other"])
        .optional()
        .describe("Filter by intended use-case"),
      tags: z.array(z.string()).default([]).describe("Filter by tags — returns images that have ALL of these tags"),
      limit: z.number().default(10).describe("Max results to return"),
    },
    async ({ purpose, tags, limit }) => {
      let query = supabase.from("images").select("*").limit(limit);
      if (purpose) query = query.eq("purpose", purpose);
      if (tags.length > 0) query = query.contains("tags", tags);
      const { data, error } = await query.order("created_at", { ascending: false });

      if (error) return { content: [{ type: "text", text: `Error: ${error.message}` }] };
      if (!data.length) return { content: [{ type: "text", text: "No images found matching those criteria." }] };

      const results = data.map(img =>
        `• [${img.id}] ${img.name}\n  Path: ${img.file_path}\n  Purpose: ${img.purpose} | Tags: ${img.tags?.join(", ") || "none"}\n  ${img.description || ""}`
      ).join("\n\n");

      return { content: [{ type: "text", text: `Found ${data.length} image(s):\n\n${results}` }] };
    }
  );

  // ─── list_images ────────────────────────────────────────────────────────────
  server.tool(
    "list_images",
    {
      title: "List Images",
      description: "List all images in the library, optionally paginated.",
      readOnlyHint: true,
      openWorldHint: false,
    },
    {
      limit: z.number().default(20).describe("Max results"),
      offset: z.number().default(0).describe("Offset for pagination"),
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

    // ── Health check (public) ──
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "image-library" }));
      return;
    }

    // ── OAuth metadata discovery (required by MCP spec) ──
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        issuer: BASE_URL,
        authorization_endpoint: `${BASE_URL}/oauth/authorize`,
        token_endpoint: `${BASE_URL}/oauth/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
      }));
      return;
    }

    // ── OAuth authorize — redirect to Clerk hosted login ──
    if (url.pathname === "/oauth/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const codeChallenge = url.searchParams.get("code_challenge");

      // Store params in a temp cookie so callback can use them
      const params = Buffer.from(JSON.stringify({ redirectUri, state, codeChallenge })).toString("base64");
      const clerkSignIn = `${process.env.CLERK_PUBLISHABLE_KEY ? "https://accounts." + process.env.CLERK_PUBLISHABLE_KEY.split("_")[2]?.replace(/([a-z])([A-Z])/g,"$1.$2").toLowerCase() + ".clerk.accounts.dev" : "https://clerk.com"}/sign-in?redirect_url=${encodeURIComponent(BASE_URL + "/oauth/callback?params=" + params)}`;

      res.writeHead(302, { Location: clerkSignIn });
      res.end();
      return;
    }

    // ── OAuth callback — exchange Clerk session for MCP token ──
    if (url.pathname === "/oauth/callback") {
      const sessionToken = url.searchParams.get("__clerk_db_jwt") ||
                           req.headers["cookie"]?.match(/__session=([^;]+)/)?.[1];
      const paramsRaw = url.searchParams.get("params");

      let redirectUri, state;
      try {
        ({ redirectUri, state } = JSON.parse(Buffer.from(paramsRaw, "base64").toString()));
      } catch {
        res.writeHead(400); res.end("Bad request"); return;
      }

      // Use session token as the auth code (Clerk JWT is self-contained)
      const code = sessionToken || "no-session";
      const redirect = `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state || "")}`;
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

        // The code is the Clerk JWT — return it as the access token
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          access_token: code,
          token_type: "Bearer",
          expires_in: 3600,
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

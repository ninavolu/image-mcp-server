import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { createServer } from "http";
import { z } from "zod";

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
  // Railway / remote: SSE over HTTP
  // Each client connection gets its own McpServer instance
  const transports = {};

  const httpServer = createServer(async (req, res) => {
    // Health check
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "image-library" }));
      return;
    }

    // SSE connection
    if (req.url === "/sse") {
      const transport = new SSEServerTransport("/message", res);
      transports[transport.sessionId] = transport;

      res.on("close", () => delete transports[transport.sessionId]);

      const server = createMcpServer();
      await server.connect(transport);
      return;
    }

    // Message endpoint
    if (req.url?.startsWith("/message")) {
      const sessionId = new URL(req.url, `http://localhost`).searchParams.get("sessionId");
      const transport = transports[sessionId];
      if (!transport) {
        res.writeHead(404);
        res.end("Session not found");
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.listen(PORT, () => {
    console.log(`image-library MCP server running on port ${PORT}`);
  });
} else {
  // Local Claude Desktop: stdio
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

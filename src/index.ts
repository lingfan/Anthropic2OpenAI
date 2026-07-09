import { convertRequest, convertResponse, convertStream } from "./convert";
import type { AnthropicRequest, AnthropicErrorResponse, OpenAIResponse } from "./types";

// ============================================================
// Configuration
// ============================================================

// Bun auto-loads `.env` from the project root into process.env.
const PORT = Number(process.env.PORT) || 7878;
const TARGET_URL = process.env.TARGET_URL || "http://127.0.0.1:1234";
const TARGET_MODEL = process.env.TARGET_MODEL?.trim() || undefined;
const DEBUG = process.env.DEBUG === "true";

// ============================================================
// Server
// ============================================================

const server = Bun.serve({
  port: PORT,
  // LLM upstreams often take >10s before the first byte. Bun's default
  // idleTimeout is 10s and will abort the client connection mid-wait.
  // 0 disables the idle timeout entirely (max non-zero value is 255s).
  idleTimeout: 0,
  async fetch(req, bunServer): Promise<Response> {
    const url = new URL(req.url);

    // --- Routes ---

    // Health check
    if (url.pathname === "/health" && req.method === "GET") {
      return json({ status: "ok", target: TARGET_URL });
    }

    // Main proxy endpoint: Anthropic /v1/messages → OpenAI /v1/chat/completions
    if (url.pathname === "/v1/messages" && req.method === "POST") {
      // Also clear per-request idle timeout (covers streaming gaps between tokens).
      bunServer.timeout(req, 0);
      return handleMessages(req);
    }

    return jsonError("Not found", 404);
  },
});

console.log(`┌─────────────────────────────────────────────────────┐`);
console.log(`│  Anthropic → OpenAI proxy                           │`);
console.log(`│  Listening:  http://localhost:${PORT}`.padEnd(55) + `│`);
console.log(`│  Upstream:   ${TARGET_URL}/v1/chat/completions`.padEnd(55) + `│`);
console.log(`│  Endpoint:   POST /v1/messages (Anthropic format)`.padEnd(55) + `│`);
console.log(`└─────────────────────────────────────────────────────┘`);

// ============================================================
// Request handler
// ============================================================

async function handleMessages(req: Request): Promise<Response> {
  let anthropicBody: AnthropicRequest;

  try {
    anthropicBody = (await req.json()) as AnthropicRequest;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!anthropicBody.messages?.length) {
    return jsonError("messages is required and must be non-empty", 400);
  }

  const isStream = anthropicBody.stream === true;

  // Convert request: Anthropic → OpenAI
  const openaiReq = convertRequest(anthropicBody, TARGET_MODEL);

  if (DEBUG) {
    console.debug("[req] → OpenAI:\n", JSON.stringify(openaiReq, null, 2));
  }

  // Build upstream headers
  const upstreamHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Forward x-api-key as Bearer token (some OpenAI-compatible servers need it)
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) {
    upstreamHeaders["Authorization"] = `Bearer ${apiKey}`;
  }

  // Forward to upstream OpenAI-compatible server
  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(`${TARGET_URL}/v1/chat/completions`, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(openaiReq),
    });
  } catch (err) {
    return jsonError(
      `Failed to connect to upstream: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }

  // Handle upstream errors
  if (!upstreamResp.ok) {
    const errText = await upstreamResp.text().catch(() => "");
    return jsonError(
      `Upstream error (${upstreamResp.status}): ${errText || upstreamResp.statusText}`,
      upstreamResp.status,
    );
  }

  // Convert response: OpenAI → Anthropic
  if (isStream) {
    return convertStream(upstreamResp, anthropicBody.model);
  }

  const openaiResp = (await upstreamResp.json()) as OpenAIResponse;
  if (DEBUG) {
    console.debug("[resp] ← OpenAI:\n", JSON.stringify(openaiResp, null, 2));
  }

  const anthropicResp = convertResponse(openaiResp, anthropicBody.model);
  return json(anthropicResp);
}

// ============================================================
// Helpers
// ============================================================

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(message: string, status: number): Response {
  const body: AnthropicErrorResponse = {
    type: "error",
    error: {
      type: status >= 500 ? "api_error" : "invalid_request_error",
      message,
    },
  };
  return json(body, status);
}

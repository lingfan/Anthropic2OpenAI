/**
 * Full integration test: mock upstream (port 1234) + real proxy (port 3000).
 * Sends Anthropic-format requests through the proxy and verifies the output.
 */

// --- Start mock OpenAI-compatible upstream on port 1234 ---
const upstream = Bun.serve({
  port: 1234,
  async fetch(req: Request): Promise<Response> {
    const body = await req.json();
    const isStream = body.stream === true;

    if (isStream) {
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: "Hi " }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: "there!" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
      ];
      const sse = chunks.map((c) => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: body.model, ...c })}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
    }

    // Non-streaming
    return Response.json({
      id: "test-123",
      object: "chat.completion",
      created: 123,
      model: body.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Hello from upstream!" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  },
});

console.log(`Mock upstream on http://localhost:${upstream.port}`);

// --- Start the real proxy (import the server logic) ---
// We'll spawn it as a subprocess
const proxyProc = Bun.spawn(["bun", "run", `${import.meta.dir}/index.ts`], {
  stdout: "inherit",
  stderr: "inherit",
});

// Wait for proxy to start
await Bun.sleep(1500);

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

try {
  // --- Test 1: Non-streaming through proxy ---
  console.log("\n--- Integration: Non-streaming ---");
  {
    const resp = await fetch("http://localhost:3000/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "test-key", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 100,
        system: "Be helpful.",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    check(resp.status === 200, "non-stream: status 200");
    check(resp.headers.get("content-type") === "application/json", "non-stream: json content-type");
    const data = await resp.json();
    check(data.type === "message", "non-stream: type=message");
    check(data.role === "assistant", "non-stream: role=assistant");
    check(data.id.startsWith("msg_"), "non-stream: id starts with msg_");
    check(data.content.length === 1, "non-stream: 1 content block");
    check(data.content[0].type === "text", "non-stream: text block");
    check(data.content[0].text === "Hello from upstream!", "non-stream: text matches");
    check(data.stop_reason === "end_turn", "non-stream: stop_reason=end_turn");
    check(data.usage.input_tokens === 10, "non-stream: input_tokens=10");
    check(data.usage.output_tokens === 5, "non-stream: output_tokens=5");
  }

  // --- Test 2: Streaming through proxy ---
  console.log("\n--- Integration: Streaming ---");
  {
    const resp = await fetch("http://localhost:3000/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    check(resp.status === 200, "stream: status 200");
    check(resp.headers.get("content-type")?.includes("text/event-stream"), "stream: SSE content-type");

    const text = await resp.text();
    const events: string[] = [];
    for (const block of text.split("\n\n")) {
      const line = block.split("\n").find((l) => l.startsWith("event: "));
      if (line) events.push(line.slice(7));
    }

    check(events[0] === "message_start", "stream: first event message_start");
    check(events.includes("content_block_start"), "stream: has content_block_start");
    check(events.includes("content_block_delta"), "stream: has content_block_delta");
    check(events.includes("content_block_stop"), "stream: has content_block_stop");
    check(events.includes("message_delta"), "stream: has message_delta");
    check(events[events.length - 1] === "message_stop", "stream: last event message_stop");

    // Reassemble text
    let fullText = "";
    for (const block of text.split("\n\n")) {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      const data = dataLine.slice(6);
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        if (parsed.delta?.type === "text_delta") fullText += parsed.delta.text;
      } catch {}
    }
    check(fullText === "Hi there!", `stream: text reassembled (got "${fullText}")`);
  }

  // --- Test 3: Error handling (upstream unreachable) ---
  console.log("\n--- Integration: Error handling ---");
  {
    // Start a second proxy pointing at a dead port
    const deadProxy = Bun.spawn(["bun", "run", `${import.meta.dir}/index.ts`], {
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, PORT: "3001", TARGET_URL: "http://127.0.0.1:19998" },
    });
    await Bun.sleep(1500);

    const resp = await fetch("http://localhost:3001/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 100,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    const respText = await resp.text();
    check(resp.status === 502, `error: 502 when upstream unreachable (got ${resp.status})`);
    let data: any;
    try { data = JSON.parse(respText); } catch { data = {}; }
    check(data.type === "error", "error: type=error");
    check(
      data?.error?.message?.includes("upstream") || data?.error?.message?.includes("connect"),
      "error: message mentions upstream/connect",
    );
    deadProxy.kill();
  }
} finally {
  proxyProc.kill();
}

console.log(`\n${"=".repeat(50)}`);
console.log(`Integration results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(50)}`);
process.exit(failed > 0 ? 1 : 0);

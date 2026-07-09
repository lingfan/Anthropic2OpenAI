/**
 * End-to-end test for the anthropic-proxy.
 *
 * Starts a mock OpenAI-compatible server, then starts the proxy,
 * and sends both non-streaming and streaming Anthropic-format requests.
 */

import { convertRequest, convertResponse, convertStream } from "./convert";
import type { AnthropicRequest, OpenAIResponse } from "./types";

// ============================================================
// Test helpers
// ============================================================

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${msg} (got ${a}, expected ${e})`);
}

// ============================================================
// Mock OpenAI server
// ============================================================

const mockServer = Bun.serve({
  port: 19999,
  async fetch(req: Request): Promise<Response> {
    const body = await req.json();
    const isStream = body.stream === true;

    if (isStream) {
      // Simulate OpenAI streaming response
      const chunks: string[] = [];

      // Initial chunk
      chunks.push(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 1234567890,
          model: body.model,
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        }),
      );

      // Content chunks
      for (const word of ["Hello", " world", "!"]) {
        chunks.push(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            created: 1234567890,
            model: body.model,
            choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
          }),
        );
      }

      // Final chunk with finish_reason and usage
      chunks.push(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 1234567890,
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }),
      );

      chunks.push("[DONE]");

      const sse = chunks.map((c) => `data: ${c}\n\n`).join("");
      return new Response(sse, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    // Non-streaming response
    const hasTools = body.tools?.length > 0;

    if (hasTools) {
      const resp: OpenAIResponse = {
        id: "chatcmpl-test-tools",
        object: "chat.completion",
        created: 1234567890,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Let me check that for you.",
              tool_calls: [
                {
                  id: "call_abc123",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: JSON.stringify({ location: "San Francisco, CA", unit: "celsius" }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
      };
      return Response.json(resp);
    }

    // Regular text response
    const resp: OpenAIResponse = {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1234567890,
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello! How can I help you?" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 },
    };
    return Response.json(resp);
  },
});

console.log(`Mock OpenAI server on http://localhost:${mockServer.port}`);

// ============================================================
// Tests
// ============================================================

async function runTests(): Promise<void> {
  console.log("\n--- Test 1: Request conversion (basic) ---");
  {
    const anthropicReq: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: "You are helpful.",
      messages: [{ role: "user", content: "Hello" }],
    };
    const openaiReq = convertRequest(anthropicReq);
    assert(openaiReq.model === "claude-3-5-sonnet-20241022", "model forwarded");
    assert(openaiReq.max_tokens === 1024, "max_tokens forwarded");
    assert(openaiReq.messages.length === 2, "system + user = 2 messages");
    assert(openaiReq.messages[0].role === "system", "system message first");
    assert(openaiReq.messages[0].content === "You are helpful.", "system content correct");
    assert(openaiReq.messages[1].role === "user", "user message second");
    assert(openaiReq.messages[1].content === "Hello", "user content correct");
  }

  console.log("\n--- Test 2: Request conversion (tools + tool_result) ---");
  {
    const anthropicReq: AnthropicRequest = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "call_1", name: "get_weather", input: { location: "NYC" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "Sunny, 72°F" },
          ],
        },
      ],
      tools: [
        {
          name: "get_weather",
          description: "Get weather",
          input_schema: { type: "object", properties: { location: { type: "string" } } },
        },
      ],
      tool_choice: { type: "auto" },
    };
    const openaiReq = convertRequest(anthropicReq);
    assert(openaiReq.tools?.length === 1, "1 tool converted");
    assert(openaiReq.tools?.[0].function.name === "get_weather", "tool name correct");
    assert(openaiReq.tool_choice === "auto", "tool_choice auto");
    // user, assistant(with tool_calls), tool
    assert(openaiReq.messages.length === 3, "3 messages");
    assert(openaiReq.messages[1].tool_calls?.length === 1, "assistant has 1 tool_call");
    assert(openaiReq.messages[1].tool_calls?.[0].function.name === "get_weather", "tool_call name");
    assert(
      openaiReq.messages[1].tool_calls?.[0].function.arguments === JSON.stringify({ location: "NYC" }),
      "tool_call args serialized",
    );
    assert(openaiReq.messages[2].role === "tool", "tool_result → tool role");
    assert(openaiReq.messages[2].tool_call_id === "call_1", "tool_call_id correct");
    assert(openaiReq.messages[2].content === "Sunny, 72°F", "tool result content correct");
  }

  console.log("\n--- Test 3: Response conversion (text) ---");
  {
    const openaiResp: OpenAIResponse = {
      id: "chatcmpl-x",
      object: "chat.completion",
      created: 123,
      model: "gpt-4",
      choices: [
        { index: 0, message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };
    const anthropicResp = convertResponse(openaiResp, "claude-3-5-sonnet-20241022");
    assert(anthropicResp.id === "msg_chatcmpl-x", "id prefixed");
    assert(anthropicResp.type === "message", "type is message");
    assert(anthropicResp.role === "assistant", "role is assistant");
    assert(anthropicResp.content.length === 1, "1 content block");
    assert(anthropicResp.content[0].type === "text", "content is text");
    assert((anthropicResp.content[0] as any).text === "Hi!", "text correct");
    assert(anthropicResp.stop_reason === "end_turn", "stop_reason end_turn");
    assert(anthropicResp.usage.input_tokens === 5, "input_tokens");
    assert(anthropicResp.usage.output_tokens === 2, "output_tokens");
  }

  console.log("\n--- Test 4: Response conversion (tool_use) ---");
  {
    const openaiResp: OpenAIResponse = {
      id: "chatcmpl-y",
      object: "chat.completion",
      created: 123,
      model: "gpt-4",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Checking...",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"location":"NYC"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const anthropicResp = convertResponse(openaiResp, "claude-3-5-sonnet-20241022");
    assert(anthropicResp.content.length === 2, "2 content blocks (text + tool_use)");
    assert(anthropicResp.content[0].type === "text", "first block is text");
    assert(anthropicResp.content[1].type === "tool_use", "second block is tool_use");
    assert((anthropicResp.content[1] as any).name === "get_weather", "tool name");
    assertEq((anthropicResp.content[1] as any).input, { location: "NYC" }, "tool input parsed");
    assert(anthropicResp.stop_reason === "tool_use", "stop_reason tool_use");
  }

  console.log("\n--- Test 5: End-to-end non-streaming ---");
  {
    const resp = await fetch("http://localhost:19999/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 100,
      }),
    });
    const openaiResp = (await resp.json()) as OpenAIResponse;
    const anthropicResp = convertResponse(openaiResp, "claude-test");
    assert(anthropicResp.content[0].type === "text", "e2e: text content");
    assert((anthropicResp.content[0] as any).text === "Hello! How can I help you?", "e2e: text matches");
  }

  console.log("\n--- Test 6: End-to-end streaming ---");
  {
    const resp = await fetch("http://localhost:19999/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 100,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });

    const anthropicStreamResp = convertStream(resp, "claude-test");
    const text = await anthropicStreamResp.text();

    // Parse SSE events
    const events: Array<{ event: string; data: string }> = [];
    for (const block of text.split("\n\n")) {
      if (!block.trim()) continue;
      const lines = block.split("\n");
      let event = "";
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) event = line.slice(7);
        if (line.startsWith("data: ")) data = line.slice(6);
      }
      if (event) events.push({ event, data });
    }

    const eventTypes = events.map((e) => e.event);
    assert(eventTypes[0] === "message_start", "stream: first event message_start");
    assert(eventTypes.includes("ping"), "stream: has ping");
    assert(eventTypes.includes("content_block_start"), "stream: has content_block_start");
    assert(eventTypes.includes("content_block_delta"), "stream: has content_block_delta");
    assert(eventTypes.includes("content_block_stop"), "stream: has content_block_stop");
    assert(eventTypes.includes("message_delta"), "stream: has message_delta");
    assert(eventTypes[eventTypes.length - 1] === "message_stop", "stream: last event message_stop");

    // Extract text from deltas
    let fullText = "";
    for (const e of events) {
      if (e.event === "content_block_delta") {
        const parsed = JSON.parse(e.data);
        if (parsed.delta?.type === "text_delta") {
          fullText += parsed.delta.text;
        }
      }
    }
    assert(fullText === "Hello world!", `stream: text reassembled (got "${fullText}")`);

    // Check stop_reason in message_delta
    const msgDelta = events.find((e) => e.event === "message_delta");
    const msgDeltaData = JSON.parse(msgDelta!.data);
    assert(msgDeltaData.delta.stop_reason === "end_turn", "stream: stop_reason end_turn");
    assert(msgDeltaData.usage.output_tokens === 3, "stream: output_tokens from usage");
  }

  console.log("\n--- Test 7: tool_choice mapping ---");
  {
    assertEq(
      convertRequest({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "x" }], tool_choice: { type: "any" } }).tool_choice,
      "required",
      "tool_choice any → required",
    );
    assertEq(
      convertRequest({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "x" }], tool_choice: { type: "tool", name: "foo" } }).tool_choice,
      { type: "function", function: { name: "foo" } },
      "tool_choice tool → function",
    );
  }

  console.log("\n--- Test 8: Image content ---");
  {
    const openaiReq = convertRequest({
      model: "m",
      max_tokens: 1,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR..." } },
          ],
        },
      ],
    });
    const userMsg = openaiReq.messages[0];
    assert(Array.isArray(userMsg.content), "image: content is array");
    assert((userMsg.content as any[]).length === 2, "image: 2 parts");
    assert((userMsg.content as any[])[1].type === "image_url", "image: second part is image_url");
    assert(
      (userMsg.content as any[])[1].image_url.url === "data:image/png;base64,iVBOR...",
      "image: data URL correct",
    );
  }
}

runTests()
  .then(() => {
    console.log(`\n${"=".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`${"=".repeat(50)}`);
    mockServer.stop();
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error("Test error:", err);
    mockServer.stop();
    process.exit(1);
  });

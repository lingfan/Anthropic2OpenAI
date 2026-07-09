import type {
  AnthropicRequest,
  AnthropicResponse,
  AnthropicContentBlock,
  OpenAIRequest,
  OpenAIResponse,
  OpenAIMessage,
} from "./types";

// ============================================================
// Request Conversion: Anthropic → OpenAI
// ============================================================

/**
 * Convert an Anthropic /v1/messages request body into an OpenAI
 * /v1/chat/completions request body.
 */
export function convertRequest(
  anthropic: AnthropicRequest,
  targetModel?: string,
): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // 1. System prompt — Anthropic puts it at top level; OpenAI uses a message.
  if (anthropic.system) {
    const sysContent =
      typeof anthropic.system === "string"
        ? anthropic.system
        : anthropic.system.map((b) => b.text).join("\n");
    messages.push({ role: "system", content: sysContent });
  }

  // 2. Conversation messages
  for (const msg of anthropic.messages) {
    if (msg.role === "user") {
      pushUserMessage(messages, msg.content);
    } else if (msg.role === "assistant") {
      pushAssistantMessage(messages, msg.content);
    }
  }

  const openaiReq: OpenAIRequest = {
    model: targetModel || anthropic.model,
    messages,
    max_tokens: anthropic.max_tokens,
  };

  if (anthropic.temperature !== undefined) {
    openaiReq.temperature = anthropic.temperature;
  }
  if (anthropic.top_p !== undefined) {
    openaiReq.top_p = anthropic.top_p;
  }
  if (anthropic.stop_sequences?.length) {
    openaiReq.stop = anthropic.stop_sequences;
  }
  if (anthropic.stream) {
    openaiReq.stream = true;
    // Ask the upstream for token usage in the final stream chunk.
    openaiReq.stream_options = { include_usage: true };
  }

  // 3. Tools
  if (anthropic.tools?.length) {
    openaiReq.tools = anthropic.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  // 4. Tool choice
  if (anthropic.tool_choice) {
    const tc = anthropic.tool_choice;
    if (tc.type === "auto") {
      openaiReq.tool_choice = "auto";
    } else if (tc.type === "any") {
      openaiReq.tool_choice = "required";
    } else if (tc.type === "tool" && tc.name) {
      openaiReq.tool_choice = { type: "function", function: { name: tc.name } };
    }
  }

  return openaiReq;
}

/** Convert a user message's content (string or block array) into OpenAI messages. */
function pushUserMessage(
  messages: OpenAIMessage[],
  content: string | AnthropicContentBlock[],
): void {
  if (typeof content === "string") {
    messages.push({ role: "user", content });
    return;
  }

  // Separate tool_result blocks (→ individual "tool" role messages in OpenAI)
  // from text/image blocks (→ a single "user" message).
  const toolResults: Extract<
    AnthropicContentBlock,
    { type: "tool_result" }
  >[] = [];
  const otherParts: Array<Record<string, unknown>> = [];

  for (const block of content) {
    if (block.type === "tool_result") {
      toolResults.push(block);
    } else if (block.type === "text") {
      otherParts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      const url = `data:${block.source.media_type};base64,${block.source.data}`;
      otherParts.push({ type: "image_url", image_url: { url } });
    }
  }

  // Tool results must come first (they reference the preceding assistant tool_calls).
  for (const tr of toolResults) {
    const trContent =
      typeof tr.content === "string"
        ? tr.content
        : tr.content.map((b) => b.text).join("\n");
    messages.push({
      role: "tool",
      tool_call_id: tr.tool_use_id,
      content: tr.is_error ? `[ERROR] ${trContent}` : trContent,
    });
  }

  if (otherParts.length > 0) {
    // If there's only a single text part, send a plain string (wider compatibility).
    if (otherParts.length === 1 && otherParts[0].type === "text") {
      messages.push({ role: "user", content: otherParts[0].text as string });
    } else {
      messages.push({ role: "user", content: otherParts as never });
    }
  }
}

/** Convert an assistant message's content blocks into an OpenAI assistant message. */
function pushAssistantMessage(
  messages: OpenAIMessage[],
  content: string | AnthropicContentBlock[],
): void {
  if (typeof content === "string") {
    messages.push({ role: "assistant", content });
    return;
  }

  const textParts: string[] = [];
  const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];

  for (const block of content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  const msg: OpenAIMessage = {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("") : null,
  };
  if (toolCalls.length > 0) {
    msg.tool_calls = toolCalls;
  }
  messages.push(msg);
}

// ============================================================
// Response Conversion: OpenAI → Anthropic (non-streaming)
// ============================================================

/** Map OpenAI finish_reason to Anthropic stop_reason. */
function mapStopReason(finishReason: string): string {
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    default:
      return "end_turn";
  }
}

/** Convert an OpenAI chat completion response into an Anthropic message response. */
export function convertResponse(
  openai: OpenAIResponse,
  model: string,
): AnthropicResponse {
  const choice = openai.choices?.[0];
  if (!choice) {
    throw new Error("Upstream returned no choices");
  }

  const content: AnthropicContentBlock[] = [];

  // Text content
  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }

  // Tool calls
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function.arguments || "{}");
      } catch {
        // If arguments aren't valid JSON, pass the raw string.
        input = { raw: tc.function.arguments };
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  const stopReason = mapStopReason(choice.finish_reason ?? "stop");

  return {
    id: `msg_${openai.id}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openai.usage?.prompt_tokens ?? 0,
      output_tokens: openai.usage?.completion_tokens ?? 0,
    },
  };
}

// ============================================================
// Stream Conversion: OpenAI SSE → Anthropic SSE
// ============================================================

/**
 * Consume the upstream OpenAI streaming response and produce a new
 * ReadableStream that emits Anthropic-format SSE events.
 *
 * Anthropic streaming event sequence:
 *   message_start → (content_block_start → content_block_delta* → content_block_stop)*
 *   → message_delta → message_stop
 */
export function convertStream(
  upstream: Response,
  model: string,
): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const enqueue = (event: string, data: unknown) => {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };

      const messageId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

      // --- State machine ---
      let messageStarted = false;
      let currentBlockIndex = -1;
      let currentBlockType: "text" | "tool_use" | null = null;
      let stopReason = "end_turn";
      let outputTokens = 0;
      let inputTokens = 0;

      const startMessage = () => {
        if (messageStarted) return;
        messageStarted = true;
        enqueue("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        enqueue("ping", { type: "ping" });
      };

      const closeCurrentBlock = () => {
        if (currentBlockIndex >= 0) {
          enqueue("content_block_stop", {
            type: "content_block_stop",
            index: currentBlockIndex,
          });
          currentBlockIndex = -1;
          currentBlockType = null;
        }
      };

      try {
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE events are separated by a blank line (\n\n).
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const rawBlock = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);

            for (const line of rawBlock.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (data === "[DONE]" || data === "") continue;

              let chunk: OpenAIResponse & {
                choices?: Array<{
                  delta?: {
                    content?: string | null;
                    tool_calls?: Array<{
                      index: number;
                      id?: string;
                      function?: { name?: string; arguments?: string };
                    }>;
                  };
                  finish_reason?: string | null;
                }>;
                usage?: {
                  prompt_tokens?: number;
                  completion_tokens?: number;
                };
              };
              try {
                chunk = JSON.parse(data);
              } catch {
                continue;
              }

              const choice = chunk.choices?.[0];
              const delta = choice?.delta;

              // --- Text content ---
              if (delta?.content) {
                startMessage();
                if (currentBlockType !== "text") {
                  closeCurrentBlock();
                  currentBlockIndex++;
                  currentBlockType = "text";
                  enqueue("content_block_start", {
                    type: "content_block_start",
                    index: currentBlockIndex,
                    content_block: { type: "text", text: "" },
                  });
                }
                enqueue("content_block_delta", {
                  type: "content_block_delta",
                  index: currentBlockIndex,
                  delta: { type: "text_delta", text: delta.content },
                });
              }

              // --- Tool calls ---
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  startMessage();

                  // A new tool call begins when we see an id or a name
                  // and we're not already in a tool_use block for it.
                  const isNewToolCall =
                    (tc.id || tc.function?.name) &&
                    currentBlockType !== "tool_use";

                  if (isNewToolCall) {
                    closeCurrentBlock();
                    currentBlockIndex++;
                    currentBlockType = "tool_use";
                    enqueue("content_block_start", {
                      type: "content_block_start",
                      index: currentBlockIndex,
                      content_block: {
                        type: "tool_use",
                        id: tc.id || `call_${currentBlockIndex}`,
                        name: tc.function?.name || "",
                        input: {},
                      },
                    });
                  }

                  // Argument fragment
                  const args = tc.function?.arguments;
                  if (args) {
                    enqueue("content_block_delta", {
                      type: "content_block_delta",
                      index: currentBlockIndex,
                      delta: {
                        type: "input_json_delta",
                        partial_json: args,
                      },
                    });
                  }
                }
              }

              // --- Finish reason ---
              if (choice?.finish_reason) {
                stopReason = mapStopReason(choice.finish_reason);
              }

              // --- Usage (typically in the final chunk) ---
              if (chunk.usage) {
                inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
                outputTokens = chunk.usage.completion_tokens ?? outputTokens;
              }
            }
          }
        }

        // --- Finalize ---
        // Ensure message_start was sent (edge case: empty upstream response).
        startMessage();
        closeCurrentBlock();

        enqueue("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });
        enqueue("message_stop", { type: "message_stop" });
      } catch (err) {
        enqueue("error", {
          type: "error",
          error: {
            type: "api_error",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

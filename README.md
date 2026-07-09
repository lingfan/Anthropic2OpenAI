# anthropic-proxy

A lightweight proxy that exposes an **Anthropic-compatible** `/v1/messages` endpoint and translates requests/responses to/from an **OpenAI-compatible** `/v1/chat/completions` backend (e.g. LM Studio at `127.0.0.1:1234`).

Built with **Bun + TypeScript**. Supports both regular and streaming responses.

```
Client (Anthropic SDK)
  │  POST /v1/messages  (Anthropic format)
  ▼
┌──────────────────┐
│  anthropic-proxy │  ← Bun server (this project)
└──────────────────┘
  │  POST /v1/chat/completions  (OpenAI format)
  ▼
OpenAI-compatible backend (127.0.0.1:1234)
```

## Quick start

```bash
# Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash

# Install dependencies
cd anthropic-proxy
bun install

# Start the proxy (default port 7878)
bun start

# Or with watch mode for development
bun dev
```

## Configuration

Copy `.env.example` to `.env` and edit as needed. Bun loads `.env` automatically on startup (no extra package required). Shell env vars still override `.env`.

| Variable       | Default                       | Description                                              |
| -------------- | ----------------------------- | -------------------------------------------------------- |
| `PORT`         | `7878`                        | Port the proxy listens on                                |
| `TARGET_URL`   | `http://127.0.0.1:1234`       | Base URL of the OpenAI-compatible backend               |
| `TARGET_MODEL` | _(uses client's model)_       | Override the model name sent to the backend             |
| `DEBUG`        | `false`                       | Set to `true` to log converted requests/responses       |

```bash
cp .env.example .env
# edit .env, then:
bun start
```

Or override one-off without editing the file:

```bash
PORT=8080 TARGET_MODEL=llama-3.1-8b bun start
```

## Usage

### With curl (non-streaming)

```bash
curl http://localhost:7878/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: anything" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 256,
    "messages": [
      {"role": "user", "content": "Say hello in three languages."}
    ]
  }'
```

### With curl (streaming)

```bash
curl http://localhost:7878/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 256,
    "stream": true,
    "messages": [
      {"role": "user", "content": "Count from 1 to 5."}
    ]
  }'
```

### With the Anthropic Python SDK

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:7878",
    api_key="anything",  # the proxy doesn't validate keys
)

response = client.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.content[0].text)
```

### With the Anthropic TypeScript SDK

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://localhost:7878",
  apiKey: "anything",
});

const response = await client.messages.create({
  model: "claude-3-5-sonnet-20241022",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(response.content[0].text);
```

## What's supported

| Feature                     | Status |
| --------------------------- | ------ |
| Text messages               | ✅     |
| System prompt               | ✅     |
| Multi-turn conversations    | ✅     |
| Streaming (SSE)             | ✅     |
| Image input (base64)        | ✅     |
| Tool use / function calling | ✅     |
| Tool results                | ✅     |
| `temperature`, `top_p`      | ✅     |
| `stop_sequences`            | ✅     |
| `tool_choice`               | ✅     |
| Token usage reporting       | ✅     |

## Conversion mapping

### Stop reasons

| OpenAI `finish_reason` | Anthropic `stop_reason` |
| ---------------------- | ----------------------- |
| `stop`                 | `end_turn`              |
| `length`               | `max_tokens`            |
| `tool_calls`           | `tool_use`              |
| `content_filter`       | `end_turn`              |

### Tool choice

| Anthropic `tool_choice.type` | OpenAI `tool_choice` |
| ---------------------------- | -------------------- |
| `auto`                       | `"auto"`             |
| `any`                        | `"required"`         |
| `tool` (with `name`)         | `{type:"function",function:{name}}` |

## Project structure

```
anthropic-proxy/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts      # Bun HTTP server + route handling
    ├── convert.ts    # Request / response / stream conversion logic
    └── types.ts      # TypeScript type definitions
```

## Notes

- Bun's default `idleTimeout` is 10 seconds. This proxy sets `idleTimeout: 0` (and `server.timeout(req, 0)` on `/v1/messages`) so long LLM generations and quiet SSE gaps are not aborted.
- The proxy does not validate API keys — it's designed for local use. The `x-api-key` header is forwarded to the upstream as `Authorization: Bearer <key>` if present.
- In streaming mode, `input_tokens` in the `message_start` event is reported as `0` because the upstream doesn't provide token counts until the stream ends. The `output_tokens` in `message_delta` is accurate when the upstream supports `stream_options.include_usage`.
- `top_k` is accepted but not forwarded (OpenAI API doesn't support it).

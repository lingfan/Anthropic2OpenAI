# anthropic-proxy

用 **Bun + TypeScript** 实现的轻量代理：对外暴露 Anthropic 兼容的 `POST /v1/messages`，对内转成 OpenAI 的 `/v1/chat/completions` 转发到本地 `llama-server`（默认 `127.0.0.1:1234`），并把响应（含流式 SSE）转回 Anthropic 格式。

```
Claude Code / Anthropic SDK
  │  POST /v1/messages  (Anthropic)
  ▼
┌──────────────────┐
│  anthropic-proxy │  ← 本仓库  http://127.0.0.1:7878
└──────────────────┘
  │  POST /v1/chat/completions  (OpenAI)
  ▼
llama-server  http://127.0.0.1:1234
```

## 本地目录

| 用途 | 路径 |
| ---- | ---- |
| 本代理项目 | `G:\anthropic-proxy` |
| llama-server 可执行文件 | `E:\llama\b9935\llama-server.exe` |
| 模型 GGUF | `F:\lm_models\deepreinforce-ai\ornith-1.0-9b\Q8_0.gguf` |
| Claude Code 工作目录（示例） | `G:\project\node\musicgame0706` |

> 路径按本机实际位置调整即可；模型别名需与 Claude Code 里配置的 `ANTHROPIC_MODEL` 一致。

## 一键联调流程

按顺序开三个终端。

### 1. 启动 llama-server 9935 (f2d1c2f39)（上游，端口 1234）

```powershell
E:\llama\b9935\llama-server.exe `
  -m "F:\lm_models\deepreinforce-ai\ornith-1.0-9b\Q8_0.gguf" `
  --alias "ornith-1.0-9b" `
  --jinja `
  -ngl 99 `
  -c 131072 `
  -b 2048 `
  -ub 1024 `
  -fa on `
  --reasoning-preserve `
  --no-context-shift `
  --parallel 1 `
  --temp 0.6 `
  --top-k 20 `
  --top-p 0.95 `
  --repeat-penalty 1.05 `
  --reasoning-format deepseek `
  --host 0.0.0.0 `
  --port 1234 `
  -lv 4
```

启动成功后，上游 OpenAI 兼容接口为：

`http://127.0.0.1:1234/v1/chat/completions`

模型名（alias）：`ornith-1.0-9b`

### 2. 启动本代理（端口 7878）

```powershell
cd G:\anthropic-proxy
bun install
bun start
# 开发热重载：bun dev
```

默认读取项目根目录 `.env`（Bun 自动加载）。健康检查：

```powershell
curl http://127.0.0.1:7878/health
```

### 3. 配置 Claude Code 指向代理

在要跑 2.1.205 (Claude Code) 的目录（示例：`G:\project\node\musicgame0706`）设置环境变量后启动：

```powershell
cd G:\project\node\musicgame0706

$env:ANTHROPIC_BASE_URL="http://127.0.0.1:7878"
$env:ANTHROPIC_AUTH_TOKEN="test"
$env:ANTHROPIC_MODEL="ornith-1.0-9b"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL="ornith-1.0-9b"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL="ornith-1.0-9b"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL="ornith-1.0-9b"
$env:CLAUDE_CODE_SUBAGENT_MODEL="ornith-1.0-9b"
$env:CLAUDE_CODE_EFFORT_LEVEL="max"

claude
```

说明：

- `ANTHROPIC_BASE_URL` 必须指向本代理，不要直接指 `1234`（Claude Code 发的是 Anthropic 格式）。
- `ANTHROPIC_AUTH_TOKEN` 本地可随意填；代理不校验，有 `x-api-key` 时会转成上游 `Authorization: Bearer ...`。
- 各 `*_MODEL` 建议都写成 llama-server 的 `--alias`（此处为 `ornith-1.0-9b`），避免 Claude Code 仍请求官方模型名。

## 配置（`.env`）

复制示例并按需修改：

```powershell
cd G:\anthropic-proxy
copy .env.example .env
```

| 变量 | 默认值 | 说明 |
| ---- | ------ | ---- |
| `PORT` | `7878` | 代理监听端口 |
| `TARGET_URL` | `http://127.0.0.1:1234` | 上游 OpenAI 兼容服务根地址（不要带 `/v1/...`） |
| `TARGET_MODEL` | 空 | 非空时强制覆盖发给上游的 model；为空则用客户端传入的 model |
| `DEBUG` | `false` | `true` 时打印转换后的请求/响应 |

当前推荐本地 `.env`：

```env
PORT=7878
TARGET_URL=http://127.0.0.1:1234
TARGET_MODEL=
DEBUG=false
```

临时覆盖（不改文件）：

```powershell
$env:DEBUG="true"; bun start
```

## 其它调用方式

### curl（非流式）

```powershell
curl http://127.0.0.1:7878/v1/messages `
  -H "Content-Type: application/json" `
  -H "x-api-key: test" `
  -H "anthropic-version: 2023-06-01" `
  -d '{
    "model": "ornith-1.0-9b",
    "max_tokens": 256,
    "messages": [
      {"role": "user", "content": "用三句话介绍你自己。"}
    ]
  }'
```

### curl（流式）

```powershell
curl http://127.0.0.1:7878/v1/messages `
  -H "Content-Type: application/json" `
  -d '{
    "model": "ornith-1.0-9b",
    "max_tokens": 256,
    "stream": true,
    "messages": [
      {"role": "user", "content": "从 1 数到 5。"}
    ]
  }'
```

### Anthropic Python SDK

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://127.0.0.1:7878",
    api_key="test",
)

response = client.messages.create(
    model="ornith-1.0-9b",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.content[0].text)
```

### Anthropic TypeScript SDK

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "http://127.0.0.1:7878",
  apiKey: "test",
});

const response = await client.messages.create({
  model: "ornith-1.0-9b",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(response.content[0].text);
```

## 功能支持

| 功能 | 状态 |
| ---- | ---- |
| 文本消息 | ✅ |
| System prompt | ✅ |
| 多轮对话 | ✅ |
| 流式 SSE | ✅ |
| 图片输入（base64） | ✅ |
| Tool use / function calling | ✅ |
| Tool results | ✅ |
| `temperature` / `top_p` | ✅ |
| `stop_sequences` | ✅ |
| `tool_choice` | ✅ |
| Token usage | ✅ |

## 转换对照

### stop_reason

| OpenAI `finish_reason` | Anthropic `stop_reason` |
| ---------------------- | ----------------------- |
| `stop` | `end_turn` |
| `length` | `max_tokens` |
| `tool_calls` | `tool_use` |
| `content_filter` | `end_turn` |

### tool_choice

| Anthropic | OpenAI |
| --------- | ------ |
| `auto` | `"auto"` |
| `any` | `"required"` |
| `tool` + `name` | `{ type: "function", function: { name } }` |

## 项目结构

```
G:\anthropic-proxy\
├── .env / .env.example
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── index.ts      # Bun HTTP 服务与路由
    ├── convert.ts    # Anthropic ↔ OpenAI 转换（含流式）
    └── types.ts      # 类型定义
```

## 常见问题

**请求约 10 秒后断开：`request timed out after 10 seconds`**  
Bun 默认 `idleTimeout` 为 10 秒。本代理已设置 `idleTimeout: 0`，并在 `/v1/messages` 上调用 `server.timeout(req, 0)`。若仍超时，确认已重启到最新代码。

**Claude Code 连不上 / 模型名不对**  
确认三件事：llama-server 已监听 `1234`、代理已监听 `7878`、`ANTHROPIC_MODEL` 与 `--alias` 一致（`ornith-1.0-9b`）。

**代理不校验 API Key**  
仅适合本机/内网。`x-api-key` 若存在会转成上游 Bearer token。

**流式 usage**  
`message_start` 里 `input_tokens` 可能为 `0`（上游往往到流结束才给 usage）；`message_delta` 的 `output_tokens` 在上游支持 `stream_options.include_usage` 时较准。

**`top_k`**  
Anthropic 请求里可带，但 OpenAI 协议不转发该字段（采样参数以 llama-server 启动参数为准）。

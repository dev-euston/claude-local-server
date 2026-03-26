# claude-local-server

An OpenAI-compatible HTTP API that proxies requests to Claude. Use any OpenAI client library with Claude models by pointing it at this server.

## How it works

OpenAI-format requests arrive at the server, get translated to Claude's format, sent to the configured backend, and the response is translated back to OpenAI format. Two backends are supported:

- **api** — uses the Anthropic SDK directly (requires an API key)
- **cli** — spawns the local `claude` CLI tool (requires `claude` installed and authenticated; works in any terminal, not just inside Claude Code)

## Setup

```bash
npm install
cp config.json.example config.json
# edit config.json
npm run build
npm start
```

## Configuration

`config.json` controls which backend is used and how it connects:

API backend:
```json
{
  "backend": "api",
  "host": "127.0.0.1",
  "port": 3000,
  "api": {
    "apiKey": "sk-ant-...",
    "model": "claude-opus-4-6"
  }
}
```

CLI backend (uses your local `claude` installation and its default model):
```json
{
  "backend": "cli"
}
```

With bearer token authentication (recommended when exposing the server over a network):
```json
{
  "backend": "cli",
  "apiKey": "your-secret-here"
}
```

Generate a token: `openssl rand -base64 32`

| Field | Default | Description |
|---|---|---|
| `backend` | required | `"api"` or `"cli"` |
| `host` | `"127.0.0.1"` | Bind address |
| `port` | `3000` | Listen port |
| `apiKey` | — | When set, all requests must include `Authorization: Bearer <apiKey>`. Omit to disable auth (local use only). |
| `api.apiKey` | required for api | Anthropic API key |
| `api.model` | required for api | Model ID |
| `cli.model` | Claude's default | Model ID (omit to use whatever `claude` defaults to) |
| `cli.claudePath` | `"claude"` | Path to the `claude` binary |

Use `--config <path>` to load a config file from a non-default location.

## API

The server implements the OpenAI chat completions API:

### `GET /v1/models`

Returns the configured model in OpenAI's model list format.

### `POST /v1/chat/completions`

Accepts standard OpenAI chat completion requests, including streaming via `"stream": true`.

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-here" \
  -d '{
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

Supported request fields: `messages`, `model`, `stream`, `max_tokens`, `temperature`, `tools`, `stream_actions`.

#### Sessions (CLI backend only)

The CLI backend supports persistent sessions. The server manages session IDs — clients do not generate them.

| Condition | Behavior |
|---|---|
| No `X-Session-ID` header | Server generates a new UUID session ID; returned in `X-Session-ID` response header |
| Header present, session exists | Session resumed with `--resume`; only the last user message is sent |
| Header present, session not found | HTTP 404 returned |
| Resume fails | HTTP 500 returned; stale entry kept; omit the header to start a new session |

Sessions are stored in memory and lost on server restart.

**Starting a session** (omit the header; read the ID from the response):

```bash
SESSION_ID=$(curl -si http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello!"}]}' \
  | grep -i '^x-session-id:' | awk '{print $2}' | tr -d '\r')
```

**Resuming a session**:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Session-ID: $SESSION_ID" \
  -d '{"messages": [{"role": "user", "content": "Hello!"}, {"role": "assistant", "content": "Hi!"}, {"role": "user", "content": "How are you?"}]}'
```

#### Tool definitions

Pass tools in OpenAI format:

```json
{
  "messages": [{"role": "user", "content": "What files are here?"}],
  "stream": true,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "bash",
        "description": "Run a shell command",
        "parameters": {
          "type": "object",
          "properties": { "command": { "type": "string" } },
          "required": ["command"]
        }
      }
    }
  ]
}
```

Tools are forwarded to the backend (Anthropic API or CLI). The server does not execute tools on behalf of the client.

#### Action streaming (`stream_actions`)

When `stream: true`, adding `stream_actions: true` interleaves tool call and tool result events in the SSE stream.

```json
{ "stream": true, "stream_actions": true, "tools": [...] }
```

Tool call events use standard OpenAI chunk format:

```
data: {"object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xyz","type":"function","function":{"name":"bash","arguments":""}}]}}]}

data: {"object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":\"ls\"}"}}]}}]}
```

Tool result events use a named SSE event (CLI backend only — the API backend never yields tool results):

```
event: tool_result
data: {"tool_call_id":"call_xyz","content":"file1.txt\nfile2.txt"}
```

`stream_actions: true` requires `stream: true` — combining with `stream: false` returns HTTP 400.

## Development

```bash
npm run test            # run all tests
npm run test:coverage   # run with coverage (enforced at 100%)
npm run test:watch      # watch mode
npm run lint            # check lint
npm run lint:fix        # auto-fix lint
```

# API Reference

This document describes the HTTP API exposed by `claude-local-server`. The API is a subset of the OpenAI Chat Completions API, so any OpenAI-compatible client can be pointed at this server with minimal or no changes.

**Default base URL:** `http://127.0.0.1:3000`

---

## Endpoints

### `GET /v1/models`

Returns the list of available models (always exactly one — whichever model is configured).

**Response**

```json
{
  "object": "list",
  "data": [
    {
      "id": "claude-opus-4-6",
      "object": "model",
      "created": 1741000000,
      "owned_by": "anthropic"
    }
  ]
}
```

No request body or query parameters. Requires `Authorization: Bearer <apiKey>` if `apiKey` is set in the server config.

---

### `POST /v1/chat/completions`

Submit a conversation and get a response. Supports both blocking and streaming modes.

**Request headers**

| Header | Required | Description |
|---|---|---|
| `Content-Type` | Yes | Must be `application/json` |
| `Authorization` | When `apiKey` is configured | `Bearer <apiKey>`. Returns 401 if missing or incorrect. |
| `X-Session-ID` | No | Resume an existing session (CLI backend only — see [Sessions](#sessions)). Omit to start a new session. |

**Request body**

```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user",   "content": "Hello!" }
  ],
  "model": "claude-opus-4-6",
  "stream": false,
  "stream_actions": false,
  "max_tokens": 1024,
  "temperature": 1.0,
  "tools": []
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `messages` | array | Yes | Conversation history. Supported roles: `system`, `user`, `assistant`. The first `system` message is extracted as the system prompt; additional system messages are silently dropped. Roles other than these three return HTTP 400. |
| `model` | string | No | Ignored — the server uses the model from its config. |
| `stream` | boolean | No | `false` (default) returns a single JSON object. `true` returns an SSE stream. |
| `stream_actions` | boolean | No | When `true` (requires `stream: true`), tool call and tool result events are included in the SSE stream. Combining with `stream: false` returns HTTP 400. |
| `max_tokens` | number | No | Maximum tokens in the response. Forwarded to the backend. |
| `temperature` | number | No | Sampling temperature. Forwarded to the backend. |
| `tools` | array | No | Tool definitions in OpenAI function format (see [Tools](#tools)). |

---

## Response formats

### Non-streaming (`stream: false`)

A single JSON object:

```json
{
  "id": "msg_01XFDUDYJgAACzvnptvVoYEL",
  "object": "chat.completion",
  "created": 1741000000,
  "model": "claude-opus-4-6",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?"
      },
      "finish_reason": "stop",
      "logprobs": null
    }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 9,
    "total_tokens": 21
  }
}
```

### Streaming (`stream: true`)

Server-Sent Events stream. Each line is prefixed with `data: `. The stream ends with `data: [DONE]`.

**Text delta chunk:**

```
data: {"id":"msg_01XF","object":"chat.completion.chunk","created":1741000000,"model":"claude-opus-4-6","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null,"logprobs":null}]}
```

**Terminal chunk** (signals end of response content; `delta` is empty, `finish_reason` is `"stop"`):

```
data: {"id":"msg_01XF","object":"chat.completion.chunk","created":1741000000,"model":"claude-opus-4-6","choices":[{"index":0,"delta":{},"finish_reason":"stop","logprobs":null}]}
```

**End of stream:**

```
data: [DONE]
```

**Error during stream** (instead of `[DONE]`):

```
data: {"error":{"message":"Something went wrong","type":"server_error","code":null}}
```

---

## Tools

Pass tool definitions in standard OpenAI function format:

```json
{
  "messages": [{"role": "user", "content": "What files are in the current directory?"}],
  "stream": true,
  "stream_actions": true,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "bash",
        "description": "Run a shell command and return its output",
        "parameters": {
          "type": "object",
          "properties": {
            "command": { "type": "string", "description": "The command to run" }
          },
          "required": ["command"]
        }
      }
    }
  ]
}
```

Tools are forwarded to the backend. The server does not execute tools — it is the client's responsibility to execute tool calls and send results back as assistant/user messages.

### Tool call events (`stream_actions: true`)

When `stream_actions: true`, the SSE stream includes tool call chunks interleaved with text chunks.

**Tool call start** — emitted once per tool invocation, carries the function name:

```
data: {"id":"msg_01XF","object":"chat.completion.chunk","created":1741000000,"model":"claude-opus-4-6","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"toolu_01A","type":"function","function":{"name":"bash","arguments":""}}]},"finish_reason":null,"logprobs":null}]}
```

**Tool call delta** — one or more chunks carrying the JSON-encoded arguments incrementally:

```
data: {"id":"msg_01XF","object":"chat.completion.chunk","created":1741000000,"model":"claude-opus-4-6","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":"}}]},"finish_reason":null,"logprobs":null}]}

data: {"id":"msg_01XF","object":"chat.completion.chunk","created":1741000000,"model":"claude-opus-4-6","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ls\"}"}}]},"finish_reason":null,"logprobs":null}]}
```

**Tool result** — emitted after each tool execution (CLI backend only; uses a named SSE event):

```
event: tool_result
data: {"tool_call_id":"toolu_01A","content":"file1.txt\nfile2.txt\nREADME.md"}
```

> **Note:** Tool result events are only emitted by the CLI backend. The API backend never yields them.

---

## Sessions

The CLI backend supports persistent sessions. Without sessions, the server serializes the entire conversation history into a single prompt string on every request. With sessions, it resumes an existing Claude process using `--resume`, sending only the newest user message.

The server manages session IDs. To start a session, omit the `X-Session-ID` header — the server generates a UUID and returns it in the `X-Session-ID` response header. Pass that value back on every subsequent request in the same conversation.

### Behavior

| Condition | Behavior |
|---|---|
| No `X-Session-ID` header | New session — full history sent; server generates a UUID and returns it in `X-Session-ID` response header |
| Header present, session exists | Resume — only the last user message is sent; `--resume <id>` is used; same ID echoed in response header |
| Header present, session not found | HTTP 404 returned |
| Resume fails (non-zero exit or `is_error: true`) | HTTP 500 returned; stale session entry kept; omit the header to start a new session |

**Constraints:**
- Sessions are stored in memory. They are lost on server restart.
- On a resume, the last message in `messages` must have `role: "user"`. Anything else returns HTTP 500.
- The API backend ignores `X-Session-ID` entirely.

### Example flow

**First request (no header — server creates session and returns ID):**

```http
POST /v1/chat/completions
Content-Type: application/json

{
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "What is 2 + 2?"}
  ]
}
```

Response includes:

```
X-Session-ID: 550e8400-e29b-41d4-a716-446655440000
```

**Second request (resumed session — pass back the ID; only last message matters):**

```http
POST /v1/chat/completions
Content-Type: application/json
X-Session-ID: 550e8400-e29b-41d4-a716-446655440000

{
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "What is 2 + 2?"},
    {"role": "assistant", "content": "4."},
    {"role": "user", "content": "And what is that times 3?"}
  ]
}
```

The server uses `--resume` and sends only `"And what is that times 3?"` as the prompt. The full history in `messages` is ignored on resume — it is only there because the client always sends it; the server will only read the last element.

---

## Error responses

All errors use this shape:

```json
{
  "error": {
    "message": "Human-readable description of the problem",
    "type": "invalid_request_error",
    "code": null
  }
}
```

| HTTP status | `type` | When |
|---|---|---|
| 400 | `invalid_request_error` | Bad request body (unsupported role, `stream_actions` without `stream`, schema violation) |
| 401 | — | `apiKey` is configured and the `Authorization` header is missing or incorrect. Body: `{"error":"Unauthorized"}` |
| 404 | `invalid_request_error` | `X-Session-ID` header provided but no matching session found on the server |
| 500 | `server_error` | Backend error, process failure, resume failure |

Streaming errors are delivered as a `data:` event (not an HTTP error status) because headers are already sent:

```
data: {"error":{"message":"...","type":"server_error","code":null}}

```

---

## Adapter implementation guide

### Minimal adapter (non-streaming)

1. Set base URL to `http://127.0.0.1:3000` (or wherever the server is running).
2. POST `/v1/chat/completions` with `Content-Type: application/json`.
3. Include at minimum `{ "messages": [...] }`.
4. Read `choices[0].message.content` from the response.

### Streaming adapter

1. Same as above, add `"stream": true`.
2. Open an SSE connection and read lines prefixed with `data: `.
3. Skip `data: [DONE]`.
4. Parse each `data:` line as JSON.
5. If `choices[0].finish_reason` is `"stop"`, the response is complete.
6. Otherwise accumulate `choices[0].delta.content`.
7. If the parsed object has an `error` key, surface it as an error.

### Session-aware adapter

1. On the first request of a conversation, omit `X-Session-ID`.
2. Read the `X-Session-ID` header from the response — this is the server-assigned session ID.
3. Include `X-Session-ID: <id>` on every subsequent request in that conversation.
4. Always send the complete message history in `messages` (the server handles which part to use on resume).
5. If you receive HTTP 404, the session is not known to the server (e.g. after a restart). Omit the header to start a new session.
6. If you receive HTTP 500 with a message about a failed resume, omit the header to start a new session.

### Tool-using adapter

1. Include `"stream": true, "stream_actions": true, "tools": [...]`.
2. Collect tool call start + delta chunks to reconstruct `{ name, arguments }` per tool call (keyed by `tool_calls[].index`).
3. When a `event: tool_result` SSE line arrives, parse its `data:` as `{ tool_call_id, content }`.
4. Execute the tool locally and append the result to `messages` as needed by your orchestration logic.
5. Continue the conversation loop until `finish_reason: "stop"` with no pending tool calls.

### Using the OpenAI SDK directly

Any OpenAI SDK can be used as-is by pointing it at this server:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3000/v1",
    api_key="your-secret-here",  # must match apiKey in config.json; use any string if auth is disabled
)

response = client.chat.completions.create(
    model="claude-opus-4-6",  # value is ignored; server uses its config
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:3000/v1',
  apiKey: 'your-secret-here', // must match apiKey in config.json; use any string if auth is disabled
});

const response = await client.chat.completions.create({
  model: 'claude-opus-4-6',
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(response.choices[0].message.content);
```

Sessions with the SDK — start a session and persist the returned ID:

```typescript
// First request: no X-Session-ID; server creates one
const first = await client.chat.completions.create(
  { model: 'claude-opus-4-6', messages },
  { headers: {} },
);
// @ts-ignore — rawResponse is available on the underlying fetch response
const sessionId = first.response.headers.get('x-session-id');

// Subsequent requests: pass the session ID back
const second = await client.chat.completions.create(
  { model: 'claude-opus-4-6', messages: [...messages, ...newMessages] },
  { headers: { 'X-Session-ID': sessionId } },
);
```

---

## Known limitations

- **Authentication is optional.** When `apiKey` is not set in `config.json`, the server has no access control. Bind to `127.0.0.1` (the default) and do not expose it to the network without setting an `apiKey`.
- **Single model.** The `model` field in requests is ignored. The configured model is always used.
- **Sessions are in-memory.** Lost on server restart. No cross-process sharing.
- **Tool results from API backend.** The API backend never emits `tool_result` events — only the CLI backend does.
- **`logprobs` is always `null`.** Not supported by either backend.
- **Multiple system messages.** Only the first `system` message is used; the rest are silently dropped.

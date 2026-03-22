# Claude Local Server — Design Spec

**Date:** 2026-03-22
**Status:** Approved

## Overview

A local HTTP server written in TypeScript (Node.js/Fastify) that exposes an OpenAI-compatible API. It acts as a proxy layer between any OpenAI SDK client and Anthropic's AI capabilities, supporting two interchangeable backend drivers: the Anthropic SDK (direct API calls) and the `claude -p` CLI (local subprocess). The active backend is selected at startup via a config file.

This lets downstream applications integrate with a single, stable OpenAI-shaped interface without containing any Anthropic-specific logic.

## Architecture

```
Client (any OpenAI SDK)
        │
        ▼
  Fastify Server  (127.0.0.1:3000)
  ┌─────────────────────────────────┐
  │  POST /v1/chat/completions      │
  │  GET  /v1/models                │
  └────────────┬────────────────────┘
               │
         Transform Layer
      (OpenAI ↔ Anthropic format)
               │
       ┌───────┴────────┐
       │                │
  API Backend      CLI Backend
  (@anthropic-      (spawn
   ai/sdk)          claude -p)
```

- **Binding:** `127.0.0.1` only (no auth required; network trust enforced by binding)
- **Protocol:** HTTP/1.1; streaming via Server-Sent Events (SSE)
- **Backend selection:** config file at startup (`"backend": "api"` or `"backend": "cli"`); restart to switch

## Component Structure

```
src/
  index.ts          — Entry point: parse --config flag, load config, start server
  server.ts         — Fastify app factory, plugin/route registration
  config.ts         — Load + validate config.json via zod schema
  transform.ts      — OpenAI ↔ Anthropic message/response conversion
  backends/
    types.ts        — NormalizedRequest, NormalizedResponse, NormalizedChunk, BackendDriver interface
    api.ts          — Anthropic SDK driver
    cli.ts          — claude -p spawn driver
  routes/
    chat.ts         — POST /v1/chat/completions
    models.ts       — GET /v1/models
```

## Configuration

Config file loaded from `./config.json` by default, or from the path given by `--config <path>` (parsed via `process.argv` directly — no extra library needed for a single flag). Validated at startup with zod. Invalid config causes `process.exit(1)` with a descriptive message.

```json
{
  "backend": "api",
  "host": "127.0.0.1",
  "port": 3000,
  "api": {
    "apiKey": "sk-ant-...",
    "model": "claude-opus-4-6"
  },
  "cli": {
    "model": "claude-opus-4-6",
    "claudePath": "claude"
  }
}
```

**Conditional zod validation:** When `backend` is `"api"`, the `api` block (with `apiKey` and `model`) is required. When `backend` is `"cli"`, the `cli` block (with `model`) is required. The other block is optional (and ignored). `claudePath` defaults to `"claude"` if omitted.

## Shared Type Contracts (`backends/types.ts`)

All data flowing between routes, transform, and backends uses these types:

```typescript
// Supported OpenAI message roles: system, user, assistant
// tool/function roles are out of scope for this version
interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface NormalizedRequest {
  messages: NormalizedMessage[];
  model: string;       // forwarded for logging; backends use configured model
  maxTokens?: number;  // maps to max_tokens
  temperature?: number;
  // top_p is explicitly excluded — not needed and adds test surface for no benefit
}

interface NormalizedResponse {
  id: string;           // unique completion id, e.g. "chatcmpl-..."
  model: string;        // model name from config
  content: string;      // full assistant message text
  promptTokens: number;
  completionTokens: number;
}

// One chunk emitted per streaming token delta
interface NormalizedChunk {
  id: string;           // same id across all chunks for a single completion
  delta: string;        // text fragment (may be empty string for first/last chunks)
  finishReason: string | null;  // null until final chunk; "stop" on last chunk
}

interface BackendDriver {
  complete(request: NormalizedRequest): Promise<NormalizedResponse>;
  stream(request: NormalizedRequest): AsyncIterable<NormalizedChunk>;
}
```

## Backend Driver Interface

Both backends implement `BackendDriver`. Routes interact only with `BackendDriver`.

### API Backend (`backends/api.ts`)
- Uses `@anthropic-ai/sdk`
- `complete()`: calls `client.messages.create()` with `stream: false`
- `stream()`: calls `client.messages.create()` with `stream: true`, yields `NormalizedChunk` per `content_block_delta` event; emits final chunk with `finishReason: "stop"` on `message_stop`

### CLI Backend (`backends/cli.ts`)
- Spawns `claude -p --output-format stream-json` for **both** streaming and non-streaming calls
  - `complete()` accumulates all delta chunks from stdout and assembles a single `NormalizedResponse` when the process exits cleanly
  - `stream()` yields each delta as a `NormalizedChunk` as it arrives
- **CLI stdout event mapping** (`stream-json` format):

| `claude -p` event type | Action |
|---|---|
| `content_block_delta` (type: `text_delta`) | Extract `.delta.text` → `NormalizedChunk.delta` |
| `message_stop` | Emit final chunk with `finishReason: "stop"`, close iterable |
| `message_start`, `content_block_start`, `content_block_stop`, `ping` | Ignore |
| Any other / malformed line | Log to stderr, skip |

- stderr from the subprocess is captured separately
- Non-zero exit code → throw error with captured stderr as the message

## Data Flow

### Non-Streaming

1. Client: `POST /v1/chat/completions` with `"stream": false`
2. Route validates request shape via Fastify JSON schema
3. `transform.ts` converts OpenAI `messages[]` → `NormalizedRequest`
   - Extracts any `role: "system"` message as the system prompt (first one wins; Anthropic requires it separate)
   - Remaining messages mapped to `NormalizedMessage[]`
4. Active backend driver: `driver.complete(normalizedRequest)` → `NormalizedResponse`
5. `transform.ts` converts `NormalizedResponse` → OpenAI `ChatCompletion` JSON shape → returned as response

### Streaming

1. Client: `POST /v1/chat/completions` with `"stream": true`
2. Route sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`; disables Fastify response buffering
3. `transform.ts` converts request to `NormalizedRequest` (same as above)
4. Backend driver returns `AsyncIterable<NormalizedChunk>` via `driver.stream()`
5. Route maps each chunk to OpenAI `ChatCompletionChunk` SSE format:
   ```
   data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"delta":{"content":"..."},"finish_reason":null,"index":0}]}\n\n
   ```
6. Final chunk has `"finish_reason": "stop"` and empty `delta.content`
7. Route sends `data: [DONE]\n\n` to close the stream

## Error Handling

| Scenario | Behaviour |
|---|---|
| Invalid config at startup | `process.exit(1)` with descriptive message |
| Malformed request | HTTP 400, OpenAI error shape |
| Unsupported message role | HTTP 400, descriptive error message |
| Backend error (non-streaming) | HTTP 500, OpenAI error shape |
| Backend error mid-stream | SSE error event (see format below), stream closed |
| CLI non-zero exit | Stderr content captured, included in HTTP 500 message |

**OpenAI error shape:**
```json
{ "error": { "message": "...", "type": "invalid_request_error", "code": null } }
```

**Mid-stream SSE error event:**
```
data: {"error":{"message":"...","type":"server_error","code":null}}\n\n
```
Stream is then closed (no `[DONE]` sent on error).

## API Endpoints

### `GET /v1/models`

Returns only the active backend's configured model as a single-item list. The inactive backend's model is not exposed.

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

`created` is a static Unix timestamp (hardcoded at server build time, not dynamic).

### `POST /v1/chat/completions`

Accepts OpenAI `ChatCompletionCreateParams`. Supported fields:

| Field | Behaviour |
|---|---|
| `model` | Accepted but ignored; server uses configured model |
| `messages` | Required; roles `system`, `user`, `assistant` only |
| `stream` | Boolean, defaults to `false` |
| `max_tokens` | Forwarded as `maxTokens` |
| `temperature` | Forwarded |

Unsupported fields (e.g. `tools`, `top_p`, `logprobs`) are silently ignored.

## Testing Strategy

**Framework:** `vitest` + Fastify `app.inject()` (no real HTTP port needed for route tests)
**Coverage:** `vitest --coverage` with `@vitest/coverage-v8`; fail build below 100% (unavoidable lines annotated)

| Layer | Strategy |
|---|---|
| `config.ts` | Unit: valid configs, missing required blocks, wrong types, unknown backend values, conditional api/cli block validation |
| `transform.ts` | Unit: system message extraction, user/assistant role mapping, missing system message, unsupported role rejection, NormalizedResponse → ChatCompletion shape, NormalizedChunk → ChatCompletionChunk shape |
| `backends/api.ts` | Unit: mock `@anthropic-ai/sdk`; streaming and non-streaming paths, SDK error propagation |
| `backends/cli.ts` | Unit: mock `child_process.spawn` with a simulated `Readable` stdout stream; test each event type mapping, ignored event types, malformed lines, stderr capture, non-zero exit |
| `routes/chat.ts` | Integration via `inject()`; mock `BackendDriver`; streaming and non-streaming; 400 on bad request; 500 on backend error; mid-stream error SSE format |
| `routes/models.ts` | Integration via `inject()`; assert full response shape including all OpenAI `Model` fields |
| `server.ts` | Smoke: app builds successfully; 404 on unknown routes |
| `index.ts` | Config loading path tested via config.ts unit tests; `--config` flag parsing covered by a dedicated unit test that mocks `process.argv` |

**Uncoverable lines** (annotated with `// c8 ignore next`):
- `index.ts` top-level `server.listen()` call (process entry point)
- `process.exit()` calls in config validation error paths

## Tooling

| Tool | Purpose |
|---|---|
| `typescript` (strict mode) | Type safety |
| `eslint` + `@typescript-eslint` + `prettier` | Lint + format |
| `vitest` + `@vitest/coverage-v8` | Tests + coverage |
| `zod` | Config validation |
| `fastify` | HTTP server |
| `@fastify/sensible` | Standardized HTTP error helpers (`reply.badRequest()`, etc.) |
| `@anthropic-ai/sdk` | API backend |

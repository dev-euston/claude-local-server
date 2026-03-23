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

| Field | Default | Description |
|---|---|---|
| `backend` | required | `"api"` or `"cli"` |
| `host` | `"127.0.0.1"` | Bind address |
| `port` | `3000` | Listen port |
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
  -d '{
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

Supported request fields: `messages`, `model`, `stream`, `max_tokens`, `temperature`.

## Development

```bash
npm run test            # run all tests
npm run test:coverage   # run with coverage (enforced at 100%)
npm run test:watch      # watch mode
npm run lint            # check lint
npm run lint:fix        # auto-fix lint
```

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

| Command | Purpose |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run test` | Run all tests once |
| `npm run test -- src/config.test.ts` | Run a single test file |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage (enforces 100%) |
| `npm run lint` | Check lint errors |
| `npm run lint:fix` | Auto-fix lint errors |
| `npm start` | Start the server (requires `config.json`) |

## Architecture

OpenAI-compatible HTTP API (Fastify) that proxies to either the Anthropic SDK or `claude -p` CLI. The active backend is selected at startup from `config.json`.

**Data flow:** OpenAI request → `src/transform.ts` → `NormalizedRequest` → `BackendDriver` → `NormalizedResponse/Chunk` → `src/transform.ts` → OpenAI response shape.

**Key contracts:**
- `src/backends/types.ts` — `NormalizedRequest`, `NormalizedResponse`, `NormalizedChunk`, `BackendDriver` interface. Routes import only this interface, never the backend implementations directly.
- `src/transform.ts` — the only file that knows about both OpenAI and Anthropic shapes. System messages are extracted here into `NormalizedRequest.system`; backends consume that field directly.
- `src/server.ts:buildApp(config, driver?)` — accepts an optional `BackendDriver` override, used by all route integration tests to inject mock drivers.

## Testing

Route tests use Fastify `app.inject()` — no real HTTP port. Backend tests mock `@anthropic-ai/sdk` and `child_process.spawn` respectively. All backend/SDK mocks use `vi.resetModules()` + dynamic `import()` in `beforeEach` to guarantee clean state.

Coverage must remain at 100%. Lines that cannot be covered (process entry point, `process.exit()`) are annotated with `/* c8 ignore next */`. Pure interface files (`src/backends/types.ts`) are excluded from coverage in `vitest.config.ts`.

## Configuration

Copy `config.json.example` → `config.json`. Use `--config <path>` to specify a different location. When `backend` is `"api"`, the `api` block is required. When `backend` is `"cli"`, the `cli` block is required.

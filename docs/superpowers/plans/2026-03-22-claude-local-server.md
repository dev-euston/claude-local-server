# Claude Local Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local OpenAI-compatible HTTP server that proxies requests to either the Anthropic SDK or `claude -p` CLI based on a config file.

**Architecture:** Fastify server with two pluggable backend drivers behind a shared interface. A transform layer converts between OpenAI wire format and Anthropic format. The active backend is selected at startup from `config.json`.

**Tech Stack:** TypeScript (strict), Fastify, `@anthropic-ai/sdk`, zod, vitest + `@vitest/coverage-v8`, ESLint + Prettier.

---

## File Map

| File | Responsibility |
|---|---|
| `src/index.ts` | Entry point: parse `--config` flag (exports `getConfigPath`), load config, start server |
| `src/server.ts` | Fastify app factory, route registration, driver creation |
| `src/config.ts` | Load + zod-validate `config.json`; export `Config` type and `loadConfig()` |
| `src/transform.ts` | Convert OpenAI messages → `NormalizedRequest`; convert `NormalizedResponse/Chunk` → OpenAI shapes |
| `src/backends/types.ts` | `NormalizedRequest` (with `system?`), `NormalizedResponse`, `NormalizedChunk`, `BackendDriver` |
| `src/backends/api.ts` | Anthropic SDK driver |
| `src/backends/cli.ts` | `claude -p` spawn driver |
| `src/routes/models.ts` | `GET /v1/models` handler |
| `src/routes/chat.ts` | `POST /v1/chat/completions` handler |

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `eslint.config.mjs`
- Create: `.prettierrc.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `config.json.example`

- [ ] **Step 1: Initialise the project**

```bash
npm init -y
```

- [ ] **Step 2: Install production dependencies**

```bash
npm install fastify @fastify/sensible @anthropic-ai/sdk zod
```

- [ ] **Step 3: Install dev dependencies**

```bash
npm install --save-dev typescript @types/node vitest @vitest/coverage-v8 eslint typescript-eslint eslint-config-prettier eslint-plugin-prettier prettier
```

- [ ] **Step 4: Write `package.json` scripts**

Replace the `scripts` section in `package.json`:

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint src",
    "lint:fix": "eslint src --fix",
    "format": "prettier --write src"
  },
  "type": "module"
}
```

- [ ] **Step 5: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 6: Write `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
```

- [ ] **Step 7: Write `eslint.config.mjs`**

```javascript
import tseslint from 'typescript-eslint';
import prettierPlugin from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    plugins: { prettier: prettierPlugin },
    rules: { 'prettier/prettier': 'error' },
  },
  { ignores: ['dist/**', 'coverage/**', 'vitest.config.ts', 'eslint.config.mjs'] },
);
```

- [ ] **Step 8: Write `.prettierrc.json`**

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

- [ ] **Step 9: Write `.gitignore`**

```
node_modules/
dist/
coverage/
config.json
*.js.map
```

- [ ] **Step 10: Write `config.json.example`**

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

- [ ] **Step 11: Create `src/` and verify the setup compiles**

```bash
mkdir src && echo "export {};" > src/index.ts && npm run build
```

Expected: `dist/index.js` created with no errors.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json tsconfig.json eslint.config.mjs .prettierrc.json vitest.config.ts .gitignore config.json.example src/index.ts
git commit -m "chore: project scaffold"
```

---

## Task 2: Shared Types

**Files:**
- Create: `src/backends/types.ts`

No runtime logic — TypeScript interfaces only. No tests needed.

`NormalizedRequest` carries an optional `system` field so the transform layer can extract it once; backends consume it directly rather than re-scanning `messages[]`.

- [ ] **Step 1: Write `src/backends/types.ts`**

```typescript
export interface NormalizedMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface NormalizedRequest {
  messages: NormalizedMessage[]; // user/assistant only — no system role
  system?: string;               // extracted system prompt
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export interface NormalizedResponse {
  id: string;
  model: string;
  content: string;
  promptTokens: number;
  completionTokens: number;
}

// One chunk per token delta emitted during streaming
export interface NormalizedChunk {
  id: string;
  delta: string;            // text fragment; empty string on final chunk
  finishReason: string | null; // null until final; "stop" on last chunk
}

export interface BackendDriver {
  complete(request: NormalizedRequest): Promise<NormalizedResponse>;
  stream(request: NormalizedRequest): AsyncIterable<NormalizedChunk>;
}
```

- [ ] **Step 2: Confirm TypeScript accepts the file**

```bash
npm run build
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/backends/types.ts
git commit -m "feat: shared backend types"
```

---

## Task 3: Config Module

**Files:**
- Create: `src/config.ts`
- Create: `src/config.test.ts`

`getConfigPath` lives in `src/index.ts` (Task 10), not here. This module is purely config loading and validation.

- [ ] **Step 1: Write failing tests in `src/config.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from './config.js';

function writeTmp(content: object): string {
  const p = join(tmpdir(), `config-test-${Date.now()}.json`);
  writeFileSync(p, JSON.stringify(content));
  return p;
}

describe('loadConfig — api backend', () => {
  it('loads a valid api config', () => {
    const p = writeTmp({
      backend: 'api',
      api: { apiKey: 'sk-ant-test', model: 'claude-opus-4-6' },
    });
    const cfg = loadConfig(p);
    expect(cfg.backend).toBe('api');
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(3000);
    rmSync(p);
  });

  it('throws when api block is missing for api backend', () => {
    const p = writeTmp({ backend: 'api' });
    expect(() => loadConfig(p)).toThrow();
    rmSync(p);
  });

  it('throws when apiKey is empty string', () => {
    const p = writeTmp({ backend: 'api', api: { apiKey: '', model: 'claude-opus-4-6' } });
    expect(() => loadConfig(p)).toThrow();
    rmSync(p);
  });
});

describe('loadConfig — cli backend', () => {
  it('loads a valid cli config', () => {
    const p = writeTmp({
      backend: 'cli',
      cli: { model: 'claude-opus-4-6' },
    });
    const cfg = loadConfig(p);
    expect(cfg.backend).toBe('cli');
    if (cfg.backend === 'cli') expect(cfg.cli.claudePath).toBe('claude');
    rmSync(p);
  });

  it('throws when cli block is missing for cli backend', () => {
    const p = writeTmp({ backend: 'cli' });
    expect(() => loadConfig(p)).toThrow();
    rmSync(p);
  });

  it('accepts custom claudePath', () => {
    const p = writeTmp({
      backend: 'cli',
      cli: { model: 'claude-opus-4-6', claudePath: '/usr/local/bin/claude' },
    });
    const cfg = loadConfig(p);
    if (cfg.backend === 'cli') expect(cfg.cli.claudePath).toBe('/usr/local/bin/claude');
    rmSync(p);
  });
});

describe('loadConfig — validation errors', () => {
  it('throws on invalid backend value', () => {
    const p = writeTmp({ backend: 'gpt' });
    expect(() => loadConfig(p)).toThrow();
    rmSync(p);
  });

  it('throws when file does not exist', () => {
    expect(() => loadConfig('/nonexistent/config.json')).toThrow();
  });

  it('throws when file is not valid JSON', () => {
    const p = join(tmpdir(), `config-test-bad-${Date.now()}.json`);
    writeFileSync(p, 'not json {{{');
    expect(() => loadConfig(p)).toThrow();
    rmSync(p);
  });

  it('allows custom host and port', () => {
    const p = writeTmp({
      backend: 'api',
      host: '0.0.0.0',
      port: 8080,
      api: { apiKey: 'sk-ant-test', model: 'claude-opus-4-6' },
    });
    const cfg = loadConfig(p);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.port).toBe(8080);
    rmSync(p);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test -- src/config.test.ts
```

Expected: FAIL — `./config.js` not found.

- [ ] **Step 3: Write `src/config.ts`**

```typescript
import { readFileSync } from 'fs';
import { z } from 'zod';

const ApiConfigSchema = z.object({
  apiKey: z.string().min(1),
  model: z.string().min(1),
});

const CliConfigSchema = z.object({
  model: z.string().min(1),
  claudePath: z.string().min(1).default('claude'),
});

const ConfigSchema = z
  .object({
    backend: z.enum(['api', 'cli']),
    host: z.string().default('127.0.0.1'),
    port: z.number().int().positive().default(3000),
    api: ApiConfigSchema.optional(),
    cli: CliConfigSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.backend === 'api' && !data.api) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'api block is required when backend is "api"',
        path: ['api'],
      });
    }
    if (data.backend === 'cli' && !data.cli) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cli block is required when backend is "cli"',
        path: ['cli'],
      });
    }
  });

type ApiConfig = z.infer<typeof ApiConfigSchema>;
type CliConfig = z.infer<typeof CliConfigSchema>;

export type Config =
  | { backend: 'api'; host: string; port: number; api: ApiConfig; cli?: CliConfig }
  | { backend: 'cli'; host: string; port: number; api?: ApiConfig; cli: CliConfig };

export function loadConfig(configPath: string): Config {
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config: ${result.error.message}`);
  }
  return result.data as Config;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test -- src/config.test.ts
```

Expected: All pass.

- [ ] **Step 5: Lint**

```bash
npm run lint:fix
```

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: config loading with zod validation"
```

---

## Task 4: Transform Layer

**Files:**
- Create: `src/transform.ts`
- Create: `src/transform.test.ts`

`openAIMessagesToNormalized` throws `Error` on unsupported roles — the route converts this to a 400. System messages are extracted into the `system` field; they do not appear in `NormalizedRequest.messages`.

- [ ] **Step 1: Write failing tests in `src/transform.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import {
  openAIMessagesToNormalized,
  normalizedResponseToOpenAI,
  normalizedChunkToOpenAI,
} from './transform.js';
import type { NormalizedResponse, NormalizedChunk } from './backends/types.js';

describe('openAIMessagesToNormalized', () => {
  it('maps user and assistant messages', () => {
    const result = openAIMessagesToNormalized([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);
    expect(result.messages).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);
    expect(result.system).toBeUndefined();
  });

  it('extracts first system message as system prompt', () => {
    const result = openAIMessagesToNormalized([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ]);
    expect(result.system).toBe('You are helpful.');
    expect(result.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('uses only the first system message when multiple present', () => {
    const result = openAIMessagesToNormalized([
      { role: 'system', content: 'First' },
      { role: 'system', content: 'Second' },
      { role: 'user', content: 'Hello' },
    ]);
    expect(result.system).toBe('First');
    expect(result.messages).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('throws on unsupported role', () => {
    expect(() =>
      openAIMessagesToNormalized([{ role: 'tool' as never, content: 'x' }]),
    ).toThrow('Unsupported message role: tool');
  });
});

describe('normalizedResponseToOpenAI', () => {
  it('converts a NormalizedResponse to ChatCompletion shape', () => {
    const response: NormalizedResponse = {
      id: 'chatcmpl-123',
      model: 'claude-opus-4-6',
      content: 'Hello!',
      promptTokens: 10,
      completionTokens: 5,
    };
    const result = normalizedResponseToOpenAI(response) as Record<string, unknown>;
    expect(result['id']).toBe('chatcmpl-123');
    expect(result['object']).toBe('chat.completion');
    expect(result['model']).toBe('claude-opus-4-6');
    const choices = result['choices'] as Array<Record<string, unknown>>;
    const msg = choices[0]['message'] as Record<string, string>;
    expect(msg['role']).toBe('assistant');
    expect(msg['content']).toBe('Hello!');
    expect(choices[0]['finish_reason']).toBe('stop');
    const usage = result['usage'] as Record<string, number>;
    expect(usage['prompt_tokens']).toBe(10);
    expect(usage['completion_tokens']).toBe(5);
    expect(usage['total_tokens']).toBe(15);
  });
});

describe('normalizedChunkToOpenAI', () => {
  it('converts a mid-stream chunk', () => {
    const chunk: NormalizedChunk = { id: 'chatcmpl-abc', delta: 'Hello', finishReason: null };
    const result = normalizedChunkToOpenAI(chunk, 'claude-opus-4-6') as Record<string, unknown>;
    expect(result['id']).toBe('chatcmpl-abc');
    expect(result['object']).toBe('chat.completion.chunk');
    const choices = result['choices'] as Array<Record<string, unknown>>;
    const delta = choices[0]['delta'] as Record<string, string>;
    expect(delta['content']).toBe('Hello');
    expect(choices[0]['finish_reason']).toBeNull();
  });

  it('converts the final chunk with finish_reason and empty delta', () => {
    const chunk: NormalizedChunk = { id: 'chatcmpl-abc', delta: '', finishReason: 'stop' };
    const result = normalizedChunkToOpenAI(chunk, 'claude-opus-4-6') as Record<string, unknown>;
    const choices = result['choices'] as Array<Record<string, unknown>>;
    expect(choices[0]['finish_reason']).toBe('stop');
    expect(choices[0]['delta']).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test -- src/transform.test.ts
```

Expected: FAIL — `./transform.js` not found.

- [ ] **Step 3: Write `src/transform.ts`**

```typescript
import type { NormalizedMessage, NormalizedRequest, NormalizedResponse, NormalizedChunk } from './backends/types.js';

const SUPPORTED_ROLES = new Set(['system', 'user', 'assistant']);

interface OpenAIMessage {
  role: string;
  content: string;
}

export function openAIMessagesToNormalized(
  messages: OpenAIMessage[],
): Pick<NormalizedRequest, 'messages' | 'system'> {
  let system: string | undefined;
  const normalized: NormalizedMessage[] = [];

  for (const msg of messages) {
    if (!SUPPORTED_ROLES.has(msg.role)) {
      throw new Error(`Unsupported message role: ${msg.role}`);
    }
    if (msg.role === 'system') {
      if (system === undefined) system = msg.content; // first system wins; extras dropped
    } else {
      normalized.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
    }
  }

  return { messages: normalized, system };
}

export function normalizedResponseToOpenAI(response: NormalizedResponse): object {
  return {
    id: response.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: response.content },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: response.promptTokens,
      completion_tokens: response.completionTokens,
      total_tokens: response.promptTokens + response.completionTokens,
    },
  };
}

export function normalizedChunkToOpenAI(chunk: NormalizedChunk, model: string): object {
  return {
    id: chunk.id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: chunk.finishReason ? {} : { content: chunk.delta },
        finish_reason: chunk.finishReason,
        logprobs: null,
      },
    ],
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test -- src/transform.test.ts
```

Expected: All pass.

- [ ] **Step 5: Lint**

```bash
npm run lint:fix
```

- [ ] **Step 6: Commit**

```bash
git add src/transform.ts src/transform.test.ts
git commit -m "feat: OpenAI <-> Normalized transform layer"
```

---

## Task 5: API Backend

**Files:**
- Create: `src/backends/api.ts`
- Create: `src/backends/api.test.ts`

Mock `@anthropic-ai/sdk` entirely. Use `vi.resetModules()` + dynamic `import()` in `beforeEach` to ensure a fresh module with a clean mock state each test.

- [ ] **Step 1: Write failing tests in `src/backends/api.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedRequest } from './types.js';

vi.mock('@anthropic-ai/sdk', () => {
  const create = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({ messages: { create } })),
    _create: create,
  };
});

let ApiBackend: typeof import('./api.js').ApiBackend;
let mockCreate: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const sdkMod = await import('@anthropic-ai/sdk');
  mockCreate = (sdkMod as unknown as { _create: ReturnType<typeof vi.fn> })._create;
  const mod = await import('./api.js');
  ApiBackend = mod.ApiBackend;
});

const baseRequest: NormalizedRequest = {
  messages: [{ role: 'user', content: 'Hello' }],
  model: 'claude-opus-4-6',
};

describe('ApiBackend.complete', () => {
  it('returns a NormalizedResponse', async () => {
    mockCreate.mockResolvedValue({
      id: 'msg-123',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'Hi there!' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    const result = await backend.complete(baseRequest);

    expect(result.id).toBe('chatcmpl-msg-123');
    expect(result.content).toBe('Hi there!');
    expect(result.promptTokens).toBe(10);
    expect(result.completionTokens).toBe(5);
  });

  it('passes system message as top-level param, not in messages[]', async () => {
    mockCreate.mockResolvedValue({
      id: 'msg-456',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'Sure.' }],
      usage: { input_tokens: 20, output_tokens: 3 },
    });

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    await backend.complete({
      ...baseRequest,
      system: 'Be concise.',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['system']).toBe('Be concise.');
    expect((callArgs['messages'] as unknown[]).every(
      (m) => (m as Record<string, string>)['role'] !== 'system',
    )).toBe(true);
  });

  it('omits system param when not provided', async () => {
    mockCreate.mockResolvedValue({
      id: 'msg-789',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'Ok.' }],
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    await backend.complete(baseRequest);

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['system']).toBeUndefined();
  });

  it('propagates SDK errors', async () => {
    mockCreate.mockRejectedValue(new Error('Rate limit exceeded'));
    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    await expect(backend.complete(baseRequest)).rejects.toThrow('Rate limit exceeded');
  });
});

describe('ApiBackend.stream', () => {
  it('yields NormalizedChunks from streaming SDK events', async () => {
    async function* fakeStream() {
      yield { type: 'message_start', message: { id: 'msg-789' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } };
      yield { type: 'message_stop' };
    }
    // stream: true variant returns the stream directly (not a Promise)
    mockCreate.mockReturnValue(fakeStream());

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ id: 'chatcmpl-msg-789', delta: 'Hello', finishReason: null });
    expect(chunks[1]).toEqual({ id: 'chatcmpl-msg-789', delta: ' world', finishReason: null });
    expect(chunks[2]).toEqual({ id: 'chatcmpl-msg-789', delta: '', finishReason: 'stop' });
  });

  it('ignores non-text-delta events', async () => {
    async function* fakeStream() {
      yield { type: 'message_start', message: { id: 'msg-abc' } };
      yield { type: 'content_block_start', content_block: { type: 'text' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } };
      yield { type: 'ping' };
      yield { type: 'content_block_stop' };
      yield { type: 'message_stop' };
    }
    mockCreate.mockReturnValue(fakeStream());

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2); // 'Hi' chunk + stop chunk
  });

  it('passes system message when streaming', async () => {
    async function* fakeStream() {
      yield { type: 'message_start', message: { id: 'msg-sys' } };
      yield { type: 'message_stop' };
    }
    mockCreate.mockReturnValue(fakeStream());

    const backend = new ApiBackend('sk-ant-test', 'claude-opus-4-6');
    for await (const _ of backend.stream({ ...baseRequest, system: 'Be brief.' })) {
      // consume
    }

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['system']).toBe('Be brief.');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test -- src/backends/api.test.ts
```

Expected: FAIL — `./api.js` not found.

- [ ] **Step 3: Write `src/backends/api.ts`**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import type { BackendDriver, NormalizedRequest, NormalizedResponse, NormalizedChunk } from './types.js';

export class ApiBackend implements BackendDriver {
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 1024,
      ...(request.system !== undefined ? { system: request.system } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
    });

    const content = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('');

    return {
      id: `chatcmpl-${response.id}`,
      model: response.model,
      content,
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
    };
  }

  async *stream(request: NormalizedRequest): AsyncIterable<NormalizedChunk> {
    // The SDK returns an AsyncIterable<StreamEvent> directly when stream: true
    const eventStream = this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 1024,
      ...(request.system !== undefined ? { system: request.system } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    }) as unknown as AsyncIterable<Record<string, unknown>>;

    let id = 'chatcmpl-unknown';

    for await (const event of eventStream) {
      if (event['type'] === 'message_start') {
        id = `chatcmpl-${(event['message'] as { id: string }).id}`;
      } else if (
        event['type'] === 'content_block_delta' &&
        (event['delta'] as { type: string }).type === 'text_delta'
      ) {
        yield { id, delta: (event['delta'] as { text: string }).text, finishReason: null };
      } else if (event['type'] === 'message_stop') {
        yield { id, delta: '', finishReason: 'stop' };
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test -- src/backends/api.test.ts
```

Expected: All pass.

- [ ] **Step 5: Lint**

```bash
npm run lint:fix
```

- [ ] **Step 6: Commit**

```bash
git add src/backends/api.ts src/backends/api.test.ts
git commit -m "feat: Anthropic SDK backend driver"
```

---

## Task 6: CLI Backend

**Files:**
- Create: `src/backends/cli.ts`
- Create: `src/backends/cli.test.ts`

**Race condition fix:** register the `close` listener on the process *before* iterating readline, so the event cannot be missed regardless of timing.

**System message:** passed via `--system <text>` CLI flag — NOT injected into the prompt body.

- [ ] **Step 1: Write failing tests in `src/backends/cli.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable, EventEmitter } from 'stream';
import type { NormalizedRequest } from './types.js';

vi.mock('child_process', () => ({ spawn: vi.fn() }));

let CliBackend: typeof import('./cli.js').CliBackend;
let mockSpawn: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const cp = await import('child_process');
  mockSpawn = cp.spawn as unknown as ReturnType<typeof vi.fn>;
  const mod = await import('./cli.js');
  CliBackend = mod.CliBackend;
});

type FakeProcess = EventEmitter & { stdout: Readable; stderr: Readable };

function makeFakeProcess(lines: string[], exitCode: number = 0): FakeProcess {
  const stdout = Readable.from(lines.map((l) => l + '\n'));
  const stderr = Readable.from([]);
  const proc = new EventEmitter() as FakeProcess;
  proc.stdout = stdout;
  proc.stderr = stderr;
  // Emit close after stdout is consumed
  stdout.on('end', () => setImmediate(() => proc.emit('close', exitCode)));
  return proc;
}

const baseRequest: NormalizedRequest = {
  messages: [{ role: 'user', content: 'Hello' }],
  model: 'claude-opus-4-6',
};

describe('CliBackend.stream', () => {
  it('yields text_delta chunks and final stop chunk', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([
        JSON.stringify({ type: 'message_start', message: {} }),
        JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }),
        JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '!' } }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0].delta).toBe('Hi');
    expect(chunks[1].delta).toBe('!');
    expect(chunks[2].finishReason).toBe('stop');
    expect(chunks[2].delta).toBe('');
  });

  it('ignores non-text-delta event types', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([
        JSON.stringify({ type: 'ping' }),
        JSON.stringify({ type: 'content_block_start' }),
        JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'A' } }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
  });

  it('skips malformed JSON lines and continues', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([
        'not json !!!',
        JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'B' } }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }
    expect(chunks[0].delta).toBe('B');
  });

  it('throws when process exits with non-zero code', async () => {
    const proc = new EventEmitter() as FakeProcess;
    proc.stdout = Readable.from([JSON.stringify({ type: 'message_stop' }) + '\n']);
    let stderrData = '';
    proc.stderr = new Readable({ read() {} });
    proc.stdout.on('end', () => {
      setImmediate(() => {
        stderrData = 'error: something went wrong';
        proc.emit('close', 1);
      });
    });
    mockSpawn.mockReturnValue(proc);

    const backend = new CliBackend('claude-opus-4-6');
    await expect(async () => {
      for await (const _ of backend.stream(baseRequest)) {
        // consume
      }
    }).rejects.toThrow(/exited with code 1/);
  });

  it('uses custom claudePath', async () => {
    mockSpawn.mockReturnValue(makeFakeProcess([JSON.stringify({ type: 'message_stop' })]));
    const backend = new CliBackend('claude-opus-4-6', '/custom/claude');
    for await (const _ of backend.stream(baseRequest)) {
      // consume
    }
    expect(mockSpawn.mock.calls[0][0]).toBe('/custom/claude');
  });

  it('passes system message via --system flag', async () => {
    mockSpawn.mockReturnValue(makeFakeProcess([JSON.stringify({ type: 'message_stop' })]));
    const backend = new CliBackend('claude-opus-4-6');
    for await (const _ of backend.stream({ ...baseRequest, system: 'Be brief.' })) {
      // consume
    }
    const args = mockSpawn.mock.calls[0][1] as string[];
    const sysIdx = args.indexOf('--system');
    expect(sysIdx).toBeGreaterThan(-1);
    expect(args[sysIdx + 1]).toBe('Be brief.');
  });

  it('does not include --system flag when system is not set', async () => {
    mockSpawn.mockReturnValue(makeFakeProcess([JSON.stringify({ type: 'message_stop' })]));
    const backend = new CliBackend('claude-opus-4-6');
    for await (const _ of backend.stream(baseRequest)) {
      // consume
    }
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args.includes('--system')).toBe(false);
  });
});

describe('CliBackend.complete', () => {
  it('accumulates stream chunks into a NormalizedResponse', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([
        JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }),
        JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    const result = await backend.complete(baseRequest);
    expect(result.content).toBe('Hello world');
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it('propagates stream errors through complete()', async () => {
    const proc = new EventEmitter() as FakeProcess;
    proc.stdout = Readable.from([JSON.stringify({ type: 'message_stop' }) + '\n']);
    proc.stderr = new Readable({ read() {} });
    proc.stdout.on('end', () => setImmediate(() => proc.emit('close', 1)));
    mockSpawn.mockReturnValue(proc);

    const backend = new CliBackend('claude-opus-4-6');
    await expect(backend.complete(baseRequest)).rejects.toThrow(/exited with code 1/);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test -- src/backends/cli.test.ts
```

Expected: FAIL — `./cli.js` not found.

- [ ] **Step 3: Write `src/backends/cli.ts`**

```typescript
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import type { BackendDriver, NormalizedRequest, NormalizedResponse, NormalizedChunk } from './types.js';

export class CliBackend implements BackendDriver {
  constructor(
    private model: string,
    private claudePath: string = 'claude',
  ) {}

  async *stream(request: NormalizedRequest): AsyncIterable<NormalizedChunk> {
    const prompt = buildPrompt(request.messages);
    const id = `chatcmpl-${randomUUID()}`;

    const args = ['-p', prompt];
    if (request.system !== undefined) args.push('--system', request.system);
    args.push('--output-format', 'stream-json');

    const proc = spawn(this.claudePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Register close listener BEFORE iterating readline to guarantee we never miss the event
    const closePromise = new Promise<number>((resolve) => {
      proc.on('close', (code: number) => resolve(code));
    });

    const rl = createInterface({ input: proc.stdout! });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        process.stderr.write(`[cli-backend] malformed line: ${trimmed}\n`);
        continue;
      }

      if (
        event['type'] === 'content_block_delta' &&
        (event['delta'] as Record<string, unknown>)?.['type'] === 'text_delta'
      ) {
        yield { id, delta: (event['delta'] as Record<string, string>)['text'], finishReason: null };
      } else if (event['type'] === 'message_stop') {
        yield { id, delta: '', finishReason: 'stop' };
        break;
      }
    }

    const exitCode = await closePromise;
    if (exitCode !== 0) {
      throw new Error(`claude process exited with code ${exitCode}: ${stderr.trim()}`);
    }
  }

  async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
    let content = '';
    let id = '';

    for await (const chunk of this.stream(request)) {
      id = chunk.id;
      content += chunk.delta;
    }

    return { id, model: this.model, content, promptTokens: 0, completionTokens: 0 };
  }
}

function buildPrompt(messages: NormalizedRequest['messages']): string {
  // System messages are handled via --system flag, not injected here
  return messages
    .map((m) => {
      const prefix = m.role === 'assistant' ? 'Assistant' : 'Human';
      return `${prefix}: ${m.content}`;
    })
    .join('\n');
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test -- src/backends/cli.test.ts
```

Expected: All pass.

- [ ] **Step 5: Lint**

```bash
npm run lint:fix
```

- [ ] **Step 6: Commit**

```bash
git add src/backends/cli.ts src/backends/cli.test.ts
git commit -m "feat: CLI backend driver using claude -p"
```

---

## Task 7: Models Route

**Files:**
- Create: `src/routes/models.ts`
- Create: `src/routes/models.test.ts`

Returns a single-item list for the active backend's configured model only.

- [ ] **Step 1: Write `src/routes/models.ts`** (before the test, since `buildApp` isn't available yet)

```typescript
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';

export function registerModelsRoute(app: FastifyInstance, config: Config): void {
  const modelId = config.backend === 'api' ? config.api.model : config.cli.model;

  app.get('/v1/models', async (_req, reply) => {
    return reply.send({
      object: 'list',
      data: [
        {
          id: modelId,
          object: 'model',
          created: 1741000000,
          owned_by: 'anthropic',
        },
      ],
    });
  });
}
```

- [ ] **Step 2: Write `src/routes/models.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { buildApp } from '../server.js';
import type { Config } from '../config.js';

const apiConfig: Config = {
  backend: 'api',
  host: '127.0.0.1',
  port: 3000,
  api: { apiKey: 'sk-ant-test', model: 'claude-opus-4-6' },
};

describe('GET /v1/models', () => {
  it('returns a list with the active backend model', async () => {
    const app = await buildApp(apiConfig);
    const response = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body['object']).toBe('list');
    const data = body['data'] as Array<Record<string, unknown>>;
    expect(data).toHaveLength(1);
    expect(data[0]['id']).toBe('claude-opus-4-6');
    expect(data[0]['object']).toBe('model');
    expect(typeof data[0]['created']).toBe('number');
    expect(data[0]['owned_by']).toBe('anthropic');
  });

  it('uses cli model when backend is cli', async () => {
    const cliConfig: Config = {
      backend: 'cli',
      host: '127.0.0.1',
      port: 3000,
      cli: { model: 'claude-haiku-4-5-20251001', claudePath: 'claude' },
    };
    const app = await buildApp(cliConfig);
    const response = await app.inject({ method: 'GET', url: '/v1/models' });
    const body = response.json() as Record<string, unknown>;
    const data = body['data'] as Array<Record<string, unknown>>;
    expect(data[0]['id']).toBe('claude-haiku-4-5-20251001');
  });
});
```

Note: these tests depend on `buildApp` from `server.ts` (Task 9). The route file is committed now; tests are verified after Task 9.

- [ ] **Step 3: Commit**

```bash
git add src/routes/models.ts src/routes/models.test.ts
git commit -m "feat: GET /v1/models route"
```

---

## Task 8: Chat Route

**Files:**
- Create: `src/routes/chat.ts`
- Create: `src/routes/chat.test.ts`

The route calls `openAIMessagesToNormalized` once to get `{ messages, system }`, builds a `NormalizedRequest`, and passes it directly to the driver. No re-extraction needed.

- [ ] **Step 1: Write `src/routes/chat.ts`**

```typescript
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import type { BackendDriver } from '../backends/types.js';
import {
  openAIMessagesToNormalized,
  normalizedResponseToOpenAI,
  normalizedChunkToOpenAI,
} from '../transform.js';

interface ChatRequestBody {
  messages: { role: string; content: string }[];
  model?: string;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

export function registerChatRoute(
  app: FastifyInstance,
  config: Config,
  driver: BackendDriver,
): void {
  const modelName = config.backend === 'api' ? config.api.model : config.cli.model;

  app.post(
    '/v1/chat/completions',
    {
      schema: {
        body: {
          type: 'object',
          required: ['messages'],
          properties: {
            messages: { type: 'array', items: { type: 'object' }, minItems: 1 },
            model: { type: 'string' },
            stream: { type: 'boolean' },
            max_tokens: { type: 'number' },
            temperature: { type: 'number' },
          },
        },
      },
    },
    async (req: FastifyRequest<{ Body: ChatRequestBody }>, reply: FastifyReply) => {
      const body = req.body;

      let normalized: { messages: import('../backends/types.js').NormalizedMessage[]; system?: string };
      try {
        normalized = openAIMessagesToNormalized(body.messages);
      } catch (err) {
        return reply.status(400).send({
          error: { message: (err as Error).message, type: 'invalid_request_error', code: null },
        });
      }

      const normalizedRequest = {
        messages: normalized.messages,
        system: normalized.system,
        model: modelName,
        maxTokens: body.max_tokens,
        temperature: body.temperature,
      };

      if (body.stream) {
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.flushHeaders();

        try {
          for await (const chunk of driver.stream(normalizedRequest)) {
            const sseChunk = normalizedChunkToOpenAI(chunk, modelName);
            reply.raw.write(`data: ${JSON.stringify(sseChunk)}\n\n`);
          }
          reply.raw.write('data: [DONE]\n\n');
        } catch (err) {
          const errEvent = {
            error: { message: (err as Error).message, type: 'server_error', code: null },
          };
          reply.raw.write(`data: ${JSON.stringify(errEvent)}\n\n`);
        } finally {
          reply.raw.end();
        }
        return;
      }

      try {
        const response = await driver.complete(normalizedRequest);
        return reply.send(normalizedResponseToOpenAI(response));
      } catch (err) {
        return reply.status(500).send({
          error: { message: (err as Error).message, type: 'server_error', code: null },
        });
      }
    },
  );
}
```

- [ ] **Step 2: Write `src/routes/chat.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { buildApp } from '../server.js';
import type { Config } from '../config.js';
import type { BackendDriver, NormalizedChunk } from '../backends/types.js';

const cfg: Config = {
  backend: 'api',
  host: '127.0.0.1',
  port: 3000,
  api: { apiKey: 'sk-ant-test', model: 'claude-opus-4-6' },
};

function makeMockDriver(overrides: Partial<BackendDriver> = {}): BackendDriver {
  return {
    complete: vi.fn().mockResolvedValue({
      id: 'chatcmpl-test',
      model: 'claude-opus-4-6',
      content: 'Hello!',
      promptTokens: 10,
      completionTokens: 5,
    }),
    stream: vi.fn().mockImplementation(async function* () {
      yield { id: 'chatcmpl-test', delta: 'Hello', finishReason: null } as NormalizedChunk;
      yield { id: 'chatcmpl-test', delta: '', finishReason: 'stop' } as NormalizedChunk;
    }),
    ...overrides,
  };
}

describe('POST /v1/chat/completions — non-streaming', () => {
  it('returns a ChatCompletion response', async () => {
    const driver = makeMockDriver();
    const app = await buildApp(cfg, driver);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'Hi' }], stream: false },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body['object']).toBe('chat.completion');
    const choices = body['choices'] as Array<Record<string, unknown>>;
    expect((choices[0]['message'] as Record<string, string>)['content']).toBe('Hello!');
  });

  it('passes system message from request to driver', async () => {
    const driver = makeMockDriver();
    const app = await buildApp(cfg, driver);
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Hi' },
        ],
      },
    });
    const callArg = (driver.complete as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as import('../backends/types.js').NormalizedRequest;
    expect(callArg.system).toBe('Be brief.');
    expect(callArg.messages.every((m) => m.role !== 'system')).toBe(true);
  });

  it('returns 400 for unsupported message role', async () => {
    const driver = makeMockDriver();
    const app = await buildApp(cfg, driver);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'tool', content: 'x' }] },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/Unsupported message role/);
  });

  it('returns 400 when messages is missing', async () => {
    const driver = makeMockDriver();
    const app = await buildApp(cfg, driver);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 500 when backend throws', async () => {
    const driver = makeMockDriver({
      complete: vi.fn().mockRejectedValue(new Error('Backend failure')),
    });
    const app = await buildApp(cfg, driver);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'Hi' }] },
    });
    expect(response.statusCode).toBe(500);
    const body = response.json() as { error: { message: string } };
    expect(body.error.message).toMatch(/Backend failure/);
  });
});

describe('POST /v1/chat/completions — streaming', () => {
  it('returns SSE stream with correct event format', async () => {
    const driver = makeMockDriver();
    const app = await buildApp(cfg, driver);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'Hi' }], stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/event-stream/);

    const lines = response.body.split('\n').filter(Boolean);
    const dataLines = lines.filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]');
    const chunk = JSON.parse(dataLines[0].replace('data: ', '')) as Record<string, unknown>;
    expect(chunk['object']).toBe('chat.completion.chunk');
    expect(response.body).toContain('data: [DONE]');
  });

  it('sends SSE error event when backend stream throws', async () => {
    const driver = makeMockDriver({
      stream: vi.fn().mockImplementation(async function* () {
        yield { id: 'chatcmpl-test', delta: 'Partial', finishReason: null } as NormalizedChunk;
        throw new Error('stream exploded');
      }),
    });
    const app = await buildApp(cfg, driver);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'Hi' }], stream: true },
    });
    expect(response.body).toContain('"error"');
    expect(response.body).toContain('stream exploded');
    expect(response.body).not.toContain('[DONE]');
  });
});
```

- [ ] **Step 3: Commit route files (tests verified after Task 9)**

```bash
git add src/routes/chat.ts src/routes/chat.test.ts
git commit -m "feat: POST /v1/chat/completions route"
```

---

## Task 9: Server Factory

**Files:**
- Create: `src/server.ts`
- Create: `src/server.test.ts`

`buildApp` accepts an optional `BackendDriver` override used by tests. Server tests always pass a mock driver to avoid instantiating real backends.

- [ ] **Step 1: Write failing tests in `src/server.test.ts`**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { buildApp } from './server.js';
import type { Config } from './config.js';
import type { BackendDriver } from './backends/types.js';

const cfg: Config = {
  backend: 'api',
  host: '127.0.0.1',
  port: 3000,
  api: { apiKey: 'sk-ant-test', model: 'claude-opus-4-6' },
};

const mockDriver: BackendDriver = {
  complete: vi.fn(),
  stream: vi.fn(),
};

describe('buildApp', () => {
  it('returns a Fastify instance', async () => {
    const app = await buildApp(cfg, mockDriver);
    expect(app).toBeDefined();
    expect(typeof app.inject).toBe('function');
  });

  it('returns 404 for unknown routes', async () => {
    const app = await buildApp(cfg, mockDriver);
    const response = await app.inject({ method: 'GET', url: '/unknown' });
    expect(response.statusCode).toBe(404);
  });

  it('registers /v1/models route', async () => {
    const app = await buildApp(cfg, mockDriver);
    const response = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(response.statusCode).toBe(200);
  });

  it('registers /v1/chat/completions route (400 = route exists and parsed body)', async () => {
    const app = await buildApp(cfg, mockDriver);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm run test -- src/server.test.ts
```

Expected: FAIL — `./server.js` not found.

- [ ] **Step 3: Write `src/server.ts`**

```typescript
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { BackendDriver } from './backends/types.js';
import { ApiBackend } from './backends/api.js';
import { CliBackend } from './backends/cli.js';
import { registerModelsRoute } from './routes/models.js';
import { registerChatRoute } from './routes/chat.js';

/* c8 ignore next 5 — only called when no driver override is provided; all tests inject a mock */
function createDriver(config: Config): BackendDriver {
  if (config.backend === 'api') {
    return new ApiBackend(config.api.apiKey, config.api.model);
  }
  return new CliBackend(config.cli.model, config.cli.claudePath);
}

export async function buildApp(
  config: Config,
  driver?: BackendDriver,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  const activeDriver = driver ?? createDriver(config);

  registerModelsRoute(app, config);
  registerChatRoute(app, config, activeDriver);

  await app.ready();
  return app;
}
```

- [ ] **Step 4: Run all route and server tests together**

```bash
npm run test -- src/server.test.ts src/routes/models.test.ts src/routes/chat.test.ts
```

Expected: All pass.

- [ ] **Step 5: Lint**

```bash
npm run lint:fix
```

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: Fastify app factory"
```

---

## Task 10: Entry Point

**Files:**
- Modify: `src/index.ts` (replace placeholder)
- Create: `src/index.test.ts`

`getConfigPath` is exported for testability. The `main()` function body and `process.exit()` calls are annotated with `/* c8 ignore */` as they cannot be exercised in unit tests.

- [ ] **Step 1: Write failing tests in `src/index.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';
import { getConfigPath } from './index.js';

describe('getConfigPath', () => {
  it('returns config.json by default', () => {
    expect(getConfigPath(['node', 'index.js'])).toBe('config.json');
  });

  it('returns path after --config flag', () => {
    expect(getConfigPath(['node', 'index.js', '--config', '/etc/my.json'])).toBe('/etc/my.json');
  });

  it('returns config.json when --config flag has no following value', () => {
    expect(getConfigPath(['node', 'index.js', '--config'])).toBe('config.json');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm run test -- src/index.test.ts
```

Expected: FAIL — `getConfigPath` not exported.

- [ ] **Step 3: Write `src/index.ts`**

```typescript
import { loadConfig } from './config.js';
import { buildApp } from './server.js';

export function getConfigPath(argv: string[]): string {
  const idx = argv.indexOf('--config');
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  return 'config.json';
}

async function main(): Promise<void> {
  const configPath = getConfigPath(process.argv);

  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    process.stderr.write(
      `Failed to load config from "${configPath}": ${(err as Error).message}\n`,
    );
    /* c8 ignore next */
    process.exit(1);
  }

  const app = await buildApp(config);
  /* c8 ignore next */
  await app.listen({ host: config.host, port: config.port });
  /* c8 ignore next */
  process.stdout.write(`claude-local-server listening on ${config.host}:${config.port}\n`);
}

/* c8 ignore next */
main().catch((err: unknown) => {
  /* c8 ignore next */
  process.stderr.write(`Fatal: ${(err as Error).message}\n`);
  /* c8 ignore next */
  process.exit(1);
});
```

- [ ] **Step 4: Run index tests**

```bash
npm run test -- src/index.test.ts
```

Expected: All pass.

- [ ] **Step 5: Run the full test suite with coverage**

```bash
npm run test:coverage
```

Expected: 100% across all metrics. If any line is not covered and is genuinely not reachable in tests, add a `/* c8 ignore next */` comment with a brief inline note explaining why.

- [ ] **Step 6: Lint everything**

```bash
npm run lint:fix
```

Expected: No errors.

- [ ] **Step 7: Build TypeScript**

```bash
npm run build
```

Expected: Clean compile, no errors.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat: entry point with --config flag support"
```

---

## Task 11: CLAUDE.md

**Files:**
- Create: `CLAUDE.md`

- [ ] **Step 1: Write `CLAUDE.md`**

```markdown
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

Coverage must remain at 100%. Lines that cannot be covered (process entry point, `process.exit()`) are annotated with `/* c8 ignore next */`.

## Configuration

Copy `config.json.example` → `config.json`. Use `--config <path>` to specify a different location. When `backend` is `"api"`, the `api` block is required. When `backend` is `"cli"`, the `cli` block is required.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add CLAUDE.md"
```

---

## Done

All tasks complete. To start:
1. `cp config.json.example config.json` and fill in your API key (or set `backend: "cli"`)
2. `npm start`

The server listens on `127.0.0.1:3000` (or whatever `host`/`port` you configured) and accepts requests from any OpenAI SDK client.

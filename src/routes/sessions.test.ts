import { describe, it, expect } from 'vitest';
import { buildApp } from '../server.js';
import type { BackendDriver } from '../backends/types.js';
import type { Config } from '../config.js';

const cfg: Config = {
  backend: 'cli',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  cli: { claudePath: 'claude' },
};

function makeDriver(knownIds: string[] = []): BackendDriver {
  const sessions = new Set(knownIds);
  return {
    complete: async () => ({
      id: 'x',
      model: 'claude',
      content: '',
      promptTokens: 0,
      completionTokens: 0,
    }),
    stream: async function* () {
      yield { type: 'text', id: 'x', delta: '', finishReason: 'stop' };
    },
    hasSession: (id) => sessions.has(id),
    deleteSession: (id) => sessions.delete(id),
  };
}

describe('DELETE /v1/sessions/:id', () => {
  it('returns 204 and removes an existing session', async () => {
    const driver = makeDriver(['sess-1']);
    const app = await buildApp(cfg, driver);

    const res = await app.inject({ method: 'DELETE', url: '/v1/sessions/sess-1' });
    expect(res.statusCode).toBe(204);

    // Session is gone — a subsequent delete returns 404
    const res2 = await app.inject({ method: 'DELETE', url: '/v1/sessions/sess-1' });
    expect(res2.statusCode).toBe(404);
  });

  it('returns 404 for an unknown session', async () => {
    const app = await buildApp(cfg, makeDriver());
    const res = await app.inject({ method: 'DELETE', url: '/v1/sessions/unknown' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('Session not found');
  });

  it('route is not registered when driver has no deleteSession', async () => {
    const driver: BackendDriver = {
      complete: async () => ({
        id: 'x',
        model: 'claude',
        content: '',
        promptTokens: 0,
        completionTokens: 0,
      }),
      stream: async function* () {
        yield { type: 'text', id: 'x', delta: '', finishReason: 'stop' };
      },
    };
    const app = await buildApp(cfg, driver);
    const res = await app.inject({ method: 'DELETE', url: '/v1/sessions/any' });
    expect(res.statusCode).toBe(404); // Fastify route-not-found
  });
});

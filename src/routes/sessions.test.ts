import { describe, it, expect } from 'vitest';
import { buildApp } from '../server.js';
import type { BackendDriver } from '../backends/types.js';
import type { SessionInfo } from '../backends/types.js';
import type { Config } from '../config.js';

const cfg: Config = {
  backend: 'cli',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  cli: { claudePath: 'claude' },
};

function makeDriver(knownIds: string[] = [], sessionData: SessionInfo[] = []): BackendDriver {
  const sessions = new Set(knownIds);
  const store = new Map<string, SessionInfo>(sessionData.map((s) => [s.id, s]));
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
    listSessions: () => sessionData.map((s) => ({ id: s.id, lastUsed: s.lastUsed })),
    getSession: (id) => store.get(id),
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

describe('GET /v1/sessions', () => {
  it('returns empty list when no sessions exist', async () => {
    const app = await buildApp(cfg, makeDriver());
    const res = await app.inject({ method: 'GET', url: '/v1/sessions' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessions: [] });
  });

  it('returns sessions with id and lastUsed as ISO string', async () => {
    const ts = new Date('2026-03-27T10:00:00.000Z');
    const driver = makeDriver(['sess-1'], [
      { id: 'sess-1', lastUsed: ts, messages: [] },
    ]);
    const app = await buildApp(cfg, driver);
    const res = await app.inject({ method: 'GET', url: '/v1/sessions' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sessions: [{ id: 'sess-1', lastUsed: '2026-03-27T10:00:00.000Z' }],
    });
  });

  it('route is not registered when driver has no listSessions', async () => {
    const driver: BackendDriver = {
      complete: async () => ({ id: 'x', model: 'claude', content: '', promptTokens: 0, completionTokens: 0 }),
      stream: async function* () { yield { type: 'text', id: 'x', delta: '', finishReason: 'stop' }; },
    };
    const app = await buildApp(cfg, driver);
    const res = await app.inject({ method: 'GET', url: '/v1/sessions' });
    expect(res.statusCode).toBe(404); // Fastify route-not-found
  });
});

describe('GET /v1/sessions/:id', () => {
  it('returns session with messages when session exists', async () => {
    const ts = new Date('2026-03-27T10:00:00.000Z');
    const messages: { role: 'user' | 'assistant'; content: string }[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ];
    const driver = makeDriver(['sess-1'], [
      { id: 'sess-1', lastUsed: ts, messages },
    ]);
    const app = await buildApp(cfg, driver);
    const res = await app.inject({ method: 'GET', url: '/v1/sessions/sess-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: 'sess-1',
      lastUsed: '2026-03-27T10:00:00.000Z',
      messages,
    });
  });

  it('returns 404 for unknown session', async () => {
    const app = await buildApp(cfg, makeDriver());
    const res = await app.inject({ method: 'GET', url: '/v1/sessions/unknown' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('Session not found');
  });

  it('route is not registered when driver has no getSession', async () => {
    const driver: BackendDriver = {
      complete: async () => ({ id: 'x', model: 'claude', content: '', promptTokens: 0, completionTokens: 0 }),
      stream: async function* () { yield { type: 'text', id: 'x', delta: '', finishReason: 'stop' }; },
    };
    const app = await buildApp(cfg, driver);
    const res = await app.inject({ method: 'GET', url: '/v1/sessions/any' });
    expect(res.statusCode).toBe(404); // Fastify route-not-found
  });
});

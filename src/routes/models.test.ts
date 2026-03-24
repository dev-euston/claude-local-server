import { describe, it, expect } from 'vitest';
import { buildApp } from '../server.js';
import type { Config } from '../config.js';

const apiConfig: Config = {
  backend: 'api',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
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
      logLevel: 'silent',
      cli: { model: 'claude-haiku-4-5-20251001', claudePath: 'claude' },
    };
    const app = await buildApp(cliConfig);
    const response = await app.inject({ method: 'GET', url: '/v1/models' });
    const body = response.json() as Record<string, unknown>;
    const data = body['data'] as Array<Record<string, unknown>>;
    expect(data[0]['id']).toBe('claude-haiku-4-5-20251001');
  });

  it('returns "claude" as model id when cli model is not configured', async () => {
    const cliConfig: Config = {
      backend: 'cli',
      host: '127.0.0.1',
      port: 3000,
      logLevel: 'silent',
      cli: { claudePath: 'claude' },
    };
    const app = await buildApp(cliConfig);
    const response = await app.inject({ method: 'GET', url: '/v1/models' });
    const body = response.json() as Record<string, unknown>;
    const data = body['data'] as Array<Record<string, unknown>>;
    expect(data[0]['id']).toBe('claude');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { buildApp } from './server.js';
import type { Config } from './config.js';
import type { BackendDriver } from './backends/types.js';

const cfg: Config = {
  backend: 'api',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
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

  it('returns 401 when apiKey is configured and Authorization header is missing', async () => {
    const cfgWithKey: Config = { ...cfg, apiKey: 'secret' };
    const app = await buildApp(cfgWithKey, mockDriver);
    const response = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(response.statusCode).toBe(401);
  });

  it('returns 401 when apiKey is configured and token is wrong', async () => {
    const cfgWithKey: Config = { ...cfg, apiKey: 'secret' };
    const app = await buildApp(cfgWithKey, mockDriver);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('allows request when apiKey is configured and correct bearer token is provided', async () => {
    const cfgWithKey: Config = { ...cfg, apiKey: 'secret' };
    const app = await buildApp(cfgWithKey, mockDriver);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer secret' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('allows request without Authorization header when apiKey is not configured', async () => {
    const app = await buildApp(cfg, mockDriver);
    const response = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(response.statusCode).toBe(200);
  });

  it('starts successfully when logLevel is not set (exercises ?? default)', async () => {
    const cfgNoLogLevel: Config = {
      backend: 'api',
      host: '127.0.0.1',
      port: 3000,
      api: { apiKey: 'sk-ant-test', model: 'claude-opus-4-6' },
    };
    const app = await buildApp(cfgNoLogLevel, mockDriver);
    expect(app).toBeDefined();
    await app.close();
  });
});

import { describe, it, expect } from 'vitest';
import { writeFileSync, rmSync } from 'fs';
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
    expect(() => loadConfig(p)).toThrow('api block is required');
    rmSync(p);
  });

  it('throws when apiKey is empty string', () => {
    const p = writeTmp({ backend: 'api', api: { apiKey: '', model: 'claude-opus-4-6' } });
    expect(() => loadConfig(p)).toThrow('Invalid config');
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
    expect(() => loadConfig(p)).toThrow('cli block is required');
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

  it('allows cli config without model', () => {
    const p = writeTmp({ backend: 'cli', cli: {} });
    const cfg = loadConfig(p);
    expect(cfg.backend).toBe('cli');
    if (cfg.backend === 'cli') expect(cfg.cli.model).toBeUndefined();
    rmSync(p);
  });
});

describe('loadConfig — validation errors', () => {
  it('throws on invalid backend value', () => {
    const p = writeTmp({ backend: 'gpt' });
    expect(() => loadConfig(p)).toThrow('Invalid config');
    rmSync(p);
  });

  it('throws when file does not exist', () => {
    expect(() => loadConfig('/nonexistent/config.json')).toThrow('Config file not found');
  });

  it('throws when file is not valid JSON', () => {
    const p = join(tmpdir(), `config-test-bad-${Date.now()}.json`);
    writeFileSync(p, 'not json {{{');
    expect(() => loadConfig(p)).toThrow('not valid JSON');
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

describe('loadConfig — apiKey', () => {
  it('accepts apiKey at top level', () => {
    const p = writeTmp({ backend: 'cli', cli: {}, apiKey: 'my-secret' });
    const cfg = loadConfig(p);
    expect(cfg.apiKey).toBe('my-secret');
    rmSync(p);
  });

  it('apiKey is undefined when omitted', () => {
    const p = writeTmp({ backend: 'cli', cli: {} });
    const cfg = loadConfig(p);
    expect(cfg.apiKey).toBeUndefined();
    rmSync(p);
  });

  it('rejects empty string apiKey', () => {
    const p = writeTmp({ backend: 'cli', cli: {}, apiKey: '' });
    expect(() => loadConfig(p)).toThrow('Invalid config');
    rmSync(p);
  });
});

describe('loadConfig — logLevel', () => {
  it('accepts logLevel "info"', () => {
    const p = writeTmp({ backend: 'cli', logLevel: 'info', cli: {} });
    const cfg = loadConfig(p);
    expect(cfg.logLevel).toBe('info');
    rmSync(p);
  });

  it('accepts logLevel "silent"', () => {
    const p = writeTmp({ backend: 'cli', logLevel: 'silent', cli: {} });
    const cfg = loadConfig(p);
    expect(cfg.logLevel).toBe('silent');
    rmSync(p);
  });

  it('rejects invalid logLevel "verbose"', () => {
    const p = writeTmp({ backend: 'cli', logLevel: 'verbose', cli: {} });
    expect(() => loadConfig(p)).toThrow('Invalid config');
    rmSync(p);
  });

  it('logLevel is undefined when omitted — default is applied in buildApp, not loadConfig', () => {
    const p = writeTmp({ backend: 'cli', cli: {} });
    const cfg = loadConfig(p);
    expect(cfg.logLevel).toBeUndefined();
    rmSync(p);
  });
});

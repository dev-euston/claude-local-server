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

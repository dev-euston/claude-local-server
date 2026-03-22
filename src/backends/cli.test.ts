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
    proc.stderr = new Readable({ read() {} });
    proc.stdout.on('end', () => {
      setImmediate(() => {
        proc.emit('close', 1);
      });
    });
    mockSpawn.mockReturnValue(proc);

    const backend = new CliBackend('claude-opus-4-6');
    await expect(async () => {
      for await (const _chunk of backend.stream(baseRequest)) {
        // consume
      }
    }).rejects.toThrow(/exited with code 1/);
  });

  it('captures stderr output in error message on non-zero exit', async () => {
    const proc = new EventEmitter() as FakeProcess;
    proc.stdout = Readable.from([JSON.stringify({ type: 'message_stop' }) + '\n']);
    const stderrReadable = Readable.from(['error output from claude\n']);
    proc.stderr = stderrReadable;
    proc.stdout.on('end', () => setImmediate(() => proc.emit('close', 2)));
    mockSpawn.mockReturnValue(proc);

    const backend = new CliBackend('claude-opus-4-6');
    await expect(async () => {
      for await (const _chunk of backend.stream(baseRequest)) {
        // consume
      }
    }).rejects.toThrow(/error output from claude/);
  });

  it('uses custom claudePath', async () => {
    mockSpawn.mockReturnValue(makeFakeProcess([JSON.stringify({ type: 'message_stop' })]));
    const backend = new CliBackend('claude-opus-4-6', '/custom/claude');
    for await (const _chunk of backend.stream(baseRequest)) {
      // consume
    }
    expect(mockSpawn.mock.calls[0][0]).toBe('/custom/claude');
  });

  it('passes system message via --system flag', async () => {
    mockSpawn.mockReturnValue(makeFakeProcess([JSON.stringify({ type: 'message_stop' })]));
    const backend = new CliBackend('claude-opus-4-6');
    for await (const _chunk of backend.stream({ ...baseRequest, system: 'Be brief.' })) {
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
    for await (const _chunk of backend.stream(baseRequest)) {
      // consume
    }
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args.includes('--system')).toBe(false);
  });

  it('skips empty lines in output', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([
        '',
        JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'X' } }),
        JSON.stringify({ type: 'message_stop' }),
      ]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }
    expect(chunks[0].delta).toBe('X');
  });

  it('formats assistant-role messages with Assistant prefix', async () => {
    mockSpawn.mockReturnValue(makeFakeProcess([JSON.stringify({ type: 'message_stop' })]));
    const backend = new CliBackend('claude-opus-4-6');
    for await (const _chunk of backend.stream({
      ...baseRequest,
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ],
    })) {
      // consume
    }
    const args = mockSpawn.mock.calls[0][1] as string[];
    const prompt = args[1];
    expect(prompt).toContain('Assistant: Hi there');
    expect(prompt).toContain('Human: Hello');
  });
});

describe('CliBackend.complete', () => {
  it('accumulates stream chunks into a NormalizedResponse', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([
        JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello' },
        }),
        JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: ' world' },
        }),
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

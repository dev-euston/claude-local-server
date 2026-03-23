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

const assistantEvent = (text: string, id = 'msg_123') =>
  JSON.stringify({
    type: 'assistant',
    message: { id, content: [{ type: 'text', text }] },
  });

const resultEvent = (text: string) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text });

const errorResultEvent = (text: string) =>
  JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: text });

describe('CliBackend.stream', () => {
  it('yields text chunk from assistant event and stop chunk from result event', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([assistantEvent('Hi!'), resultEvent('Hi!')]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].delta).toBe('Hi!');
    expect(chunks[0].finishReason).toBeNull();
    expect(chunks[1].delta).toBe('');
    expect(chunks[1].finishReason).toBe('stop');
  });

  it('uses message id from assistant event as chunk id prefix', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([assistantEvent('Hi', 'msg_abc123'), resultEvent('Hi')]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }
    expect(chunks[0].id).toContain('msg_abc123');
  });

  it('ignores non-assistant/result event types', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([
        JSON.stringify({ type: 'system', subtype: 'init' }),
        JSON.stringify({ type: 'rate_limit_event' }),
        assistantEvent('A'),
        resultEvent('A'),
      ]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0].delta).toBe('A');
  });

  it('skips malformed JSON lines and continues', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess(['not json !!!', assistantEvent('B'), resultEvent('B')]),
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
    proc.stdout = Readable.from([resultEvent('done') + '\n']);
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

  it('throws when result event has is_error true', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([errorResultEvent('something went wrong')]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    await expect(async () => {
      for await (const _chunk of backend.stream(baseRequest)) {
        // consume
      }
    }).rejects.toThrow(/something went wrong/);
  });

  it('captures stderr output in error message on non-zero exit', async () => {
    const proc = new EventEmitter() as FakeProcess;
    proc.stdout = Readable.from([resultEvent('done') + '\n']);
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
    mockSpawn.mockReturnValue(makeFakeProcess([resultEvent('')]));
    const backend = new CliBackend('claude-opus-4-6', '/custom/claude');
    for await (const _chunk of backend.stream(baseRequest)) {
      // consume
    }
    expect(mockSpawn.mock.calls[0][0]).toBe('/custom/claude');
  });

  it('passes system message via --system flag', async () => {
    mockSpawn.mockReturnValue(makeFakeProcess([resultEvent('')]));
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
    mockSpawn.mockReturnValue(makeFakeProcess([resultEvent('')]));
    const backend = new CliBackend('claude-opus-4-6');
    for await (const _chunk of backend.stream(baseRequest)) {
      // consume
    }
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args.includes('--system')).toBe(false);
  });

  it('skips empty lines in output', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess(['', assistantEvent('X'), resultEvent('X')]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }
    expect(chunks[0].delta).toBe('X');
  });

  it('formats assistant-role messages with Assistant prefix', async () => {
    mockSpawn.mockReturnValue(makeFakeProcess([resultEvent('')]));
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

describe('CliBackend — no model configured', () => {
  it('returns "claude" as model in response when no model set', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([assistantEvent('Hi'), resultEvent('Hi')]),
    );
    const backend = new CliBackend(undefined);
    const result = await backend.complete(baseRequest);
    expect(result.model).toBe('claude');
  });
});

describe('CliBackend.complete', () => {
  it('accumulates stream chunks into a NormalizedResponse', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([
        assistantEvent('Hello world'),
        resultEvent('Hello world'),
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
    proc.stdout = Readable.from([resultEvent('done') + '\n']);
    proc.stderr = new Readable({ read() {} });
    proc.stdout.on('end', () => setImmediate(() => proc.emit('close', 1)));
    mockSpawn.mockReturnValue(proc);

    const backend = new CliBackend('claude-opus-4-6');
    await expect(backend.complete(baseRequest)).rejects.toThrow(/exited with code 1/);
  });
});

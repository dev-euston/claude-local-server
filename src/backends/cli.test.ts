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

const resultEvent = (text: string, sessionId?: string) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    ...(sessionId ? { session_id: sessionId } : {}),
  });

const errorResultEvent = (text: string) =>
  JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: text });

const toolUseAssistantEvent = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  msgId = 'msg_123',
) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      id: msgId,
      content: [{ type: 'tool_use', id, name, input }],
    },
  });

const toolResultEvent = (toolUseId: string, content: string | Array<unknown>) =>
  JSON.stringify({ type: 'tool_result', tool_use_id: toolUseId, content });

describe('CliBackend.stream', () => {
  it('yields text chunk from assistant event and stop chunk from result event', async () => {
    mockSpawn.mockReturnValue(makeFakeProcess([assistantEvent('Hi!'), resultEvent('Hi!')]));

    const backend = new CliBackend('claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);
    expect(chunks[0].type).toBe('text');
    if (chunks[0].type === 'text') expect(chunks[0].delta).toBe('Hi!');
    expect(chunks[0].finishReason).toBeNull();
    if (chunks[1].type === 'text') expect(chunks[1].delta).toBe('');
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
    if (chunks[0].type === 'text') expect(chunks[0].delta).toBe('A');
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
    if (chunks[0].type === 'text') expect(chunks[0].delta).toBe('B');
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
    mockSpawn.mockReturnValue(makeFakeProcess([errorResultEvent('something went wrong')]));

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

  it('passes system message via --system-prompt flag', async () => {
    mockSpawn.mockReturnValue(makeFakeProcess([resultEvent('')]));
    const backend = new CliBackend('claude-opus-4-6');
    for await (const _chunk of backend.stream({ ...baseRequest, system: 'Be brief.' })) {
      // consume
    }
    const args = mockSpawn.mock.calls[0][1] as string[];
    const sysIdx = args.indexOf('--system-prompt');
    expect(sysIdx).toBeGreaterThan(-1);
    expect(args[sysIdx + 1]).toBe('Be brief.');
  });

  it('places --system-prompt after --verbose in arg list', async () => {
    mockSpawn.mockReturnValue(makeFakeProcess([resultEvent('')]));
    const backend = new CliBackend('claude-opus-4-6');
    for await (const _chunk of backend.stream({ ...baseRequest, system: 'Be brief.' })) {
      // consume
    }
    const args = mockSpawn.mock.calls[0][1] as string[];
    const verboseIdx = args.indexOf('--verbose');
    const sysIdx = args.indexOf('--system-prompt');
    expect(sysIdx).toBeGreaterThan(-1);
    expect(sysIdx).toBeGreaterThan(verboseIdx);
  });

  it('does not include --system-prompt flag when system is not set', async () => {
    mockSpawn.mockReturnValue(makeFakeProcess([resultEvent('')]));
    const backend = new CliBackend('claude-opus-4-6');
    for await (const _chunk of backend.stream(baseRequest)) {
      // consume
    }
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args.includes('--system-prompt')).toBe(false);
  });

  it('skips empty lines in output', async () => {
    mockSpawn.mockReturnValue(makeFakeProcess(['', assistantEvent('X'), resultEvent('X')]));

    const backend = new CliBackend('claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }
    if (chunks[0].type === 'text') expect(chunks[0].delta).toBe('X');
  });

  it('handles assistant events without id or content fields', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([
        JSON.stringify({ type: 'assistant', message: {} }),
        JSON.stringify({
          type: 'assistant',
          message: { id: 'msg_xyz', content: [{ type: 'image', url: 'data:...' }] },
        }),
        assistantEvent('Final'),
        resultEvent('Final'),
      ]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    if (chunks[0].type === 'text') expect(chunks[0].delta).toBe('Final');
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
    mockSpawn.mockReturnValue(makeFakeProcess([assistantEvent('Hi'), resultEvent('Hi')]));
    const backend = new CliBackend(undefined);
    const result = await backend.complete(baseRequest);
    expect(result.model).toBe('claude');
  });
});

describe('CliBackend.complete', () => {
  it('accumulates stream chunks into a NormalizedResponse', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([assistantEvent('Hello world'), resultEvent('Hello world')]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    const result = await backend.complete(baseRequest);
    expect(result.content).toBe('Hello world');
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.promptTokens).toBe(0);
    expect(result.completionTokens).toBe(0);
  });

  it('ignores non-text chunks when accumulating complete() response', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([
        toolUseAssistantEvent('toolu_001', 'bash', { cmd: 'ls' }, 'msg_abc'),
        toolResultEvent('toolu_001', 'file.txt'),
        assistantEvent('Done', 'msg_abc'),
        resultEvent('Done'),
      ]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    const result = await backend.complete(baseRequest);
    // Only text chunks contribute to content; tool_call_start/delta/result are skipped
    expect(result.content).toBe('Done');
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

describe('CliBackend.stream — tool events', () => {
  it('yields ToolCallStartChunk and ToolCallDeltaChunk for tool_use block in assistant event', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([
        toolUseAssistantEvent('toolu_001', 'bash', { cmd: 'ls' }, 'msg_abc'),
        resultEvent('done'),
      ]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }

    // ToolCallStartChunk, ToolCallDeltaChunk, terminal TextChunk
    expect(chunks).toHaveLength(3);
    expect(chunks[0].type).toBe('tool_call_start');
    if (chunks[0].type === 'tool_call_start') {
      expect(chunks[0].toolCallId).toBe('toolu_001');
      expect(chunks[0].name).toBe('bash');
      expect(chunks[0].toolIndex).toBe(0);
      expect(chunks[0].id).toContain('msg_abc');
    }
    expect(chunks[1].type).toBe('tool_call_delta');
    if (chunks[1].type === 'tool_call_delta') {
      expect(chunks[1].toolCallId).toBe('toolu_001');
      expect(chunks[1].toolIndex).toBe(0);
      expect(JSON.parse(chunks[1].argumentsDelta)).toEqual({ cmd: 'ls' });
    }
    expect(chunks[2].type).toBe('text');
    if (chunks[2].type === 'text') {
      expect(chunks[2].finishReason).toBe('stop');
    }
  });

  it('increments toolIndex for sequential tool calls', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_seq',
            content: [
              { type: 'tool_use', id: 'toolu_001', name: 'bash', input: { cmd: 'ls' } },
              { type: 'tool_use', id: 'toolu_002', name: 'read', input: { file: 'x' } },
            ],
          },
        }),
        resultEvent('done'),
      ]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }

    const starts = chunks.filter((c) => c.type === 'tool_call_start');
    expect(starts).toHaveLength(2);
    if (starts[0].type === 'tool_call_start') expect(starts[0].toolIndex).toBe(0);
    if (starts[1].type === 'tool_call_start') expect(starts[1].toolIndex).toBe(1);
  });

  it('yields ToolResultChunk for tool_result event with string content', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([
        toolUseAssistantEvent('toolu_001', 'bash', { cmd: 'ls' }, 'msg_abc'),
        toolResultEvent('toolu_001', 'file1.txt\nfile2.txt'),
        resultEvent('done'),
      ]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }

    const toolResult = chunks.find((c) => c.type === 'tool_result');
    expect(toolResult).toBeDefined();
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.toolCallId).toBe('toolu_001');
      expect(toolResult.content).toBe('file1.txt\nfile2.txt');
      expect(toolResult.id).toContain('msg_abc');
    }
  });

  it('joins text blocks in array tool result content', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([
        toolUseAssistantEvent('toolu_001', 'bash', {}, 'msg_abc'),
        toolResultEvent('toolu_001', [
          { type: 'text', text: 'line1' },
          { type: 'image', source: 'data:...' },
          { type: 'text', text: 'line2' },
        ]),
        resultEvent('done'),
      ]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }

    const toolResult = chunks.find((c) => c.type === 'tool_result');
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.content).toBe('line1\nline2');
    }
  });

  it('yields ToolResultChunk with empty content for unexpected content type', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([
        toolUseAssistantEvent('toolu_001', 'bash', { cmd: 'ls' }, 'msg_abc'),
        toolResultEvent('toolu_001', null as unknown as string),
        resultEvent('done'),
      ]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }

    const toolResult = chunks.find((c) => c.type === 'tool_result');
    expect(toolResult).toBeDefined();
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.content).toBe('');
    }
  });

  it('does not yield ToolCallDeltaChunk when tool input is empty', async () => {
    mockSpawn.mockReturnValue(
      makeFakeProcess([toolUseAssistantEvent('toolu_001', 'bash', {}), resultEvent('done')]),
    );

    const backend = new CliBackend('claude-opus-4-6');
    const chunks = [];
    for await (const chunk of backend.stream(baseRequest)) {
      chunks.push(chunk);
    }

    expect(chunks.filter((c) => c.type === 'tool_call_delta')).toHaveLength(0);
    expect(chunks.filter((c) => c.type === 'tool_call_start')).toHaveLength(1);
  });
});

describe('CliBackend.stream — sessions', () => {
  it('session lifecycle: first call uses full prompt; second call uses --resume with bare content', async () => {
    const backend = new CliBackend('claude-opus-4-6');

    // Call 1: session miss — full prompt, no --resume
    mockSpawn.mockReturnValue(
      makeFakeProcess([assistantEvent('Hi'), resultEvent('Hi', 'claude-sess-1')]),
    );
    for await (const _ of backend.stream({
      ...baseRequest,
      messages: [{ role: 'user', content: 'Hello' }],
      sessionId: 'client-sess-1',
    })) {
    }

    const call1Args = mockSpawn.mock.calls[0][1] as string[];
    expect(call1Args[1]).toContain('Human: Hello'); // full prompt via buildPrompt
    expect(call1Args).not.toContain('--resume');

    // Call 2: session hit — bare content only, --resume claude-sess-1
    vi.clearAllMocks();
    mockSpawn.mockReturnValue(
      makeFakeProcess([assistantEvent('Fine'), resultEvent('Fine', 'claude-sess-2')]),
    );
    for await (const _ of backend.stream({
      ...baseRequest,
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'How are you?' },
      ],
      sessionId: 'client-sess-1',
    })) {
    }

    const call2Args = mockSpawn.mock.calls[0][1] as string[];
    expect(call2Args[1]).toBe('How are you?'); // bare content — no "Human: " prefix
    const resumeIdx = call2Args.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(call2Args[resumeIdx + 1]).toBe('claude-sess-1'); // stored from call 1
  });

  it('no sessionId: stateless path — no --resume, no session stored', async () => {
    const backend = new CliBackend('claude-opus-4-6');
    mockSpawn.mockReturnValue(
      makeFakeProcess([assistantEvent('Hi'), resultEvent('Hi', 'claude-sess-x')]),
    );
    for await (const _ of backend.stream(baseRequest)) {
    }

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain('--resume');

    // Subsequent call without sessionId also has no --resume
    vi.clearAllMocks();
    mockSpawn.mockReturnValue(makeFakeProcess([resultEvent('')]));
    for await (const _ of backend.stream(baseRequest)) {
    }
    expect(mockSpawn.mock.calls[0][1] as string[]).not.toContain('--resume');
  });

  it('stale map entry persists when resume returns is_error: true', async () => {
    const backend = new CliBackend('claude-opus-4-6');

    // Call 1: populate map with known session ID
    mockSpawn.mockReturnValue(makeFakeProcess([resultEvent('', 'claude-sess-old')]));
    for await (const _ of backend.stream({ ...baseRequest, sessionId: 'my-sess' })) {
    }

    // Call 2: resume fails
    vi.clearAllMocks();
    mockSpawn.mockReturnValue(
      makeFakeProcess([
        JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'bad session' }),
      ]),
    );
    await expect(async () => {
      for await (const _ of backend.stream({
        ...baseRequest,
        messages: [{ role: 'user', content: 'Hi again' }],
        sessionId: 'my-sess',
      })) {
      }
    }).rejects.toThrow(/bad session/);

    // Call 3: stale entry still used — --resume still points to claude-sess-old
    vi.clearAllMocks();
    mockSpawn.mockReturnValue(makeFakeProcess([resultEvent('')]));
    for await (const _ of backend.stream({
      ...baseRequest,
      messages: [{ role: 'user', content: 'Try again' }],
      sessionId: 'my-sess',
    })) {
    }
    const call3Args = mockSpawn.mock.calls[0][1] as string[];
    const resumeIdx = call3Args.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(call3Args[resumeIdx + 1]).toBe('claude-sess-old'); // unchanged
  });

  it('throws before spawning when last message is not user-role on resume', async () => {
    const backend = new CliBackend('claude-opus-4-6');

    // Populate the session map
    mockSpawn.mockReturnValue(makeFakeProcess([resultEvent('', 'sess-1')]));
    for await (const _ of backend.stream({ ...baseRequest, sessionId: 'my-sess' })) {
    }

    vi.clearAllMocks();
    await expect(async () => {
      for await (const _ of backend.stream({
        ...baseRequest,
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi' }, // last message is assistant
        ],
        sessionId: 'my-sess',
      })) {
      }
    }).rejects.toThrow();

    expect(mockSpawn).not.toHaveBeenCalled(); // no process spawned
  });

  it('throws before spawning when message list is empty on resume', async () => {
    const backend = new CliBackend('claude-opus-4-6');

    // Populate session map
    mockSpawn.mockReturnValue(makeFakeProcess([resultEvent('', 'sess-1')]));
    for await (const _ of backend.stream({ ...baseRequest, sessionId: 'my-sess' })) {
    }

    vi.clearAllMocks();
    await expect(async () => {
      for await (const _ of backend.stream({
        ...baseRequest,
        messages: [],
        sessionId: 'my-sess',
      })) {
      }
    }).rejects.toThrow(/empty message list/);

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('falls back to new-session path when result event has no session_id', async () => {
    const backend = new CliBackend('claude-opus-4-6');

    // Call 1: result event has no session_id — map NOT populated
    mockSpawn.mockReturnValue(
      makeFakeProcess([assistantEvent('Hi'), resultEvent('Hi')]), // no sessionId arg
    );
    for await (const _ of backend.stream({ ...baseRequest, sessionId: 'my-sess' })) {
    }

    // Call 2: still a miss — full prompt, no --resume
    vi.clearAllMocks();
    mockSpawn.mockReturnValue(makeFakeProcess([resultEvent('')]));
    for await (const _ of backend.stream({
      ...baseRequest,
      messages: [{ role: 'user', content: 'Follow up' }],
      sessionId: 'my-sess',
    })) {
    }

    const call2Args = mockSpawn.mock.calls[0][1] as string[];
    expect(call2Args).not.toContain('--resume');
  });

  it('hasSession returns false before first call and true after session is stored', async () => {
    const backend = new CliBackend('claude-opus-4-6');

    expect(backend.hasSession('my-sess')).toBe(false);

    mockSpawn.mockReturnValue(makeFakeProcess([resultEvent('', 'claude-sess-1')]));
    for await (const _ of backend.stream({ ...baseRequest, sessionId: 'my-sess' })) {
    }

    expect(backend.hasSession('my-sess')).toBe(true);
    expect(backend.hasSession('other-sess')).toBe(false);
  });

  it('deleteSession removes the entry and returns true; returns false when not found', async () => {
    const backend = new CliBackend('claude-opus-4-6');

    expect(backend.deleteSession('nonexistent')).toBe(false);

    mockSpawn.mockReturnValue(makeFakeProcess([resultEvent('', 'claude-sess-1')]));
    for await (const _ of backend.stream({ ...baseRequest, sessionId: 'my-sess' })) {
    }

    expect(backend.hasSession('my-sess')).toBe(true);
    expect(backend.deleteSession('my-sess')).toBe(true);
    expect(backend.hasSession('my-sess')).toBe(false);
    expect(backend.deleteSession('my-sess')).toBe(false);
  });

  it('--system-prompt appears after --resume in canonical arg order', async () => {
    const backend = new CliBackend('claude-opus-4-6');

    // Establish session
    mockSpawn.mockReturnValue(makeFakeProcess([resultEvent('', 'sess-1')]));
    for await (const _ of backend.stream({ ...baseRequest, sessionId: 'my-sess' })) {
    }

    // Resume with system prompt
    vi.clearAllMocks();
    mockSpawn.mockReturnValue(makeFakeProcess([resultEvent('')]));
    for await (const _ of backend.stream({
      ...baseRequest,
      messages: [{ role: 'user', content: 'Hi' }],
      system: 'Be brief.',
      sessionId: 'my-sess',
    })) {
    }

    const args = mockSpawn.mock.calls[0][1] as string[];
    const resumeIdx = args.indexOf('--resume');
    const sysIdx = args.indexOf('--system-prompt');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(sysIdx).toBeGreaterThan(resumeIdx);
  });

  it('listSessions returns empty array before any sessions are stored', () => {
    const backend = new CliBackend('claude-opus-4-6');
    expect(backend.listSessions()).toEqual([]);
  });

  it('listSessions returns session id and lastUsed after a successful stream', async () => {
    const backend = new CliBackend('claude-opus-4-6');
    const before = new Date();
    mockSpawn.mockReturnValue(makeFakeProcess([assistantEvent('Hi'), resultEvent('Hi', 'claude-sess-1')]));
    for await (const _ of backend.stream({ ...baseRequest, sessionId: 'my-sess' })) {}
    const after = new Date();

    const list = backend.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('my-sess');
    expect(list[0].lastUsed.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(list[0].lastUsed.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('getSession returns undefined for unknown id', () => {
    const backend = new CliBackend('claude-opus-4-6');
    expect(backend.getSession('nope')).toBeUndefined();
  });

  it('getSession returns full history including assistant response after stream', async () => {
    const backend = new CliBackend('claude-opus-4-6');
    mockSpawn.mockReturnValue(makeFakeProcess([assistantEvent('Hello!'), resultEvent('Hello!', 'claude-sess-1')]));
    for await (const _ of backend.stream({
      ...baseRequest,
      messages: [{ role: 'user', content: 'Hi' }],
      sessionId: 'my-sess',
    })) {}

    const session = backend.getSession('my-sess');
    expect(session).toBeDefined();
    expect(session!.id).toBe('my-sess');
    expect(session!.messages).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ]);
  });

  it('getSession updates lastUsed and appends history on each resume', async () => {
    const backend = new CliBackend('claude-opus-4-6');

    // Call 1
    mockSpawn.mockReturnValue(makeFakeProcess([assistantEvent('Hi'), resultEvent('Hi', 'claude-sess-1')]));
    for await (const _ of backend.stream({
      ...baseRequest,
      messages: [{ role: 'user', content: 'Hello' }],
      sessionId: 'my-sess',
    })) {}
    const firstLastUsed = backend.getSession('my-sess')!.lastUsed;

    // Call 2 (resume)
    vi.clearAllMocks();
    mockSpawn.mockReturnValue(makeFakeProcess([assistantEvent('Fine'), resultEvent('Fine', 'claude-sess-2')]));
    for await (const _ of backend.stream({
      ...baseRequest,
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'How are you?' },
      ],
      sessionId: 'my-sess',
    })) {}

    const session = backend.getSession('my-sess')!;
    expect(session.messages).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'How are you?' },
      { role: 'assistant', content: 'Fine' },
    ]);
    expect(session.lastUsed.getTime()).toBeGreaterThanOrEqual(firstLastUsed.getTime());
  });
});

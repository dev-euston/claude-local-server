import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import type {
  BackendDriver,
  NormalizedRequest,
  NormalizedResponse,
  NormalizedChunk,
} from './types.js';

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

    // Register close listener BEFORE readline loop to guarantee we never miss the event
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

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
    private model: string | undefined,
    private claudePath: string = 'claude',
  ) {}

  async *stream(request: NormalizedRequest): AsyncIterable<NormalizedChunk> {
    const prompt = buildPrompt(request.messages);
    let id = `chatcmpl-${randomUUID()}`;

    const args = ['-p', prompt];
    if (request.system !== undefined) args.push('--system-prompt', request.system);
    args.push('--output-format', 'stream-json', '--verbose');

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

      if (event['type'] === 'assistant') {
        const message = event['message'] as Record<string, unknown> | undefined;
        if (message?.['id']) id = `chatcmpl-${message['id'] as string}`;
        const content = message?.['content'] as Array<Record<string, unknown>> | undefined;
        if (content) {
          for (const block of content) {
            if (block['type'] === 'text' && typeof block['text'] === 'string') {
              yield { id, delta: block['text'] as string, finishReason: null };
            }
          }
        }
      } else if (event['type'] === 'result') {
        if (event['is_error']) {
          throw new Error(`claude CLI error: ${event['result'] as string}`);
        }
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

    return { id, model: this.model ?? 'claude', content, promptTokens: 0, completionTokens: 0 };
  }
}

function buildPrompt(messages: NormalizedRequest['messages']): string {
  // System messages are handled via --system-prompt flag, not injected here
  return messages
    .map((m) => {
      const prefix = m.role === 'assistant' ? 'Assistant' : 'Human';
      return `${prefix}: ${m.content}`;
    })
    .join('\n');
}

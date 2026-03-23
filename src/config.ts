import { readFileSync } from 'fs';
import { z } from 'zod';

const ApiConfigSchema = z.object({
  apiKey: z.string().min(1),
  model: z.string().min(1),
});

const CliConfigSchema = z.object({
  model: z.string().min(1).optional(),
  claudePath: z.string().min(1).default('claude'),
});

const ConfigSchema = z
  .object({
    backend: z.enum(['api', 'cli']),
    host: z.string().default('127.0.0.1'),
    port: z.number().int().positive().default(3000),
    api: ApiConfigSchema.optional(),
    cli: CliConfigSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.backend === 'api' && !data.api) {
      ctx.addIssue({
        code: 'custom',
        message: 'api block is required when backend is "api"',
        path: ['api'],
      });
    }
    if (data.backend === 'cli' && !data.cli) {
      ctx.addIssue({
        code: 'custom',
        message: 'cli block is required when backend is "cli"',
        path: ['cli'],
      });
    }
  });

type ApiConfig = z.infer<typeof ApiConfigSchema>;
type CliConfig = z.infer<typeof CliConfigSchema>;

export type Config =
  | { backend: 'api'; host: string; port: number; api: ApiConfig; cli?: CliConfig }
  | { backend: 'cli'; host: string; port: number; api?: ApiConfig; cli: CliConfig };

export function loadConfig(configPath: string): Config {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    throw new Error(`Config file not found: ${configPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Config file is not valid JSON: ${(err as Error).message}`);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid config: ${result.error.message}`);
  }
  return result.data as Config;
}

import { pathToFileURL } from 'url';
import { loadConfig } from './config.js';
import { buildApp } from './server.js';

export function getConfigPath(argv: string[]): string {
  const idx = argv.indexOf('--config');
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  return 'config.json';
}

/* c8 ignore next -- main() is only called when run as entry point, not in tests */
async function main(): Promise<void> {
  /* c8 ignore next */
  const configPath = getConfigPath(process.argv);

  /* c8 ignore next */
  let config;
  /* c8 ignore next */
  try {
    /* c8 ignore next */
    config = loadConfig(configPath);
  } catch (err) {
    /* c8 ignore next */
    process.stderr.write(
      /* c8 ignore next */
      `Failed to load config from "${configPath}": ${(err as Error).message}\n`,
    );
    /* c8 ignore next */
    process.exit(1);
  }

  /* c8 ignore next */
  const app = await buildApp(config);
  /* c8 ignore next */
  await app.listen({ host: config.host, port: config.port });
  /* c8 ignore next */
  process.stdout.write(`claude-local-server listening on ${config.host}:${config.port}\n`);
}

/* c8 ignore next */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  /* c8 ignore next */
  main().catch((err: unknown) => {
    /* c8 ignore next */
    process.stderr.write(`Fatal: ${(err as Error).message}\n`);
    /* c8 ignore next */
    process.exit(1);
  });
}

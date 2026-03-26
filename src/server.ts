import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { timingSafeEqual } from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { BackendDriver } from './backends/types.js';
import { ApiBackend } from './backends/api.js';
import { CliBackend } from './backends/cli.js';
import { registerModelsRoute } from './routes/models.js';
import { registerChatRoute } from './routes/chat.js';
import { registerSessionsRoute } from './routes/sessions.js';

/* c8 ignore next 5 — only called when no driver override is provided; all tests inject a mock */
function createDriver(config: Config): BackendDriver {
  if (config.backend === 'api') {
    return new ApiBackend(config.api.apiKey, config.api.model);
  }
  return new CliBackend(config.cli.model, config.cli.claudePath);
}

export async function buildApp(config: Config, driver?: BackendDriver): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel ?? 'info' } });
  await app.register(sensible);

  const activeDriver = driver ?? createDriver(config);

  if (config.apiKey) {
    const expected = Buffer.from(`Bearer ${config.apiKey}`);
    app.addHook('onRequest', async (request, reply) => {
      const auth = request.headers.authorization ?? '';
      const actual = Buffer.from(auth);
      const match = actual.length === expected.length && timingSafeEqual(actual, expected);
      if (!match) {
        await reply.status(401).send({ error: 'Unauthorized' });
      }
    });
  }

  registerModelsRoute(app, config);
  registerChatRoute(app, config, activeDriver);
  registerSessionsRoute(app, activeDriver);

  await app.ready();
  return app;
}

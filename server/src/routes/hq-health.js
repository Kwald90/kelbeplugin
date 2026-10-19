// HQ developer health: GET /api/hq/dev-health, plus the in-process metrics collector it
// reports from. The plugin skips encapsulation so its onResponse hook sees every route.
import { createMetrics } from '../services/hq-metrics.js';
import { devHealth, healthLevel } from '../services/hq-health.js';
import { hqSettings } from '../services/hq-common.js';

/** @param {import('fastify').FastifyInstance} app */
async function hqHealthRoutes(app, { config, db }) {
  const metrics = createMetrics();
  const settings = hqSettings(config);
  app.decorate('hqMetrics', metrics);

  // Route pattern only (never the URL with ids or query), status and time.
  app.addHook('onResponse', async (req, reply) => {
    metrics.record(reply.statusCode, reply.elapsedTime, `${req.method} ${req.routeOptions?.url || 'unmatched'}`);
  });

  app.get('/api/hq/dev-health', {
    config: { auth: 'hq' },
    schema: { tags: ['hq'], summary: 'Developer health: versions, database, migrations, queue, backups, deploys, errors, TLS, disk, memory, environments' },
  }, async () => {
    const h = await devHealth({ config, db, settings, metrics });
    return { ...h, summary: healthLevel(h) };
  });
}

// Same effect as fastify-plugin: hooks and decorators apply to the whole app.
hqHealthRoutes[Symbol.for('skip-override')] = true;
hqHealthRoutes[Symbol.for('fastify.display-name')] = 'hq-health';

export default hqHealthRoutes;

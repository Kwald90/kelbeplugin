// /api/mcp: the Model Context Protocol endpoint (Streamable HTTP, stateless, JSON
// responses). Authenticated by a company API key (Authorization: Bearer ft_live_… /
// ft_test_…) whose scopes decide the tools; Business plan feature `mcp`; rate limited per
// key. Protocol handling is in src/ai/mcp.js; how to connect clients is in docs/ai/mcp.md.
import { ApiError } from '../errors.js';
import { apiKeyPrincipal } from '../auth/guard.js';
import { sha256 } from '../lib/crypto.js';
import { requestFacts } from '../services/audit.js';
import { assertFeature } from '../services/entitlements.js';
import { readAiConfig } from '../ai/config.js';
import { PROTOCOL_VERSIONS, createMcp } from '../ai/mcp.js';

/** @param {import('fastify').FastifyInstance} app */
export default async function mcpRoutes(app, { db, records, config }) {
  const aiCfg = readAiConfig();
  const mcp = createMcp({ db, records, config });
  const limit = config.rateLimit.enabled
    ? { max: aiCfg.mcpPerMinute, timeWindow: '1 minute', keyGenerator: (req) => `mcp:${sha256(String(req.headers.authorization || req.ip)).toString('hex').slice(0, 32)}` }
    : false;

  function principalFor(req) {
    const origin = req.headers.origin;
    // DNS-rebinding guard from the MCP spec: browsers may only call from our own origins.
    if (origin !== undefined && !config.corsOrigins.includes(origin)) throw new ApiError(403, 'forbidden', 'This origin may not call the MCP endpoint.');
    if (!req.auth?.apiKey) {
      throw new ApiError(401, 'unauthenticated', 'Send a company API key: Authorization: Bearer ft_live_… (create one in Settings, API keys).');
    }
    const v = req.headers['mcp-protocol-version'];
    if (v !== undefined && !PROTOCOL_VERSIONS.includes(String(v))) throw new ApiError(400, 'bad_request', 'Unsupported MCP-Protocol-Version.');
    return apiKeyPrincipal(req.auth.apiKey);
  }

  app.post('/api/mcp', { config: { auth: 'public', rateLimit: limit }, schema: { hide: true } }, async (req, reply) => {
    const p = principalFor(req);
    await assertFeature(db, p.tenantId, 'mcp');
    const r = await mcp.post(p, req.body, requestFacts(req));
    reply.code(r.status);
    if (r.body === undefined) return reply.send();
    reply.header('content-type', 'application/json; charset=utf-8');
    return r.body;
  });

  // No server-initiated stream and no sessions: GET and DELETE are not offered (spec: 405).
  const notAllowed = async (req, reply) => {
    principalFor(req);
    reply.code(405).header('allow', 'POST');
    return { error: { code: 'method_not_allowed', message: 'The MCP endpoint takes POST only (no SSE stream, no sessions).', requestId: req.id } };
  };
  app.get('/api/mcp', { config: { auth: 'public', rateLimit: limit }, schema: { hide: true } }, notAllowed);
  app.delete('/api/mcp', { config: { auth: 'public', rateLimit: limit }, schema: { hide: true } }, notAllowed);
}

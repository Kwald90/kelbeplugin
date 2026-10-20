// /api/v1/sync/push and /api/v1/sync/pull: the offline-first sync protocol (adr-002).
import { COLLECTIONS } from '../../collections.js';
import { MAX_PULL_LIMIT } from '../../services/records.js';
import { errorResponses, tenantCtx, who } from '../util.js';

export const MAX_MUTATIONS = 500;

const mutation = {
  type: 'object',
  required: ['mid', 'collection', 'id', 'op'],
  properties: {
    mid: { type: 'string', description: 'Client-generated mutation id; the same mid is never applied twice.' },
    collection: { type: 'string', enum: COLLECTIONS },
    id: { type: 'string' },
    op: { type: 'string', enum: ['upsert', 'delete'] },
    baseVersion: { type: ['integer', 'null'], description: 'Server version the client edited; null for a new record.' },
    data: { type: 'object', description: 'The whole record (upsert). Validated against the collection JSON Schema.' },
    itemMerge: { type: 'boolean', description: 'True from an app that records deleted drawing items as tombstones: a drawing write then merges item by item. Without it a drawing write is last-writer-wins.' },
    fields: { type: ['array', 'null'], items: { type: 'string' }, description: 'The top-level fields this client changed (null or absent: the whole record). A stale time-entry write that only reviews or approves applies just those fields.' },
  },
};

const result = {
  type: 'object',
  properties: {
    mid: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['ok', 'conflict', 'rejected'] },
    version: { type: ['integer', 'null'] },
    changeSeq: { type: ['integer', 'null'] },
    server: { type: 'object', description: 'On conflict: the winning server copy { id, version, deleted, data }.' },
    error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } },
  },
};

/** @param {import('fastify').FastifyInstance} app */
export default async function syncRoutes(app, { db, records, bodyLimit }) {
  app.post('/api/v1/sync/push', {
    bodyLimit,
    config: { auth: 'tenant' },
    schema: {
      tags: ['sync'], summary: 'Push local changes',
      description: 'Applied in order, each on its own; idempotent by mid; last writer wins per record (by the record\'s updatedAt), the loser is kept in history.',
      // Items are checked one by one in the handler so one bad mutation is rejected, not the batch.
      body: { type: 'object', required: ['mutations'], additionalProperties: false, properties: { mutations: { type: 'array', maxItems: MAX_MUTATIONS, items: { type: 'object' } } } },
      response: { 200: { type: 'object', properties: { results: { type: 'array', items: result } } }, ...errorResponses },
    },
  }, async (req) => {
    const p = req.principal;
    const results = await db.withTenant(tenantCtx(p), (tx) => records.push(tx, p, req.body.mutations, who(req)), { write: true });
    return { results };
  });

  app.get('/api/v1/sync/pull', {
    config: { auth: 'tenant' },
    schema: {
      tags: ['sync'], summary: 'Pull changes since a cursor',
      description: 'Changes in change order across every collection you may read. Start with since=0; repeat with the returned cursor while more is true.',
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { since: { type: 'string', pattern: '^\\d{1,18}$', default: '0' }, limit: { type: 'integer', minimum: 1, maximum: MAX_PULL_LIMIT, default: 500 } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            changes: { type: 'array', items: { type: 'object', properties: { collection: { type: 'string' }, id: { type: 'string' }, version: { type: 'integer' }, deleted: { type: 'boolean' }, data: { type: ['object', 'null'] } } } },
            cursor: { type: 'string' },
            more: { type: 'boolean' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const p = req.principal;
    return db.withTenant(tenantCtx(p), (tx) => records.pull(tx, p, { since: req.query.since, limit: req.query.limit }), { isolation: 'REPEATABLE READ' });
  });
}

// /api/v1/{collection}: REST CRUD for every collection (auditLog is read-only).
import { ApiError } from '../../errors.js';
import { AUDIT_COLLECTION, COLLECTIONS, collectionDef, filterFields } from '../../collections.js';
import { MAX_LIST_LIMIT } from '../../services/records.js';
import { errorResponses, tenantCtx, who } from '../util.js';

const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 128 } } };

function listQuery(coll) {
  const props = {
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: 50 },
    cursor: { type: 'string', maxLength: 1000 },
  };
  if (coll === AUDIT_COLLECTION) {
    for (const f of ['collection', 'recordId', 'action']) props[f] = { type: 'string', maxLength: 200 };
  } else {
    props.includeDeleted = { type: 'boolean', default: false };
    for (const f of filterFields(collectionDef(coll))) props[f] = { type: 'string', maxLength: 200 };
  }
  return { type: 'object', additionalProperties: false, properties: props };
}

/** Optimistic concurrency: If-Match: <version> header or ?version=<n>. */
function ifVersion(req) {
  const h = req.headers['if-match'];
  const raw = h !== undefined ? String(h).replace(/^W\//, '').replace(/"/g, '') : req.query?.version;
  if (raw === undefined || raw === '' || raw === '*') return null;
  if (!/^\d{1,15}$/.test(String(raw))) throw new ApiError(400, 'bad_request', 'If-Match must be a record version number.');
  return Number(raw);
}

/** @param {import('fastify').FastifyInstance} app */
export default async function recordRoutes(app, { db, records, bodyLimit }) {
  for (const coll of COLLECTIONS) {
    const base = `/api/v1/${coll}`;
    const ref = { $ref: `record.${coll}#` };
    const tags = [coll];
    const filters = coll === AUDIT_COLLECTION ? ['collection', 'recordId', 'action'] : filterFields(collectionDef(coll));

    app.get(base, {
      config: { auth: 'tenant' },
      schema: {
        tags, summary: `List ${coll}`, description: `Newest first. Filters: ${filters.join(', ') || 'none'}. Pass the returned cursor to get the next page.`,
        querystring: listQuery(coll),
        response: { 200: { type: 'object', properties: { data: { type: 'array', items: ref }, cursor: { type: ['string', 'null'] }, more: { type: 'boolean' } } }, ...errorResponses },
      },
    }, async (req) => {
      const p = req.principal;
      const { limit, cursor, includeDeleted, ...rest } = req.query;
      return db.withTenant(tenantCtx(p), (tx) => records.listRecords(tx, p, coll, { limit, cursor, includeDeleted, filters: rest }));
    });

    app.get(`${base}/:id`, {
      config: { auth: 'tenant' },
      schema: { tags, summary: `Get one ${coll} record`, params: idParam, response: { 200: ref, ...errorResponses } },
    }, async (req) => {
      const p = req.principal;
      return db.withTenant(tenantCtx(p), (tx) => records.getRecord(tx, p, coll, req.params.id));
    });

    if (coll === AUDIT_COLLECTION) {
      const readOnly = async () => { throw new ApiError(405, 'method_not_allowed', 'The audit log is append-only and written by the server.'); };
      app.post(base, { config: { auth: 'tenant' }, schema: { hide: true } }, readOnly);
      app.patch(`${base}/:id`, { config: { auth: 'tenant' }, schema: { hide: true } }, readOnly);
      app.delete(`${base}/:id`, { config: { auth: 'tenant' }, schema: { hide: true } }, readOnly);
      continue;
    }

    const limit = Math.max(collectionDef(coll).maxBytes * 2, 1024 * 1024);

    app.post(base, {
      bodyLimit: Math.min(limit, bodyLimit),
      config: { auth: 'tenant' },
      schema: {
        tags, summary: `Create a ${coll} record`, description: 'The id is optional (a UUID is generated). Validated against the collection JSON Schema.',
        body: { type: 'object' }, response: { 201: ref, ...errorResponses },
      },
    }, async (req, reply) => {
      const p = req.principal;
      const rec = await db.withTenant(tenantCtx(p), (tx) => records.createRecord(tx, p, coll, req.body, who(req)), { write: true });
      reply.code(201);
      return rec;
    });

    app.patch(`${base}/:id`, {
      bodyLimit: Math.min(limit, bodyLimit),
      config: { auth: 'tenant' },
      schema: {
        tags, summary: `Update a ${coll} record (shallow merge)`, description: 'Send If-Match: <version> to fail with 409 if someone else changed it first.',
        params: idParam, body: { type: 'object' }, querystring: { type: 'object', properties: { version: { type: 'string' } } },
        response: { 200: ref, ...errorResponses },
      },
    }, async (req) => {
      const p = req.principal;
      const v = ifVersion(req);
      return db.withTenant(tenantCtx(p), (tx) => records.patchRecord(tx, p, coll, req.params.id, req.body, { ifVersion: v }, who(req)), { write: true });
    });

    app.delete(`${base}/:id`, {
      config: { auth: 'tenant' },
      schema: {
        tags, summary: `Delete a ${coll} record (soft delete; syncs as a tombstone)`, params: idParam,
        querystring: { type: 'object', properties: { version: { type: 'string' } } },
        response: { 200: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'integer' }, deleted: { type: 'boolean' } } }, ...errorResponses },
      },
    }, async (req) => {
      const p = req.principal;
      const v = ifVersion(req);
      return db.withTenant(tenantCtx(p), (tx) => records.deleteRecord(tx, p, coll, req.params.id, { ifVersion: v }, who(req)), { write: true });
    });
  }
}

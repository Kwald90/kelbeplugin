// Landing-page promotions and their media (services/promotions.js has the rules).
//   GET    /api/v1/public/promotions/active      the one promotion to show now (public, cached briefly)
//   GET    /api/hq/promotions                    HQ admin: all promotions, which one is serving, the built-in default
//   GET    /api/hq/promotions/:id
//   POST   /api/hq/promotions                    create (draft unless status says otherwise)
//   PUT    /api/hq/promotions/:id                replace (send `version` to refuse a stale edit)
//   POST   /api/hq/promotions/:id/duplicate      copy as a draft
//   POST   /api/hq/promotions/:id/status         activate, deactivate or back to draft
//   DELETE /api/hq/promotions/:id
//   GET    /api/hq/media                         uploaded files
//   POST   /api/hq/media                         upload one file as the raw body (Content-Type = its type)
//   DELETE /api/hq/media/:name
// Every HQ route is HQ admin only and every write is audited on the platform chain.
import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { ApiError, conflict, notFound } from '../errors.js';
import { hqAudit, requireHqAdmin, uuidParams } from '../services/hq-common.js';
import {
  DEFAULT_PROMOTION, PROMOTION_BODY_SCHEMA, UPLOAD_CONTENT_TYPES, cleanLabel, createLiveCache, hqView, mediaPath, mediaSettings,
  parseAudienceTags, promotionSettings, publicView, receiveUpload, selectActive, validatePromotion,
} from '../services/promotions.js';

const SELECT = `SELECT p.*, cu.display_name AS created_by_name, uu.display_name AS updated_by_name
                  FROM promotions p LEFT JOIN users cu ON cu.id = p.created_by LEFT JOIN users uu ON uu.id = p.updated_by`;

/** @param {import('fastify').FastifyInstance} app */
export default async function promotionRoutes(app, { config, db }) {
  const settings = promotionSettings(config);
  const media = mediaSettings(config);
  const tags = ['hq'];
  const live = createLiveCache({
    ttlMs: settings.cacheSeconds * 1000,
    load: async () => (await db.query('SELECT id, starts_at, ends_at, priority, audience, overlay, slides, settings, updated_at FROM promotions_public')).rows,
  });

  // Raw upload bodies: leave the stream for the handler (it enforces type and size itself).
  // Scoped to this plugin, so no other route accepts these types.
  app.addContentTypeParser(UPLOAD_CONTENT_TYPES, (req, payload, done) => done(null));

  // ---- public ------------------------------------------------------------------------------

  app.get('/api/v1/public/promotions/active', {
    config: { auth: 'public' },
    // Part of the marketing site, not the developer API, so it stays out of openapi.json.
    // `audience` carries codes like province=ON or campaign=spring-show, never personal data.
    schema: { hide: true, querystring: { type: 'object', properties: { audience: { type: 'string', maxLength: 300 } } } },
  }, async (req, reply) => {
    let chosen = null;
    try {
      chosen = selectActive(await live.get(), { now: new Date(), tags: parseAudienceTags(req.query.audience) });
    } catch (err) {
      // The landing page must never break: show the built-in promotion and say why in the log.
      req.log.warn({ err: { message: err.message, code: err.code } }, 'promotions unavailable; serving the default');
    }
    const body = { promotion: publicView(chosen || DEFAULT_PROMOTION) };
    const etag = `W/"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 27)}"`;
    // Fishtape's own marketing copy, the same for everyone: fine to cache briefly.
    reply.header('cache-control', `public, max-age=${Math.min(settings.cacheSeconds, 60)}`);
    reply.header('etag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return body;
  });

  // ---- HQ: promotions ----------------------------------------------------------------------

  const admin = { config: { auth: 'hq' } };
  const guard = async (req) => requireHqAdmin(req);

  app.get('/api/hq/promotions', { ...admin, preHandler: guard, schema: { tags, summary: 'Landing-page promotions (HQ admin)' } }, async () => {
    const rows = await db.withHq(async (c) => (await c.query(`${SELECT} ORDER BY p.status = 'active' DESC, p.priority DESC, p.updated_at DESC LIMIT 500`)).rows);
    const now = new Date();
    const serving = selectActive(rows, { now });
    return {
      data: rows.map((r) => ({ ...hqView(r, now), serving: serving?.id === r.id })),
      servingId: serving?.id || null,
      defaultPromotion: publicView(DEFAULT_PROMOTION),
      uploads: { enabled: !media.problem, problem: media.problem, maxVideoBytes: media.maxVideoBytes, maxImageBytes: media.maxImageBytes },
    };
  });

  app.get('/api/hq/promotions/:id', { ...admin, preHandler: guard, schema: { tags, summary: 'One promotion', params: uuidParams('id') } }, async (req) => {
    const r = await db.withHq(async (c) => (await c.query(`${SELECT} WHERE p.id = $1`, [req.params.id])).rows[0]);
    if (!r) throw notFound('No such promotion.');
    return hqView(r);
  });

  const write = (summaryVerb) => ({ action: `hq.promotion_${summaryVerb}`, collection: 'promotions' });

  app.post('/api/hq/promotions', {
    ...admin, preHandler: guard, schema: { tags, summary: 'Create a promotion (audited)', body: PROMOTION_BODY_SCHEMA },
  }, async (req, reply) => {
    const p = validatePromotion(req.body, settings);
    const row = await db.withHq(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO promotions (name, status, starts_at, ends_at, priority, audience, overlay, slides, settings, notes, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING id`,
        [p.name, p.status, p.startsAt, p.endsAt, p.priority, p.audience, JSON.stringify(p.overlay), JSON.stringify(p.slides), JSON.stringify(p.settings), p.notes, req.principal.userId]);
      await hqAudit(c, req, null, { ...write('create'), recordId: rows[0].id, summary: `Promotion created (${p.status})`, meta: { slides: p.slides.length, status: p.status } });
      return (await c.query(`${SELECT} WHERE p.id = $1`, [rows[0].id])).rows[0];
    });
    live.invalidate();
    reply.code(201);
    return hqView(row);
  });

  app.put('/api/hq/promotions/:id', {
    ...admin, preHandler: guard, schema: { tags, summary: 'Replace a promotion (audited; send version to refuse a stale edit)', params: uuidParams('id'), body: PROMOTION_BODY_SCHEMA },
  }, async (req) => {
    const p = validatePromotion(req.body, settings);
    const row = await db.withHq(async (c) => {
      const cur = (await c.query('SELECT id, status, version FROM promotions WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!cur) throw notFound('No such promotion.');
      if (req.body.version != null && req.body.version !== cur.version) throw conflict('Someone else saved this promotion. Reload it and make your change again.', { version: cur.version });
      const status = req.body.status || cur.status;
      await c.query(
        `UPDATE promotions SET name = $2, status = $3, starts_at = $4, ends_at = $5, priority = $6, audience = $7, overlay = $8, slides = $9,
                settings = $10, notes = $11, updated_by = $12, updated_at = now(), version = version + 1 WHERE id = $1`,
        [cur.id, p.name, status, p.startsAt, p.endsAt, p.priority, p.audience, JSON.stringify(p.overlay), JSON.stringify(p.slides), JSON.stringify(p.settings), p.notes, req.principal.userId]);
      await hqAudit(c, req, null, { ...write('update'), recordId: cur.id, summary: `Promotion updated${status !== cur.status ? ` (${cur.status} -> ${status})` : ''}`, meta: { version: cur.version + 1 } });
      return (await c.query(`${SELECT} WHERE p.id = $1`, [cur.id])).rows[0];
    });
    live.invalidate();
    return hqView(row);
  });

  app.post('/api/hq/promotions/:id/duplicate', {
    ...admin, preHandler: guard, schema: { tags, summary: 'Copy a promotion as a draft (audited)', params: uuidParams('id') },
  }, async (req, reply) => {
    const row = await db.withHq(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO promotions (name, status, starts_at, ends_at, priority, audience, overlay, slides, settings, notes, created_by, updated_by)
         SELECT left('Copy of ' || name, 120), 'draft', starts_at, ends_at, priority, audience, overlay, slides, settings, notes, $2, $2
           FROM promotions WHERE id = $1 RETURNING id`, [req.params.id, req.principal.userId]);
      if (!rows[0]) throw notFound('No such promotion.');
      await hqAudit(c, req, null, { ...write('duplicate'), recordId: rows[0].id, summary: `Promotion copied from ${req.params.id.slice(0, 8)}` });
      return (await c.query(`${SELECT} WHERE p.id = $1`, [rows[0].id])).rows[0];
    });
    reply.code(201);
    return hqView(row);
  });

  app.post('/api/hq/promotions/:id/status', {
    ...admin, preHandler: guard,
    schema: {
      tags, summary: 'Activate, deactivate or return a promotion to draft (audited)', params: uuidParams('id'),
      body: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string', enum: ['draft', 'active', 'inactive'] } } },
    },
  }, async (req) => {
    const row = await db.withHq(async (c) => {
      const cur = (await c.query('SELECT id, status FROM promotions WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!cur) throw notFound('No such promotion.');
      await c.query('UPDATE promotions SET status = $2, updated_by = $3, updated_at = now(), version = version + 1 WHERE id = $1', [cur.id, req.body.status, req.principal.userId]);
      await hqAudit(c, req, null, { ...write('status'), recordId: cur.id, summary: `Promotion ${cur.status} -> ${req.body.status}`, meta: { from: cur.status, to: req.body.status } });
      return (await c.query(`${SELECT} WHERE p.id = $1`, [cur.id])).rows[0];
    });
    live.invalidate();
    return hqView(row);
  });

  app.delete('/api/hq/promotions/:id', {
    ...admin, preHandler: guard, schema: { tags, summary: 'Delete a promotion (audited)', params: uuidParams('id') },
  }, async (req, reply) => {
    await db.withHq(async (c) => {
      const { rows } = await c.query('DELETE FROM promotions WHERE id = $1 RETURNING id, name', [req.params.id]);
      if (!rows[0]) throw notFound('No such promotion.');
      await hqAudit(c, req, null, { ...write('delete'), recordId: rows[0].id, summary: 'Promotion deleted' });
    });
    live.invalidate();
    return reply.code(204).send();
  });

  // ---- HQ: media -------------------------------------------------------------------------------

  const mediaView = (m) => ({
    id: m.id, name: m.file_name, url: `/media/${m.file_name}`, kind: m.kind, type: m.mime_type, bytes: Number(m.bytes),
    sha256: m.sha256, label: m.label, uploadedByName: m.uploaded_by_name || null, createdAt: new Date(m.created_at).toISOString(),
  });
  const needMedia = () => { if (media.problem) throw new ApiError(503, 'media_unavailable', `Uploads are off on this server: ${media.problem}`); };

  app.get('/api/hq/media', { ...admin, preHandler: guard, schema: { tags, summary: 'Uploaded promotion media' } }, async () => {
    const rows = await db.withHq(async (c) => (await c.query(
      'SELECT m.*, u.display_name AS uploaded_by_name FROM hq_media m LEFT JOIN users u ON u.id = m.uploaded_by ORDER BY m.created_at DESC LIMIT 500')).rows);
    return { data: rows.map(mediaView), enabled: !media.problem, problem: media.problem, maxVideoBytes: media.maxVideoBytes, maxImageBytes: media.maxImageBytes };
  });

  app.post('/api/hq/media', {
    config: { auth: 'hq' },
    // Refused before a byte of the body is read: not an admin, or uploads are off.
    onRequest: async (req) => { if (req.principal) requireHqAdmin(req); needMedia(); },
    schema: { tags, summary: 'Upload a video (MP4/WebM) or poster (JPG/PNG/WebP) as the raw body; checked by its bytes (audited)' },
  }, async (req, reply) => {
    const len = req.headers['content-length'] != null ? Number(req.headers['content-length']) : null;
    reply.header('connection', 'close'); // a refused upload may still be arriving; don't reuse the socket
    let file;
    try {
      file = await receiveUpload(req.raw, { dir: media.dir, declaredType: req.headers['content-type'], contentLength: Number.isFinite(len) ? len : null, maxVideoBytes: media.maxVideoBytes, maxImageBytes: media.maxImageBytes });
    } catch (e) {
      if (e instanceof ApiError) req.log.info({ code: e.code }, 'media upload refused');
      throw e;
    }
    const label = cleanLabel(req.headers['x-media-label']);
    let row;
    try {
      row = await db.withHq(async (c) => {
        const { rows } = await c.query(
          `INSERT INTO hq_media (file_name, kind, mime_type, bytes, sha256, label, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [file.fileName, file.kind, file.mime, file.bytes, file.sha256, label, req.principal.userId]);
        await hqAudit(c, req, null, { action: 'hq.media_upload', collection: 'hq_media', recordId: file.fileName, summary: `Uploaded ${file.kind} (${Math.ceil(file.bytes / 1024)} KB)`, meta: { type: file.mime, bytes: file.bytes, sha256: file.sha256 } });
        return rows[0];
      });
    } catch (e) {
      await unlink(file.path).catch(() => {});
      throw e;
    }
    reply.removeHeader('connection');
    reply.code(201);
    return mediaView(row);
  });

  app.delete('/api/hq/media/:name', {
    ...admin, preHandler: guard,
    schema: { tags, summary: 'Delete an uploaded file (audited)', params: { type: 'object', required: ['name'], properties: { name: { type: 'string', pattern: '^[a-f0-9]{32}\\.(mp4|webm|jpg|png|webp)$' } } } },
  }, async (req, reply) => {
    needMedia();
    const path = mediaPath(media.dir, req.params.name);
    if (!path) throw new ApiError(400, 'bad_request', 'Not a media file name.');
    await db.withHq(async (c) => {
      const used = (await c.query("SELECT count(*)::int AS n FROM promotions WHERE status <> 'inactive' AND slides::text LIKE $1", [`%/media/${req.params.name}%`])).rows[0].n;
      if (used) throw conflict('A draft or active promotion still uses this file. Remove it there first.');
      const { rows } = await c.query('DELETE FROM hq_media WHERE file_name = $1 RETURNING file_name', [req.params.name]);
      if (!rows[0]) throw notFound('No such file.');
      await hqAudit(c, req, null, { action: 'hq.media_delete', collection: 'hq_media', recordId: req.params.name, summary: 'Deleted an uploaded file' });
    });
    await unlink(path).catch((e) => { if (e.code !== 'ENOENT') req.log.warn({ code: e.code }, 'could not remove a media file'); });
    return reply.code(204).send();
  });
}

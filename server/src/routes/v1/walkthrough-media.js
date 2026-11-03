// /api/v1/walkthrough-media: the video for a site walkthrough. The recording is too large to go
// through the sync queue, so it is uploaded here as a raw body (streamed to the media volume,
// byte-sniffed and size-capped like HQ media), transcoded by the worker, and played back from
// /media/. The synced walkthrough record keeps only the row id (recording.mediaId). See
// services/walkthrough-media.js for the rules and migration 0168 for the table.
//
//   POST   /api/v1/walkthrough-media            upload one recording (raw body; headers carry the ids)
//   GET    /api/v1/walkthrough-media/:id        poll status / get the playback urls
//   DELETE /api/v1/walkthrough-media/:id        remove the video and its files
import { unlink } from 'node:fs/promises';
import { ApiError, forbidden, notFound } from '../../errors.js';
import { canWrite, canRead } from '../../auth/access.js';
import { requireFeature } from '../../services/entitlements.js';
import { enqueue } from '../../services/queue.js';
import { geminiConfigured } from '../../services/gemini.js';
import { errorResponses, tenantCtx } from '../util.js';
import {
  MAX_MEDIA_PER_TENANT, WALKTHROUGH_UPLOAD_TYPES, mediaRowView, receiveWalkthroughUpload,
  removeMediaFiles, walkthroughMediaSettings,
} from '../../services/walkthrough-media.js';

const tags = ['walkthroughs'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const uuidParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };

function clampInt(v, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/** @param {import('fastify').FastifyInstance} app */
export default async function walkthroughMediaRoutes(app, { db, config }) {
  const media = walkthroughMediaSettings(config);
  const inTenant = (req, fn, opts) => db.withTenant(tenantCtx(req.principal), fn, opts);
  const needMedia = () => { if (media.problem) throw new ApiError(503, 'media_unavailable', `Walkthrough video is off on this server: ${media.problem}`); };

  // Raw upload bodies for this plugin only: leave the stream for the handler (it enforces type/size).
  app.addContentTypeParser(WALKTHROUGH_UPLOAD_TYPES, (req, payload, done) => done(null));

  app.post('/api/v1/walkthrough-media', {
    config: { auth: 'tenant' },
    // Refused before a byte of the body is read: uploads off on this server.
    onRequest: async () => { needMedia(); },
    preHandler: requireFeature(db, 'walkthroughs'),
    schema: {
      tags, summary: 'Upload a walkthrough recording (raw video body; X-Walkthrough-Id and X-Duration-Ms headers)',
      description: 'Streams the video onto the media volume, queues a transcode, and returns the media row (status "processing"). Checked by its bytes, not its name.',
      response: errorResponses,
    },
  }, async (req, reply) => {
    const p = req.principal;
    if (!canWrite(p, 'walkthroughs')) throw forbidden('You cannot add walkthrough video.');
    const walkthroughId = String(req.headers['x-walkthrough-id'] || '');
    if (!ID_RE.test(walkthroughId)) throw new ApiError(400, 'bad_request', 'Missing or invalid walkthrough id.');
    const durationMs = clampInt(req.headers['x-duration-ms'], 0, 24 * 3600 * 1000);
    const len = req.headers['content-length'] != null ? Number(req.headers['content-length']) : null;
    reply.header('connection', 'close'); // a refused upload may still be arriving; don't reuse the socket

    let file;
    try {
      file = await receiveWalkthroughUpload(req.raw, {
        dir: media.dir, declaredType: req.headers['content-type'],
        contentLength: Number.isFinite(len) ? len : null, maxVideoBytes: media.maxVideoBytes,
      });
    } catch (e) {
      if (e instanceof ApiError) req.log.info({ code: e.code }, 'walkthrough upload refused');
      throw e;
    }

    let row;
    try {
      row = await inTenant(req, async (tx) => {
        const count = (await tx.query('SELECT count(*)::int AS n FROM walkthrough_media')).rows[0].n;
        if (count >= MAX_MEDIA_PER_TENANT) throw new ApiError(429, 'quota_exceeded', 'You have too many stored videos. Delete some first.');
        const ins = (await tx.query(
          `INSERT INTO walkthrough_media (tenant_id, walkthrough_id, status, original_file, original_mime, bytes, duration_ms, created_by)
           VALUES ($1, $2, 'processing', $3, $4, $5, $6, $7) RETURNING *`,
          [p.tenantId, walkthroughId, file.fileName, file.mime, file.bytes, durationMs, p.userId || null])).rows[0];
        await enqueue(tx, { kind: 'walkthrough_transcode', payload: { mediaId: ins.id }, tenantId: p.tenantId, maxAttempts: 3, dedupeKey: `wt-transcode:${ins.id}` });
        return ins;
      }, { write: true });
    } catch (e) {
      await unlink(file.path).catch(() => {}); // DB insert failed: don't orphan the file
      throw e;
    }
    reply.removeHeader('connection');
    reply.code(201);
    return mediaRowView(row);
  });

  app.get('/api/v1/walkthrough-media/:id', {
    config: { auth: 'tenant' },
    schema: { tags, summary: 'Walkthrough video status and playback urls', params: uuidParam, response: errorResponses },
  }, async (req) => {
    const p = req.principal;
    if (!canRead(p, 'walkthroughs')) throw forbidden('You cannot read walkthrough video.');
    const row = await inTenant(req, async (tx) => (await tx.query('SELECT * FROM walkthrough_media WHERE id = $1', [req.params.id])).rows[0]);
    if (!row) throw notFound('No such video.');
    return { ...mediaRowView(row), aiTranscription: await geminiConfigured(db) };
  });

  app.post('/api/v1/walkthrough-media/:id/transcribe', {
    config: { auth: 'tenant' },
    preHandler: requireFeature(db, 'walkthroughs'),
    schema: {
      tags, summary: 'AI-transcribe a walkthrough video (Gemini); poll GET for the result',
      description: 'Queues a worker job that extracts the audio and sends it to Gemini using the HQ platform key. Returns the media row with transcribe_status "processing".',
      params: uuidParam, response: errorResponses,
    },
  }, async (req) => {
    const p = req.principal;
    if (!canWrite(p, 'walkthroughs')) throw forbidden('You cannot transcribe walkthrough video.');
    needMedia();
    if (!(await geminiConfigured(db))) throw new ApiError(400, 'not_configured', 'AI transcription is not set up. An administrator adds the Gemini key in HQ → Platform keys.');
    const row = await inTenant(req, async (tx) => {
      const r = (await tx.query('SELECT * FROM walkthrough_media WHERE id = $1', [req.params.id])).rows[0];
      if (!r) return null;
      if (!r.output_file && !r.original_file) throw new ApiError(409, 'no_video', 'There is no stored video to transcribe.');
      if (r.transcribe_status === 'processing') return r; // already queued; just report it
      const updated = (await tx.query(
        "UPDATE walkthrough_media SET transcribe_status = 'processing', transcribe_error = NULL, updated_at = now() WHERE id = $1 RETURNING *",
        [req.params.id])).rows[0];
      await enqueue(tx, { kind: 'walkthrough_transcribe', payload: { mediaId: req.params.id }, tenantId: p.tenantId, maxAttempts: 1, dedupeKey: `wt-transcribe:${req.params.id}` });
      return updated;
    }, { write: true });
    if (!row) throw notFound('No such video.');
    return { ...mediaRowView(row), aiTranscription: true };
  });

  app.delete('/api/v1/walkthrough-media/:id', {
    config: { auth: 'tenant' },
    schema: { tags, summary: 'Delete a walkthrough video and its files', params: uuidParam, response: errorResponses },
  }, async (req, reply) => {
    const p = req.principal;
    if (!canWrite(p, 'walkthroughs')) throw forbidden('You cannot delete walkthrough video.');
    needMedia();
    const row = await inTenant(req, async (tx) => (await tx.query('DELETE FROM walkthrough_media WHERE id = $1 RETURNING *', [req.params.id])).rows[0], { write: true });
    if (!row) throw notFound('No such video.');
    await removeMediaFiles(media.dir, row);
    return reply.code(204).send();
  });
}

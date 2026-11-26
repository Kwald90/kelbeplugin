// /api/v1/wirerun-media: video attached to a wire run (recorded by the AR tape while measuring, or
// picked later). Same store as walkthrough video (walkthrough_media rows with owner_kind 'wirerun',
// migration 0184), but uploaded in chunks so it can resume after the signal drops. The synced
// wireRuns record keeps only the row id (videos[].mediaId). See services/wirerun-media.js.
//
//   POST   /api/v1/wirerun-media            start an upload: JSON { wireRunId, bytes, mimeType, durationMs }
//   PUT    /api/v1/wirerun-media/:id/data   one chunk: raw body, X-Upload-Offset header
//   GET    /api/v1/wirerun-media/:id        status, the offset to resume from, playback urls
//   DELETE /api/v1/wirerun-media/:id        remove the video, its partial upload and its files
import { ApiError, forbidden, notFound } from '../../errors.js';
import { canRead, canWrite } from '../../auth/access.js';
import { requireFeature } from '../../services/entitlements.js';
import { enqueue } from '../../services/queue.js';
import { errorResponses, tenantCtx } from '../util.js';
import { MAX_MEDIA_PER_TENANT, removeMediaFiles, walkthroughMediaSettings } from '../../services/walkthrough-media.js';
import {
  MAX_VIDEOS_PER_RUN, STALE_UPLOAD_MS, checkNewUpload, chunkVerdict, createUploadPart, finishUploadPart,
  readChunk, removeWireRunMediaFiles, sniffVideoHead, wireRunMediaView, writeChunk,
} from '../../services/wirerun-media.js';

const tags = ['wireRuns'];
const KIND = 'wirerun';
const ID_RE = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$';
const uuidParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };

/** @param {import('fastify').FastifyInstance} app */
export default async function wireRunMediaRoutes(app, { db, config }) {
  const media = walkthroughMediaSettings(config);
  const inTenant = (req, fn, opts) => db.withTenant(tenantCtx(req.principal), fn, opts);
  const needMedia = () => { if (media.problem) throw new ApiError(503, 'media_unavailable', `Wire-run video is off on this server: ${media.problem}`); };
  const mayWrite = (req) => { if (!canWrite(req.principal, 'wireRuns')) throw forbidden('You cannot add video to wire runs.'); };
  const getRow = (tx, id) => tx.query('SELECT * FROM walkthrough_media WHERE id = $1 AND owner_kind = $2', [id, KIND]).then((r) => r.rows[0]);

  // Chunks are raw bytes; leave the stream for the handler, which caps and checks them.
  app.addContentTypeParser('application/octet-stream', (req, payload, done) => done(null));

  app.post('/api/v1/wirerun-media', {
    config: { auth: 'tenant' },
    onRequest: async () => { needMedia(); },
    preHandler: requireFeature(db, 'wireruns'),
    schema: {
      tags, summary: 'Start a resumable wire-run video upload',
      description: 'Creates the media row (status "uploading") and an empty partial file. Send the bytes with PUT /api/v1/wirerun-media/{id}/data.',
      body: {
        type: 'object', required: ['wireRunId', 'bytes'], additionalProperties: false,
        properties: {
          wireRunId: { type: 'string', pattern: ID_RE },
          bytes: { type: 'integer', minimum: 1 },
          mimeType: { type: 'string', maxLength: 80 },
          durationMs: { type: 'integer', minimum: 0, maximum: 24 * 3600 * 1000 },
        },
      },
      response: errorResponses,
    },
  }, async (req, reply) => {
    mayWrite(req);
    const p = req.principal;
    const { totalBytes, mime } = checkNewUpload(req.body, { maxVideoBytes: media.maxVideoBytes });
    // Unfinished uploads older than a week are abandoned: drop them (rows first, files after commit).
    const stale = await inTenant(req, async (tx) => (await tx.query(
      `DELETE FROM walkthrough_media WHERE owner_kind = $1 AND status = 'uploading' AND updated_at < now() - ($2::bigint * interval '1 millisecond') RETURNING *`,
      [KIND, STALE_UPLOAD_MS])).rows, { write: true });
    for (const r of stale) await removeWireRunMediaFiles(media.dir, r);

    const part = await createUploadPart(media.dir);
    let row;
    try {
      row = await inTenant(req, async (tx) => {
        const count = (await tx.query('SELECT count(*)::int AS n FROM walkthrough_media')).rows[0].n;
        if (count >= MAX_MEDIA_PER_TENANT) throw new ApiError(429, 'quota_exceeded', 'You have too many stored videos. Delete some first.');
        const perRun = (await tx.query('SELECT count(*)::int AS n FROM walkthrough_media WHERE owner_kind = $1 AND walkthrough_id = $2', [KIND, req.body.wireRunId])).rows[0].n;
        if (perRun >= MAX_VIDEOS_PER_RUN) throw new ApiError(429, 'quota_exceeded', `A wire run can hold ${MAX_VIDEOS_PER_RUN} videos. Delete one first.`);
        return (await tx.query(
          `INSERT INTO walkthrough_media (tenant_id, owner_kind, walkthrough_id, status, upload_file, upload_total, upload_mime, bytes, duration_ms, created_by)
           VALUES ($1, $2, $3, 'uploading', $4, $5, $6, 0, $7, $8) RETURNING *`,
          [p.tenantId, KIND, req.body.wireRunId, part, totalBytes, mime, req.body.durationMs ?? null, p.userId || null])).rows[0];
      }, { write: true });
    } catch (e) {
      await removeWireRunMediaFiles(media.dir, { upload_file: part });
      throw e;
    }
    reply.code(201);
    return wireRunMediaView(row);
  });

  app.put('/api/v1/wirerun-media/:id/data', {
    config: { auth: 'tenant' },
    onRequest: async () => { needMedia(); },
    preHandler: requireFeature(db, 'wireruns'),
    schema: {
      tags, summary: 'Send one chunk of a wire-run video (raw body; X-Upload-Offset header)',
      description: 'Writes the bytes at the offset. A chunk that starts past what has arrived is refused with 409 and details.receivedBytes; resume from there. The last chunk finishes the upload and queues the transcode.',
      params: uuidParam, response: errorResponses,
    },
  }, async (req) => {
    mayWrite(req);
    const offset = Number(req.headers['x-upload-offset']);
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/octet-stream') throw new ApiError(415, 'unsupported_media', 'Send chunks as application/octet-stream.');
    const row = await inTenant(req, (tx) => getRow(tx, req.params.id));
    if (!row) { req.raw.resume(); throw notFound('No such video.'); }
    if (row.status !== 'uploading') {
      req.raw.resume();
      // A resend of the last chunk after the upload already finished: report where it stands.
      if (Number.isSafeInteger(offset) && offset <= Number(row.bytes)) return wireRunMediaView(row);
      throw new ApiError(409, 'not_uploading', 'This video is no longer uploading.');
    }
    const received = Number(row.bytes) || 0;
    const total = Number(row.upload_total);
    if (chunkVerdict({ offset, length: 1, received, total }) === 'gap') {
      req.raw.resume();
      throw new ApiError(409, 'offset_mismatch', 'Resume from where the server is.', { receivedBytes: received });
    }
    const buf = await readChunk(req.raw);
    const verdict = chunkVerdict({ offset, length: buf.length, received, total });
    if (verdict === 'empty') throw new ApiError(400, 'bad_request', 'The chunk was empty.');
    if (verdict === 'over') throw new ApiError(400, 'bad_request', 'That chunk runs past the size given when the upload started.');
    if (offset === 0) sniffVideoHead(buf.subarray(0, 64), row.upload_mime); // refuse a non-video before storing it
    await writeChunk(media.dir, row.upload_file, offset, buf);

    const end = offset + buf.length;
    let updated = await inTenant(req, async (tx) => (await tx.query(
      `UPDATE walkthrough_media SET bytes = GREATEST(bytes, $2), updated_at = now()
        WHERE id = $1 AND owner_kind = $3 AND status = 'uploading' RETURNING *`,
      [row.id, end, KIND])).rows[0], { write: true });
    if (!updated) {
      const now = await inTenant(req, (tx) => getRow(tx, row.id));
      if (!now) throw notFound('No such video.');
      return wireRunMediaView(now);
    }
    if (Number(updated.bytes) < total) return wireRunMediaView(updated);

    // Every byte is in: check the file, give it its media name, queue the transcode.
    let file;
    try {
      file = await finishUploadPart(media.dir, updated.upload_file, { totalBytes: total, expectedMime: updated.upload_mime });
    } catch (e) {
      if (e?.code === 'ENOENT') { // another request finished it a moment ago
        const now = await inTenant(req, (tx) => getRow(tx, row.id));
        if (now) return wireRunMediaView(now);
        throw notFound('No such video.');
      }
      if (e instanceof ApiError && e.code === 'unsupported_media') {
        // Never going to be a video: drop the bytes and fail the row so the client stops retrying.
        await removeWireRunMediaFiles(media.dir, { upload_file: updated.upload_file });
        await inTenant(req, (tx) => tx.query(
          "UPDATE walkthrough_media SET status = 'failed', error = $2, upload_file = NULL, upload_total = NULL, updated_at = now() WHERE id = $1",
          [row.id, e.message]), { write: true });
      }
      throw e;
    }
    try {
      updated = await inTenant(req, async (tx) => {
        const r = (await tx.query(
          `UPDATE walkthrough_media
              SET status = 'processing', original_file = $2, original_mime = $3, bytes = $4,
                  upload_file = NULL, upload_total = NULL, updated_at = now()
            WHERE id = $1 AND status = 'uploading' RETURNING *`,
          [row.id, file.fileName, file.mime, total])).rows[0];
        if (r) await enqueue(tx, { kind: 'walkthrough_transcode', payload: { mediaId: r.id }, tenantId: req.principal.tenantId, maxAttempts: 3, dedupeKey: `wt-transcode:${r.id}` });
        return r;
      }, { write: true });
    } catch (e) {
      await removeMediaFiles(media.dir, { original_file: file.fileName });
      throw e;
    }
    if (!updated) { // deleted while finishing
      await removeMediaFiles(media.dir, { original_file: file.fileName });
      throw notFound('No such video.');
    }
    return wireRunMediaView(updated);
  });

  app.get('/api/v1/wirerun-media/:id', {
    config: { auth: 'tenant' },
    schema: { tags, summary: 'Wire-run video status, upload offset and playback urls', params: uuidParam, response: errorResponses },
  }, async (req) => {
    if (!canRead(req.principal, 'wireRuns')) throw forbidden('You cannot read wire-run video.');
    const row = await inTenant(req, (tx) => getRow(tx, req.params.id));
    if (!row) throw notFound('No such video.');
    return wireRunMediaView(row);
  });

  app.delete('/api/v1/wirerun-media/:id', {
    config: { auth: 'tenant' },
    schema: { tags, summary: 'Delete a wire-run video, its partial upload and its files', params: uuidParam, response: errorResponses },
  }, async (req, reply) => {
    mayWrite(req);
    needMedia();
    const row = await inTenant(req, async (tx) => (await tx.query(
      'DELETE FROM walkthrough_media WHERE id = $1 AND owner_kind = $2 RETURNING *', [req.params.id, KIND])).rows[0], { write: true });
    if (!row) throw notFound('No such video.');
    await removeWireRunMediaFiles(media.dir, row);
    return reply.code(204).send();
  });
}

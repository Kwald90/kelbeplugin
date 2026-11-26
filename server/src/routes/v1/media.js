// GET /api/v1/media/:id/:kind?c=&e=&s=  — a walkthrough or wire-run video ('video') or its poster
// ('poster'), for a signed URL (services/media-url.js). No session is needed (a <video> or <img>
// can't send one); the signature names the file and the company and expires. Byte ranges are
// answered with 206 so video seeking works, including iOS AVPlayer. The files live in MEDIA_DIR,
// which nginx no longer serves, so this is the only way to read them.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { ApiError, notFound } from '../../errors.js';
import { mediaPath } from '../../services/promotions.js';
import { walkthroughMediaSettings } from '../../services/walkthrough-media.js';
import { MEDIA_KINDS, createMediaSigner, mediaContentType, mediaFileFor, parseRange } from '../../services/media-url.js';

/** @param {import('fastify').FastifyInstance} app */
export default async function mediaRoutes(app, { db, config }) {
  const media = walkthroughMediaSettings(config);
  const signer = createMediaSigner(app.sealer);

  app.get('/api/v1/media/:id/:kind', {
    config: { auth: 'public' },
    schema: {
      tags: ['media'],
      summary: 'A job-site video or poster, for a signed URL (byte ranges supported)',
      description: 'Signed URLs come from the authenticated walkthrough and wire-run media routes and expire after about 15 minutes; fetch the media row again for a fresh one.',
      params: { type: 'object', required: ['id', 'kind'], properties: { id: { type: 'string', maxLength: 64 }, kind: { type: 'string', enum: MEDIA_KINDS } } },
      querystring: { type: 'object', properties: { c: { type: 'string', maxLength: 64 }, e: { type: 'string', maxLength: 20 }, s: { type: 'string', maxLength: 64 } } },
    },
  }, async (req, reply) => {
    const { id, kind } = req.params;
    const v = signer.verify({ mediaId: id, kind, c: req.query.c, e: req.query.e, s: req.query.s });
    if (!v.ok) {
      throw v.reason === 'expired'
        ? new ApiError(401, 'media_url_expired', 'This video link has expired. Open the video again.')
        : new ApiError(401, 'media_url_invalid', 'This video link is not valid.');
    }
    if (media.problem) throw new ApiError(503, 'media_unavailable', 'Video is off on this server.');
    const row = await db.withTenant({ tenantId: v.tenantId }, async (tx) =>
      (await tx.query('SELECT id, status, original_file, output_file, poster_file FROM walkthrough_media WHERE id = $1', [id])).rows[0]);
    const file = mediaFileFor(row, kind);
    const path = file ? mediaPath(media.dir, file) : null;
    if (!path) throw notFound('No such video.');
    let size;
    try { size = (await stat(path)).size; } catch { throw notFound('No such video.'); }

    // Private, and only until the link expires. CORP cross-origin so the iOS app (capacitor://)
    // can load it; CORS (the app's allowed origins, set globally) lets the frame measure read it.
    const left = Math.max(0, v.expiresAt - Math.floor(Date.now() / 1000));
    reply.header('cache-control', `private, max-age=${Math.min(left, 3600)}`);
    reply.header('cross-origin-resource-policy', 'cross-origin');
    reply.header('accept-ranges', 'bytes');
    reply.header('content-type', mediaContentType(file));
    reply.header('content-disposition', 'inline');

    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      reply.header('content-range', `bytes */${size}`);
      return reply.code(416).send();
    }
    if (range) {
      reply.code(206);
      reply.header('content-range', `bytes ${range.start}-${range.end}/${size}`);
      reply.header('content-length', String(range.end - range.start + 1));
      return reply.send(createReadStream(path, { start: range.start, end: range.end }));
    }
    reply.header('content-length', String(size));
    return reply.send(createReadStream(path));
  });
}

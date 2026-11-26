// /api/v1/files and /api/v1/file-folders: each company's documents, organised by customer and job and
// filed by AI (services/files-ai.js). Signed-in people only (no API keys, no client portal).
//
// The bytes live in FILES_DIR, outside every web root; the only way to read them is
// GET /api/v1/files/:id/content, which checks the session, the company (RLS) and the person's access to
// the folder, and answers with nosniff, a sandboxing CSP and no caching. See services/files.js.
//
//   GET    /api/v1/files                      every file and folder the person may see, plus usage
//   POST   /api/v1/files                      upload one file (raw body; X-File-Name and place headers)
//   POST   /api/v1/files/:id/organize         file it with AI (or the rules) from its name, type and text
//   PATCH  /api/v1/files/:id                  rename or move
//   DELETE /api/v1/files/:id                  move to Recently deleted (?forever=1 purges, managers)
//   POST   /api/v1/files/:id/restore          bring back from Recently deleted
//   GET    /api/v1/files/:id/content          the bytes (?inline=1 for previews of safe types)
//   POST   /api/v1/file-folders               new folder;  PATCH / DELETE /api/v1/file-folders/:id
import { ApiError, badRequest, forbidden, notFound } from '../../errors.js';
import { appendAudit } from '../../services/audit.js';
import { requireModule } from '../../services/modules.js';
import { readAiConfig } from '../../ai/config.js';
import { classifyFile } from '../../services/files-ai.js';
import {
  INLINE_TYPES, RECORD_ID, canSeeCategory, canSeeCompanyFiles, canSeeRow, contentDisposition, fileView, filesSettings,
  fmtGb, fmtSize, folderView, headerName, openStored, receiveFile, removeStored, textOf, validCategory,
} from '../../services/files.js';
import {
  AUTO_FILE_CONFIDENCE, isCompanyCategory, safeName, extOf, categoryLabel,
} from '../../../../electrical-app/js/lib/files-classify.js';
import { errorResponses, tenantCtx, who } from '../util.js';

const tags = ['files'];
const session = { auth: 'tenant', apiKey: false };
const uuidParam = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES = ['upload', 'share', 'drop', 'camera'];
/** Most files one list call returns (newest first); a company with more gets the newest. */
export const LIST_LIMIT = 20000;

const idOrNull = (v, what) => {
  if (v == null || v === '') return null;
  const s = String(v);
  if (!RECORD_ID.test(s)) throw badRequest(`That ${what} id is not valid.`);
  return s;
};

/** @param {import('fastify').FastifyInstance} app */
export default async function filesRoutes(app, { db, config }) {
  const store = filesSettings(config);
  const aiCfg = readAiConfig();
  const inTenant = (req, fn, opts) => db.withTenant(tenantCtx(req.principal), fn, opts);
  const needStore = () => { if (store.problem) throw new ApiError(503, 'files_unavailable', `File storage is off on this server: ${store.problem}`); };
  const canUse = (p) => p.perms.has('jobs');
  const needUse = (p) => { if (!canUse(p)) throw forbidden('You cannot open Files.'); };
  const writeGuard = requireModule(db, 'files');

  // Upload bodies for this plugin only: the stream is left for the handler (type and size checked there).
  app.addContentTypeParser('application/octet-stream', (req, payload, done) => done(null));

  /** Check and normalise a place ({ clientId, jobId, category, folderId }) inside the tenant tx. */
  async function checkPlace(tx, p, place) {
    let { clientId = null, jobId = null, category = null, folderId = null } = place;
    if (!validCategory(category)) throw badRequest('That folder is not one of the standard folders.');
    if (folderId) {
      if (!UUID.test(folderId)) throw badRequest('That folder id is not valid.');
      const f = (await tx.query('SELECT * FROM file_folders WHERE id = $1', [folderId])).rows[0];
      if (!f) throw notFound('That folder is gone.');
      ({ client_id: clientId, job_id: jobId, category } = f);
    }
    if (jobId) {
      const j = (await tx.query('SELECT client_id FROM jobs WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [tx.tenantId, jobId])).rows[0];
      if (!j) throw notFound('That job is gone.');
      if (clientId && j.client_id && j.client_id !== clientId) throw badRequest('That job belongs to another customer.');
      clientId = j.client_id || null;
    }
    if (clientId && !jobId) {
      const c = (await tx.query('SELECT 1 FROM clients WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [tx.tenantId, clientId])).rows[0];
      if (!c) throw notFound('That customer is gone.');
    }
    if (category) {
      const company = !clientId && !jobId;
      if (company !== isCompanyCategory(category)) throw badRequest(company ? 'Company files go in a company folder.' : 'Customer and job files go in a customer folder.');
    }
    const row = { client_id: clientId, job_id: jobId, category };
    if (!canSeeRow(p, row)) throw forbidden('You cannot put files in that folder.');
    return { clientId, jobId, category, folderId };
  }

  async function usage(tx) {
    const r = (await tx.query('SELECT count(*)::int AS n, COALESCE(sum(bytes), 0)::bigint AS bytes FROM files WHERE tenant_id = $1', [tx.tenantId])).rows[0];
    return { count: r.n, bytes: Number(r.bytes), quotaBytes: store.quotaBytes, maxFileBytes: store.maxFileBytes, trashDays: store.trashDays };
  }

  const audit = (tx, req, action, row, summary, meta) => appendAudit(tx, tx.tenantId, {
    ...who(req), action, collection: 'files', recordId: row.id, summary: String(summary || row.name || '').slice(0, 400), meta: meta || null,
  });

  const loadFile = async (tx, p, id, { deleted = false } = {}) => {
    const r = (await tx.query(`SELECT * FROM files WHERE id = $1 ${deleted ? '' : 'AND deleted_at IS NULL'}`, [id])).rows[0];
    if (!r || !canSeeRow(p, r)) throw notFound('No such file.');
    return r;
  };

  // ---- list -------------------------------------------------------------------------------------

  app.get('/api/v1/files', {
    config: session,
    schema: { tags, summary: 'Every file and folder the person may see, with storage use', response: errorResponses },
  }, async (req) => {
    const p = req.principal;
    needUse(p);
    return inTenant(req, async (tx) => {
      const files = (await tx.query('SELECT * FROM files ORDER BY created_at DESC LIMIT $1', [LIST_LIMIT])).rows.filter((r) => canSeeRow(p, r));
      const folders = (await tx.query('SELECT * FROM file_folders ORDER BY name')).rows.filter((r) => canSeeRow(p, r));
      return {
        files: files.map(fileView), folders: folders.map(folderView), usage: await usage(tx),
        storage: store.problem ? 'off' : 'on', companyFiles: canSeeCompanyFiles(p),
        canPurge: p.isManager,
      };
    });
  });

  // ---- upload -----------------------------------------------------------------------------------

  app.post('/api/v1/files', {
    config: session,
    onRequest: async () => { needStore(); },
    preHandler: writeGuard,
    schema: {
      tags, summary: 'Upload one file (raw body, Content-Type application/octet-stream)',
      description: 'Headers: X-File-Name (URI-encoded), optional X-Client-Id, X-Job-Id, X-Category, X-Folder-Id, X-Source. The type is checked from the bytes. A file already stored (same contents) is not stored twice.',
      response: errorResponses,
    },
  }, async (req, reply) => {
    const p = req.principal;
    needUse(p);
    const h = req.headers;
    const name = headerName(h['x-file-name']);
    const placeIn = {
      clientId: idOrNull(h['x-client-id'], 'customer'), jobId: idOrNull(h['x-job-id'], 'job'),
      category: h['x-category'] ? String(h['x-category']) : null, folderId: h['x-folder-id'] ? String(h['x-folder-id']) : null,
    };
    const source = SOURCES.includes(String(h['x-source'] || '')) ? String(h['x-source']) : 'upload';
    const place = await inTenant(req, async (tx) => {
      const pl = await checkPlace(tx, p, placeIn);
      const u = await usage(tx);
      if (u.bytes >= store.quotaBytes) throw new ApiError(413, 'quota_exceeded', `Your company has used its ${fmtGb(store.quotaBytes)} of file storage. Empty Recently deleted or remove files you no longer need.`);
      return pl;
    });
    const len = h['content-length'] != null ? Number(h['content-length']) : null;
    reply.header('connection', 'close'); // a refused upload may still be arriving
    const got = await receiveFile(req.raw, { dir: store.dir, name, maxBytes: store.maxFileBytes, contentLength: Number.isFinite(len) ? len : null });
    let out;
    try {
      out = await inTenant(req, async (tx) => {
        // Quota again with the real size (two uploads may race; the second one loses).
        const u = await usage(tx);
        if (u.bytes + got.bytes > store.quotaBytes) {
          throw new ApiError(413, 'quota_exceeded', `This file would take your company past its ${fmtGb(store.quotaBytes)} of file storage (${fmtGb(u.bytes)} used). Empty Recently deleted or remove files you no longer need.`);
        }
        const dup = (await tx.query('SELECT * FROM files WHERE tenant_id = $1 AND sha256 = $2 AND bytes = $3 AND deleted_at IS NULL LIMIT 1', [tx.tenantId, got.sha256, got.bytes])).rows[0];
        if (dup && canSeeRow(p, dup)) return { row: dup, duplicate: true };
        const fixedName = extOf(name) === got.ext || ['jpg', 'jpeg', 'tif', 'tiff', 'heic', 'heif', 'm4v', 'mov', 'mp4'].includes(extOf(name)) ? name : safeName(`${name}.${got.ext}`);
        const ins = (await tx.query(
          `INSERT INTO files (tenant_id, name, original_name, mime, ext, bytes, sha256, storage_key, client_id, job_id, category, folder_id, text_excerpt, source, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15) RETURNING *`,
          [tx.tenantId, fixedName, name, got.mime, got.ext, got.bytes, got.sha256, got.key, place.clientId, place.jobId, place.category, place.folderId,
            textOf(got.head, got.mime) || null, source, p.userId || null])).rows[0];
        await audit(tx, req, 'file.upload', ins, `Uploaded ${ins.name} (${fmtSize(ins.bytes)}) to ${place.category ? categoryLabel(place.category) : 'the Inbox'}`,
          { bytes: Number(ins.bytes), mime: ins.mime, clientId: ins.client_id, jobId: ins.job_id, category: ins.category, source });
        return { row: ins, duplicate: false };
      }, { write: true });
    } catch (e) {
      await removeStored(store.dir, got.key).catch(() => {});
      throw e;
    }
    if (out.duplicate) await removeStored(store.dir, got.key).catch(() => {});
    reply.removeHeader('connection');
    reply.code(out.duplicate ? 200 : 201);
    return { file: fileView(out.row), duplicate: out.duplicate };
  });

  // ---- AI filing --------------------------------------------------------------------------------

  app.post('/api/v1/files/:id/organize', {
    config: session,
    preHandler: writeGuard,
    schema: {
      tags, summary: 'File a document with AI (or keyword rules when no AI is set up)',
      description: 'Body { text?, apply?, company? }: text the device extracted (PDF, Office) to help; company files an unsorted file into the company folders. With apply (default true) a confident answer moves the file; otherwise the suggestion is stored and the file stays in the Inbox.',
      params: uuidParam,
      body: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', maxLength: 20000 }, apply: { type: 'boolean' }, company: { type: 'boolean' }, date: { type: 'string', maxLength: 10 } } },
      response: errorResponses,
    },
  }, async (req) => {
    const p = req.principal;
    needUse(p);
    const body = req.body || {};
    const row = await inTenant(req, async (tx) => {
      const r = await loadFile(tx, p, req.params.id);
      if (body.text && String(body.text).trim()) {
        const text = String(body.text).replace(/\s+/g, ' ').trim().slice(0, 8000);
        await tx.query('UPDATE files SET text_excerpt = $2 WHERE id = $1', [r.id, text]);
        r.text_excerpt = text;
      }
      return r;
    }, { write: true });
    const company = Boolean(body.company) && !row.client_id && !row.job_id;
    if (company && !canSeeCompanyFiles(p)) throw forbidden('You cannot file into the company folders.');
    const fixed = { clientId: row.client_id, jobId: row.job_id, category: row.category, folderId: row.folder_id, company };
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : new Date().toISOString().slice(0, 10);
    const result = await classifyFile({
      db, sealer: app.sealer, aiCfg, config, ctx: tenantCtx(p), log: req.log, date,
      file: { name: row.original_name || row.name, mime: row.mime, bytes: Number(row.bytes), text: row.text_excerpt || '' }, fixed,
    });
    const apply = body.apply !== false && result.category && result.confidence >= AUTO_FILE_CONFIDENCE;
    const ai = {
      by: result.by, provider: result.provider || null, confidence: result.confidence, reason: result.reason || '', note: result.note || null,
      suggestedName: result.suggestedName || null, at: new Date().toISOString(),
      suggestion: { clientId: result.clientId ?? result.suggestion?.clientId ?? null, jobId: result.jobId ?? result.suggestion?.jobId ?? null, category: result.category ?? result.suggestion?.category ?? null },
      applied: Boolean(apply), from: { clientId: row.client_id, jobId: row.job_id, category: row.category, folderId: row.folder_id },
    };
    const updated = await inTenant(req, async (tx) => {
      let place = null;
      if (apply) {
        try { place = await checkPlace(tx, p, { clientId: result.clientId, jobId: result.jobId, category: result.category, folderId: row.folder_id }); }
        catch { place = null; ai.applied = false; } // e.g. a crew member: AI chose a money folder they can't use
      }
      const r = place
        ? (await tx.query('UPDATE files SET client_id = $2, job_id = $3, category = $4, ai = $5, updated_at = now(), updated_by = $6 WHERE id = $1 AND deleted_at IS NULL RETURNING *',
          [row.id, place.clientId, place.jobId, place.category, ai, p.userId || null])).rows[0]
        : (await tx.query('UPDATE files SET ai = $2, updated_at = now(), updated_by = $3 WHERE id = $1 AND deleted_at IS NULL RETURNING *', [row.id, ai, p.userId || null])).rows[0];
      if (!r) throw notFound('No such file.');
      await audit(tx, req, 'file.organize', r, ai.applied
        ? `Filed ${r.name} to ${categoryLabel(r.category)} (${ai.by === 'ai' ? 'AI' : 'rules'}, ${Math.round(ai.confidence * 100)}%)`
        : `Left ${r.name} in the Inbox (${ai.by === 'ai' ? 'AI' : 'rules'}, ${Math.round(ai.confidence * 100)}%)`,
      { by: ai.by, provider: ai.provider, confidence: ai.confidence, applied: ai.applied, clientId: r.client_id, jobId: r.job_id, category: r.category });
      return r;
    }, { write: true });
    return { file: fileView(updated), result: { ...ai, note: ai.note } };
  });

  // ---- rename / move ----------------------------------------------------------------------------

  app.patch('/api/v1/files/:id', {
    config: session,
    preHandler: writeGuard,
    schema: {
      tags, summary: 'Rename or move a file',
      params: uuidParam,
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          clientId: { type: ['string', 'null'], maxLength: 128 }, jobId: { type: ['string', 'null'], maxLength: 128 },
          category: { type: ['string', 'null'], maxLength: 32 }, folderId: { type: ['string', 'null'], maxLength: 36 },
          move: { type: 'boolean' },
        },
      },
      response: errorResponses,
    },
  }, async (req) => {
    const p = req.principal;
    needUse(p);
    const b = req.body || {};
    return inTenant(req, async (tx) => {
      const r = await loadFile(tx, p, req.params.id);
      const changes = [];
      let name = r.name;
      if (b.name != null) {
        const ext = extOf(r.name);
        const wanted = String(b.name).trim();
        name = safeName(ext && extOf(wanted) !== ext ? `${wanted}.${ext}` : wanted);
        if (name !== r.name) changes.push(`renamed to ${name}`);
      }
      let place = { clientId: r.client_id, jobId: r.job_id, category: r.category, folderId: r.folder_id };
      if (b.move) {
        place = await checkPlace(tx, p, { clientId: idOrNull(b.clientId, 'customer'), jobId: idOrNull(b.jobId, 'job'), category: b.category || null, folderId: b.folderId || null });
        changes.push(`moved to ${place.category ? categoryLabel(place.category) : place.folderId ? 'a folder' : 'the Inbox'}`);
      }
      const ai = b.move && r.ai ? { ...r.ai, by: 'person', movedAt: new Date().toISOString() } : r.ai;
      const u = (await tx.query(
        `UPDATE files SET name = $2, client_id = $3, job_id = $4, category = $5, folder_id = $6, ai = $7, updated_at = now(), updated_by = $8
          WHERE id = $1 RETURNING *`,
        [r.id, name, place.clientId, place.jobId, place.category, place.folderId, ai, p.userId || null])).rows[0];
      if (changes.length) await audit(tx, req, 'file.update', u, `${r.name}: ${changes.join(', ')}`, { from: { clientId: r.client_id, jobId: r.job_id, category: r.category, folderId: r.folder_id }, to: place });
      return { file: fileView(u) };
    }, { write: true });
  });

  // ---- delete / restore -------------------------------------------------------------------------

  app.delete('/api/v1/files/:id', {
    config: session,
    preHandler: writeGuard,
    schema: {
      tags, summary: 'Move a file to Recently deleted (?forever=1 removes it for good; managers only)',
      params: uuidParam, querystring: { type: 'object', properties: { forever: { type: 'string', enum: ['0', '1'] } } }, response: errorResponses,
    },
  }, async (req, reply) => {
    const p = req.principal;
    needUse(p);
    const forever = req.query?.forever === '1';
    if (forever && !p.isManager) throw forbidden('Only an owner, admin, office or foreman can delete files for good.');
    const gone = await inTenant(req, async (tx) => {
      const r = await loadFile(tx, p, req.params.id, { deleted: true });
      if (forever) {
        await tx.query('DELETE FROM files WHERE id = $1', [r.id]);
        await audit(tx, req, 'file.purge', r, `Deleted ${r.name} for good`, { bytes: Number(r.bytes), sha256: r.sha256 });
        return r;
      }
      if (!r.deleted_at) {
        await tx.query('UPDATE files SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [r.id, p.userId || null]);
        await audit(tx, req, 'file.delete', r, `Moved ${r.name} to Recently deleted`, { bytes: Number(r.bytes) });
      }
      return null;
    }, { write: true });
    if (gone) await removeStored(store.dir, gone.storage_key).catch((e) => req.log.warn({ code: e?.code }, 'file bytes not removed'));
    return reply.code(204).send();
  });

  app.post('/api/v1/files/:id/restore', {
    config: session,
    preHandler: writeGuard,
    schema: { tags, summary: 'Bring a file back from Recently deleted', params: uuidParam, response: errorResponses },
  }, async (req) => {
    const p = req.principal;
    needUse(p);
    return inTenant(req, async (tx) => {
      const r = await loadFile(tx, p, req.params.id, { deleted: true });
      // Its folder may have gone meanwhile: back to the standard folder of the same place.
      const keepFolder = r.folder_id ? (await tx.query('SELECT 1 FROM file_folders WHERE id = $1', [r.folder_id])).rows.length > 0 : false;
      const u = (await tx.query('UPDATE files SET deleted_at = NULL, deleted_by = NULL, folder_id = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *',
        [r.id, keepFolder ? r.folder_id : null, p.userId || null])).rows[0];
      await audit(tx, req, 'file.restore', u, `Restored ${u.name}`);
      return { file: fileView(u) };
    }, { write: true });
  });

  // ---- content ----------------------------------------------------------------------------------

  app.get('/api/v1/files/:id/content', {
    config: session,
    schema: {
      tags, summary: 'Download a file (inline=1 shows PDFs, images, video and plain text in a preview)',
      params: uuidParam, querystring: { type: 'object', properties: { inline: { type: 'string', enum: ['0', '1'] } } }, response: errorResponses,
    },
  }, async (req, reply) => {
    const p = req.principal;
    needUse(p);
    needStore();
    const r = await inTenant(req, (tx) => loadFile(tx, p, req.params.id, { deleted: true }));
    let opened;
    try { opened = await openStored(store.dir, r.storage_key); }
    catch { throw new ApiError(410, 'file_missing', 'This file’s contents are missing on the server. Upload it again.'); }
    const inline = req.query?.inline === '1' && INLINE_TYPES.has(r.mime);
    reply
      .header('content-type', inline ? r.mime : (INLINE_TYPES.has(r.mime) ? r.mime : 'application/octet-stream'))
      .header('content-length', String(opened.size))
      .header('content-disposition', contentDisposition(inline ? 'inline' : 'attachment', r.name))
      .header('x-content-type-options', 'nosniff')
      // Even opened on its own, the file can't run script or load anything.
      .header('content-security-policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox")
      .header('cross-origin-resource-policy', 'same-origin')
      .header('cache-control', 'private, no-store');
    return reply.send(opened.stream);
  });

  // ---- folders ----------------------------------------------------------------------------------

  app.post('/api/v1/file-folders', {
    config: session,
    preHandler: writeGuard,
    schema: {
      tags, summary: 'Make a folder',
      body: {
        type: 'object', additionalProperties: false, required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 }, clientId: { type: ['string', 'null'], maxLength: 128 },
          jobId: { type: ['string', 'null'], maxLength: 128 }, category: { type: ['string', 'null'], maxLength: 32 }, parentId: { type: ['string', 'null'], maxLength: 36 },
        },
      },
      response: errorResponses,
    },
  }, async (req, reply) => {
    const p = req.principal;
    needUse(p);
    const b = req.body;
    const name = String(b.name).replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').trim().slice(0, 120);
    if (!name) throw badRequest('Give the folder a name.');
    const row = await inTenant(req, async (tx) => {
      const place = await checkPlace(tx, p, { clientId: idOrNull(b.clientId, 'customer'), jobId: idOrNull(b.jobId, 'job'), category: b.category || null, folderId: b.parentId || null });
      if (!place.clientId && !place.jobId && !canSeeCompanyFiles(p)) throw forbidden('You cannot make company folders.');
      const n = (await tx.query('SELECT count(*)::int AS n FROM file_folders')).rows[0].n;
      if (n >= 5000) throw new ApiError(429, 'quota_exceeded', 'Your company has too many folders. Remove some first.');
      const f = (await tx.query(
        'INSERT INTO file_folders (tenant_id, name, client_id, job_id, category, parent_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [tx.tenantId, name, place.clientId, place.jobId, place.category, place.folderId, p.userId || null])).rows[0];
      await appendAudit(tx, tx.tenantId, { ...who(req), action: 'folder.create', collection: 'file_folders', recordId: f.id, summary: `Made folder ${name}` });
      return f;
    }, { write: true });
    reply.code(201);
    return { folder: folderView(row) };
  });

  app.patch('/api/v1/file-folders/:id', {
    config: session,
    preHandler: writeGuard,
    schema: {
      tags, summary: 'Rename a folder', params: uuidParam,
      body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 120 } } },
      response: errorResponses,
    },
  }, async (req) => {
    const p = req.principal;
    needUse(p);
    const name = String(req.body.name).replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').trim().slice(0, 120);
    if (!name) throw badRequest('Give the folder a name.');
    return inTenant(req, async (tx) => {
      const f = (await tx.query('SELECT * FROM file_folders WHERE id = $1', [req.params.id])).rows[0];
      if (!f || !canSeeRow(p, f)) throw notFound('No such folder.');
      const u = (await tx.query('UPDATE file_folders SET name = $2, updated_at = now() WHERE id = $1 RETURNING *', [f.id, name])).rows[0];
      await appendAudit(tx, tx.tenantId, { ...who(req), action: 'folder.update', collection: 'file_folders', recordId: f.id, summary: `Renamed folder ${f.name} to ${name}` });
      return { folder: folderView(u) };
    }, { write: true });
  });

  app.delete('/api/v1/file-folders/:id', {
    config: session,
    preHandler: writeGuard,
    schema: { tags, summary: 'Remove a folder; what is inside moves up to its parent', params: uuidParam, response: errorResponses },
  }, async (req, reply) => {
    const p = req.principal;
    needUse(p);
    await inTenant(req, async (tx) => {
      const f = (await tx.query('SELECT * FROM file_folders WHERE id = $1', [req.params.id])).rows[0];
      if (!f || !canSeeRow(p, f)) throw notFound('No such folder.');
      if (!canSeeCategory(p, f.category)) throw forbidden();
      const moved = (await tx.query('UPDATE files SET folder_id = $2, updated_at = now() WHERE folder_id = $1', [f.id, f.parent_id])).rowCount;
      await tx.query('UPDATE file_folders SET parent_id = $2, updated_at = now() WHERE parent_id = $1', [f.id, f.parent_id]);
      await tx.query('DELETE FROM file_folders WHERE id = $1', [f.id]);
      await appendAudit(tx, tx.tenantId, { ...who(req), action: 'folder.delete', collection: 'file_folders', recordId: f.id, summary: `Removed folder ${f.name} (${moved} file${moved === 1 ? '' : 's'} moved up)` });
    }, { write: true });
    return reply.code(204).send();
  });
}

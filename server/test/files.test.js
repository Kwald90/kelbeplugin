// Files (#/files, migration 0185): uploads land in FILES_DIR (never a web root), are checked by their
// bytes and size, count against the company quota, are filed by AI or the keyword rules, are readable
// only signed in and only by the company that owns them, and every upload, move and delete is audited.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skip, createTestDatabase } from './support/db.js';
import { addMember, call, ownerTenant, startApp } from './support/app.js';
import { mockAnthropic, turn, text } from './support/anthropic-mock.js';
import { setAnthropicClientFactory } from '../src/ai/client.js';
import { setSecret } from '../src/services/secrets.js';
import {
  contentDisposition, filesSettings, headerName, sniffFile, storagePath, looksActive,
} from '../src/services/files.js';
import { parseAiJson, validateAiAnswer } from '../src/services/files-ai.js';
import { purgeTrash } from '../src/services/files-jobs.js';
import { CODE_ROOT } from '../src/services/promotions.js';

const PDF = (body = 'hello') => Buffer.from(`%PDF-1.4\n% ${body}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from('JFIF\0'), Buffer.alloc(200, 7)]);

// ---- pure pieces ----------------------------------------------------------------------------------

describe('what may be stored (checked by bytes, not names)', () => {
  test('PDFs, photos, Office files and plain text are accepted with their real type', () => {
    assert.deepEqual(sniffFile(PDF(), 'x.pdf'), { mime: 'application/pdf', ext: 'pdf' });
    assert.deepEqual(sniffFile(PDF(), 'renamed.jpg'), { mime: 'application/pdf', ext: 'pdf' }, 'the bytes win over the name');
    assert.equal(sniffFile(JPEG, 'IMG_1.JPG').mime, 'image/jpeg');
    assert.equal(sniffFile(Buffer.from('PK\x03\x04rest-of-zip'), 'Quote.docx').mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(sniffFile(Buffer.from('PK\x03\x04rest-of-zip'), 'bundle.bin').mime, 'application/zip');
    assert.equal(sniffFile(Buffer.from('Panel,Circuit\nA,1\n'), 'list.csv').mime, 'text/csv');
    assert.equal(sniffFile(Buffer.from('From: gc@example.test\nSubject: Permit\n\nSee <html>attached</html>'), 'mail.eml').mime, 'message/rfc822');
    assert.equal(sniffFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]), 'old.xls').mime, 'application/vnd.ms-excel');
    assert.equal(sniffFile(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypqt  ')]), 'clip.mov').mime, 'video/quicktime');
  });

  test('programs, web pages, SVG and unknown containers are refused whatever they are called', () => {
    assert.equal(sniffFile(Buffer.from('MZ\x90\x00'), 'invoice.pdf'), null);
    assert.equal(sniffFile(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]), 'notes.txt'), null);
    assert.equal(sniffFile(Buffer.from('<!doctype html><script>alert(1)</script>'), 'notes.txt'), null);
    assert.equal(sniffFile(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), 'logo.svg'), null);
    assert.equal(sniffFile(Buffer.from('<svg onload=alert(1)>'), 'logo.txt'), null);
    assert.equal(sniffFile(Buffer.from('plain words'), 'page.html'), null, 'html is not an allowed text type');
    assert.equal(sniffFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'setup.msi'), null);
    assert.equal(sniffFile(Buffer.from([0, 1, 2, 3, 4, 5]), 'mystery.dat'), null);
    assert.ok(looksActive('x <iframe src=y>'));
    assert.ok(!looksActive('Panel A, 200 A main'));
  });

  test('names from headers are decoded and made safe; storage paths only from 32-hex keys', () => {
    assert.equal(headerName(encodeURIComponent('FW_ ../../etc/Permit (2).pdf')), 'FW_ ..-..-etc-Permit (2).pdf', 'no path separators; the wording is kept');
    assert.equal(headerName(encodeURIComponent('../.env')), 'File.env', 'never a dotfile or a path');
    assert.equal(headerName(encodeURIComponent('Ünïcode plan.pdf')), 'Ünïcode plan.pdf');
    assert.equal(headerName(''), 'File');
    assert.throws(() => storagePath('/srv/files', '../etc/passwd'));
    assert.equal(storagePath('/srv/files', 'a'.repeat(32)).replaceAll('\\', '/'), `/srv/files/aa/${'a'.repeat(32)}`);
    const cd = contentDisposition('attachment', 'Smith "reno" é.pdf');
    assert.match(cd, /^attachment; filename="Smith _reno_ _.pdf"; filename\*=UTF-8''Smith%20%22reno%22%20%C3%A9\.pdf$/);
  });

  test('FILES_DIR must be absolute and outside the code checkout; staging without it is off', () => {
    assert.match(filesSettings({ appEnv: 'staging' }, {}).problem, /FILES_DIR is not set/);
    assert.match(filesSettings({ appEnv: 'production' }, { FILES_DIR: 'files' }).problem, /absolute/);
    assert.match(filesSettings({ appEnv: 'production' }, { FILES_DIR: join(CODE_ROOT, 'electrical-app', 'files') }).problem, /outside the code checkout/);
    const ok = filesSettings({ appEnv: 'production' }, { FILES_DIR: join(tmpdir(), 'ft-files-ok'), FILES_MAX_MB: '5', FILES_QUOTA_GB: '2' });
    assert.equal(ok.problem, null);
    assert.equal(ok.maxFileBytes, 5 * 1024 * 1024);
    assert.equal(ok.quotaBytes, 2 * 1024 ** 3);
    assert.equal(filesSettings({ appEnv: 'test' }, {}).problem, null, 'tests and local use the temp directory');
  });

  test('AI answers are parsed leniently and checked against the candidates', () => {
    assert.deepEqual(parseAiJson('Sure:\n```json\n{"jobId":"j1","category":"permits"}\n```'), { jobId: 'j1', category: 'permits' });
    assert.equal(parseAiJson('no json here'), null);
    const clients = [{ id: 'c1', name: 'Jane Smith' }];
    const jobs = [{ id: 'j1', clientId: 'c1', number: 'J-1' }];
    const file = { name: 'scan0001.pdf' };
    const good = validateAiAnswer({ clientId: 'c1', jobId: 'j1', category: 'permits', confidence: 0.9, suggestedName: 'ESA notification', reason: 'Permit number.' }, { file, clients, jobs, fixed: { clientId: 'c1' } });
    assert.equal(good.jobId, 'j1');
    assert.equal(good.suggestedName, 'ESA notification.pdf');
    assert.equal(validateAiAnswer({ jobId: 'j-other-company', category: 'permits' }, { file, clients, jobs }), null, 'a job that was not offered is thrown away');
    assert.equal(validateAiAnswer({ clientId: 'c1', category: 'permits' }, { file, clients: [...clients, { id: 'c2', name: 'B' }], jobs, fixed: { clientId: 'c2' } }), null, 'never moves a file to another customer');
    assert.equal(validateAiAnswer({ clientId: 'c1', category: 'not-a-folder' }, { file, clients, jobs }), null);
    const inbox = validateAiAnswer({ clientId: null, jobId: null, category: 'quotes', confidence: 0.9 }, { file, clients, jobs });
    assert.equal(inbox.category, null, 'no customer: it waits in the Inbox');
    assert.ok(inbox.confidence <= 0.3);
  });
});

// ---- the API against real Postgres ----------------------------------------------------------------

let t, app, A, B, sparky, dir;
const ENV_KEYS = ['FILES_DIR', 'FILES_MAX_MB', 'FILES_QUOTA_MB'];
const saved = {};
const mut = (o) => ({ mid: `m-${Math.random().toString(36).slice(2)}`, baseVersion: null, ...o });
const upload = (token, buf, name, headers = {}) => call(app, {
  method: 'POST', url: '/api/v1/files', token, body: buf,
  headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), ...headers },
});
const stored = () => readdirSync(dir).filter((d) => /^[a-f0-9]{2}$/.test(d)).flatMap((d) => readdirSync(join(dir, d)).filter((f) => /^[a-f0-9]{32}$/.test(f)));
const audits = async (tenantId, action) => (await t.superPool.query('SELECT * FROM audit_events WHERE tenant_id = $1 AND action = $2 ORDER BY seq', [tenantId, action])).rows;

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'ft-files-test-'));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { FILES_DIR: dir, FILES_MAX_MB: '1', FILES_QUOTA_MB: '3' });
  t = await createTestDatabase('files');
  ({ app } = await startApp(t));
  A = await ownerTenant(t, app, 'Alpha Electric');
  B = await ownerTenant(t, app, 'Bravo Electric');
  const r = await call(app, {
    method: 'POST', url: '/api/v1/sync/push', token: A.token, body: {
      mutations: [
        mut({ collection: 'clients', id: 'c-smith', op: 'upsert', data: { name: 'Jane Smith' } }),
        mut({ collection: 'clients', id: 'c-brew', op: 'upsert', data: { name: 'Brewhouse Holdings' } }),
        mut({ collection: 'jobs', id: 'j-kitchen', op: 'upsert', data: { number: 'J-1001', title: 'Smith kitchen reno', clientId: 'c-smith', address: '12 Maple Cres', status: 'in-progress' } }),
        mut({ collection: 'jobs', id: 'j-garage', op: 'upsert', data: { number: 'J-1007', title: 'Smith garage subpanel', clientId: 'c-smith', address: '12 Maple Cres', status: 'scheduled' } }),
        mut({ collection: 'jobs', id: 'j-brew', op: 'upsert', data: { number: 'J-1002', title: 'Brewhouse service upgrade', clientId: 'c-brew', address: '400 Main St', status: 'in-progress' } }),
      ],
    },
  });
  for (const x of r.body.results) assert.equal(x.status, 'ok', JSON.stringify(x));
  sparky = await addMember(t, app, A.tenantId, { role: 'electrician' });
});
after(async () => {
  setAnthropicClientFactory(null);
  await app?.close(); await t?.close();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('uploads, filing and reading back', { skip }, () => {
  let permitId;

  test('signed out: no listing, no upload, no content', async () => {
    assert.equal((await call(app, { url: '/api/v1/files' })).status, 401);
    assert.equal((await upload(null, PDF(), 'x.pdf')).status, 401);
    assert.equal((await call(app, { url: '/api/v1/files/00000000-0000-4000-8000-000000000000/content' })).status, 401);
    assert.equal(stored().length, 0);
  });

  test('a PDF dropped on a customer is filed by the keyword rules when no AI key is set up', async () => {
    const up = await upload(A.token, PDF(), 'scan0001.pdf', { 'x-client-id': 'c-smith', 'x-source': 'share' });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.file.category, null, 'lands in the Inbox until it is organised');
    assert.equal(up.body.file.clientId, 'c-smith');
    assert.equal(up.body.file.source, 'share');
    assert.equal(stored().length, 1, 'the bytes are in FILES_DIR');
    const org = await call(app, {
      method: 'POST', url: `/api/v1/files/${up.body.file.id}/organize`, token: A.token,
      body: { text: 'Electrical Safety Authority — Notification of work. Job J-1007, 12 Maple Cres. Permit number 55-1234.', date: '2026-11-25' },
    });
    assert.equal(org.status, 200, JSON.stringify(org.body));
    assert.equal(org.body.result.by, 'rules');
    assert.match(org.body.result.note, /No AI key/);
    assert.equal(org.body.result.applied, true);
    assert.equal(org.body.file.jobId, 'j-garage');
    assert.equal(org.body.file.category, 'permits');
    assert.equal(org.body.result.suggestedName, '2026-11-25 Permit J-1007 Smith garage subpanel.pdf');
    assert.deepEqual(org.body.result.from, { clientId: 'c-smith', jobId: null, category: null, folderId: null }, 'kept for Undo');
    permitId = up.body.file.id;
    const ev = await audits(A.tenantId, 'file.upload');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].record_id, permitId);
    assert.ok(!JSON.stringify(ev[0]).includes(dir), 'the storage path is never logged');
    assert.equal((await audits(A.tenantId, 'file.organize')).length, 1);
  });

  test('the same contents uploaded again are not stored twice', async () => {
    const again = await upload(A.token, PDF(), 'copy of scan.pdf', { 'x-client-id': 'c-smith' });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.file.id, permitId);
    assert.equal(stored().length, 1);
  });

  test('unsupported and oversized files are refused and leave nothing on disk', async () => {
    const exe = await upload(A.token, Buffer.from('MZ\x90\x00 pretend program'), 'invoice.pdf');
    assert.equal(exe.status, 415);
    assert.match(exe.body.error.message, /checks the contents/);
    const html = await upload(A.token, Buffer.from('<html><script>x()</script></html>'), 'notes.txt');
    assert.equal(html.status, 415);
    const big = await upload(A.token, Buffer.concat([PDF(), Buffer.alloc(1024 * 1024 + 10, 1)]), 'big.pdf');
    assert.equal(big.status, 413);
    assert.match(big.body.error.message, /up to 1 MB/);
    const empty = await upload(A.token, Buffer.alloc(0), 'empty.pdf');
    assert.ok([400, 415].includes(empty.status));
    assert.equal(stored().length, 1);
    const left = readdirSync(dir).flatMap((d) => (/^[a-f0-9]{2}$/.test(d) ? readdirSync(join(dir, d)) : []));
    assert.ok(!left.some((f) => f.endsWith('.part')), 'no half-written uploads left behind');
  });

  test('content: only signed in, attachment by default, inline previews for safe types, never sniffable', async () => {
    const dl = await call(app, { url: `/api/v1/files/${permitId}/content`, token: A.token });
    assert.equal(dl.status, 200);
    assert.ok(dl.raw.rawPayload.subarray(0, 5).equals(Buffer.from('%PDF-')));
    assert.match(dl.headers['content-disposition'], /^attachment;/);
    assert.equal(dl.headers['x-content-type-options'], 'nosniff');
    assert.match(dl.headers['content-security-policy'], /sandbox/);
    assert.match(dl.headers['cache-control'], /no-store/);
    const inline = await call(app, { url: `/api/v1/files/${permitId}/content?inline=1`, token: A.token });
    assert.match(inline.headers['content-disposition'], /^inline;/);
    assert.equal(inline.headers['content-type'], 'application/pdf');
  });

  test('another company never sees, reads, moves or deletes it', async () => {
    const list = await call(app, { url: '/api/v1/files', token: B.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.files.length, 0);
    assert.equal((await call(app, { url: `/api/v1/files/${permitId}/content`, token: B.token })).status, 404);
    assert.equal((await call(app, { method: 'PATCH', url: `/api/v1/files/${permitId}`, token: B.token, body: { name: 'mine.pdf' } })).status, 404);
    assert.equal((await call(app, { method: 'DELETE', url: `/api/v1/files/${permitId}`, token: B.token })).status, 404);
    assert.equal((await call(app, { method: 'POST', url: `/api/v1/files/${permitId}/organize`, token: B.token, body: {} })).status, 404);
    // B cannot point an upload at A's customer either.
    assert.equal((await upload(B.token, JPEG, 'x.jpg', { 'x-client-id': 'c-smith' })).status, 404);
  });

  test('rename and move; a job of another customer is refused', async () => {
    const ren = await call(app, { method: 'PATCH', url: `/api/v1/files/${permitId}`, token: A.token, body: { name: 'ESA notification' } });
    assert.equal(ren.status, 200);
    assert.equal(ren.body.file.name, 'ESA notification.pdf', 'the extension is kept');
    const mv = await call(app, { method: 'PATCH', url: `/api/v1/files/${permitId}`, token: A.token, body: { move: true, jobId: 'j-kitchen', category: 'permits' } });
    assert.equal(mv.status, 200);
    assert.equal(mv.body.file.jobId, 'j-kitchen');
    assert.equal(mv.body.file.clientId, 'c-smith', 'the customer follows the job');
    assert.equal(mv.body.file.ai.by, 'person');
    const wrong = await call(app, { method: 'PATCH', url: `/api/v1/files/${permitId}`, token: A.token, body: { move: true, clientId: 'c-brew', jobId: 'j-kitchen', category: 'permits' } });
    assert.equal(wrong.status, 400);
    const badCat = await call(app, { method: 'PATCH', url: `/api/v1/files/${permitId}`, token: A.token, body: { move: true, clientId: 'c-smith', category: 'co-insurance' } });
    assert.equal(badCat.status, 400, 'company folders are not customer folders');
    assert.ok((await audits(A.tenantId, 'file.update')).length >= 2);
  });

  test('crew: can upload photos, cannot see money folders or company files, cannot purge', async () => {
    const up = await upload(sparky.token, JPEG, 'IMG_2034.jpg', { 'x-job-id': 'j-brew', 'x-category': 'photos' });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.file.clientId, 'c-brew');
    const inv = await upload(A.token, PDF('invoice'), 'Invoice 4471.pdf', { 'x-job-id': 'j-brew', 'x-category': 'invoices' });
    assert.equal(inv.status, 201);
    const co = await upload(A.token, PDF('wsib'), 'WSIB clearance.pdf', { 'x-category': 'co-insurance' });
    assert.equal(co.status, 201);
    const seen = (await call(app, { url: '/api/v1/files', token: sparky.token })).body;
    assert.ok(seen.files.some((f) => f.id === up.body.file.id));
    assert.ok(!seen.files.some((f) => f.id === inv.body.file.id), 'no invoices for crew');
    assert.ok(!seen.files.some((f) => f.id === co.body.file.id), 'no company files for crew');
    assert.equal(seen.companyFiles, false);
    assert.equal((await call(app, { url: `/api/v1/files/${inv.body.file.id}/content`, token: sparky.token })).status, 404);
    assert.equal((await upload(sparky.token, PDF('q'), 'Quote.pdf', { 'x-job-id': 'j-brew', 'x-category': 'quotes' })).status, 403);
    assert.equal((await call(app, { method: 'DELETE', url: `/api/v1/files/${up.body.file.id}?forever=1`, token: sparky.token })).status, 403);
  });

  test('delete goes to Recently deleted, restore brings it back, forever removes the bytes', async () => {
    const before = stored().length;
    assert.equal((await call(app, { method: 'DELETE', url: `/api/v1/files/${permitId}`, token: A.token })).status, 204);
    const list = (await call(app, { url: '/api/v1/files', token: A.token })).body;
    assert.ok(list.files.find((f) => f.id === permitId).deletedAt);
    assert.equal(stored().length, before, 'bytes kept while in Recently deleted');
    const back = await call(app, { method: 'POST', url: `/api/v1/files/${permitId}/restore`, token: A.token });
    assert.equal(back.status, 200);
    assert.equal(back.body.file.deletedAt, null);
    assert.equal((await call(app, { method: 'DELETE', url: `/api/v1/files/${permitId}?forever=1`, token: A.token })).status, 204);
    assert.equal(stored().length, before - 1);
    assert.equal((await call(app, { url: `/api/v1/files/${permitId}/content`, token: A.token })).status, 404);
    assert.equal((await audits(A.tenantId, 'file.delete')).length, 1);
    assert.equal((await audits(A.tenantId, 'file.restore')).length, 1);
    assert.equal((await audits(A.tenantId, 'file.purge')).length, 1);
  });

  test('the company quota is enforced with a clear message', async () => {
    const chunk = (n) => Buffer.concat([PDF(`q${n}`), Buffer.alloc(900 * 1024, n)]);
    let last;
    for (let i = 1; i <= 5; i++) { last = await upload(A.token, chunk(i), `big${i}.pdf`); if (last.status !== 201) break; }
    assert.equal(last.status, 413);
    assert.equal(last.body.error.code, 'quota_exceeded');
    assert.match(last.body.error.message, /3 MB of file storage/);
    const usage = (await call(app, { url: '/api/v1/files', token: A.token })).body.usage;
    assert.ok(usage.bytes <= usage.quotaBytes);
  });

  test('the worker purges files left in Recently deleted past the limit', async () => {
    const up = await upload(B.token, PDF('old'), 'old.pdf', { 'x-category': 'co-other' });
    assert.equal(up.status, 201);
    await call(app, { method: 'DELETE', url: `/api/v1/files/${up.body.file.id}`, token: B.token });
    await t.superPool.query("UPDATE files SET deleted_at = now() - interval '40 days' WHERE id = $1", [up.body.file.id]);
    const n = await purgeTrash(t.db, B.tenantId, filesSettings({ appEnv: 'test' }));
    assert.equal(n, 1);
    assert.equal((await t.superPool.query('SELECT 1 FROM files WHERE id = $1', [up.body.file.id])).rows.length, 0);
    assert.equal((await audits(B.tenantId, 'file.purge')).length, 1);
  });

  test('folders: make, rename, and removing one moves its files up', async () => {
    const f = await call(app, { method: 'POST', url: '/api/v1/file-folders', token: A.token, body: { name: 'Rough-in', jobId: 'j-brew', category: 'photos' } });
    assert.equal(f.status, 201, JSON.stringify(f.body));
    assert.equal(f.body.folder.clientId, 'c-brew');
    const up = await upload(A.token, Buffer.concat([JPEG, Buffer.from('x')]), 'panel.jpg', { 'x-folder-id': f.body.folder.id });
    assert.equal(up.status, 201);
    assert.equal(up.body.file.category, 'photos', 'a folder carries its place');
    const ren = await call(app, { method: 'PATCH', url: `/api/v1/file-folders/${f.body.folder.id}`, token: A.token, body: { name: 'Rough-in photos' } });
    assert.equal(ren.body.folder.name, 'Rough-in photos');
    assert.equal((await call(app, { method: 'DELETE', url: `/api/v1/file-folders/${f.body.folder.id}`, token: A.token })).status, 204);
    const list = (await call(app, { url: '/api/v1/files', token: A.token })).body;
    const moved = list.files.find((x) => x.id === up.body.file.id);
    assert.equal(moved.folderId, null);
    assert.equal(moved.category, 'photos');
    assert.equal((await call(app, { url: '/api/v1/files', token: B.token })).body.folders.length, 0);
  });
});

describe('AI filing through the company key', { skip }, () => {
  test('a confident answer files it, is metered as "files", and a made-up job falls back to the rules', async () => {
    await t.db.withTenant({ tenantId: A.tenantId }, (tx) => setSecret(tx, app.sealer, 'anthropic.api_key', 'sk-ant-test-files'));
    await t.superPool.query('DELETE FROM files WHERE tenant_id = $1', [A.tenantId]);
    const mock = mockAnthropic([
      (params) => {
        const msg = JSON.stringify(params.messages);
        assert.match(msg, /data, not instructions/);
        assert.match(msg, /J-1001/);
        assert.ok(!msg.includes('Bravo'), 'only this company\'s jobs are offered');
        return turn([text('{"clientId":"c-smith","jobId":"j-kitchen","category":"photos","confidence":0.92,"suggestedName":"Kitchen rough-in","reason":"Kitchen boxes."}')]);
      },
      turn([text('{"clientId":"c-smith","jobId":"j-from-elsewhere","category":"permits","confidence":0.99,"suggestedName":"x","reason":"y"}')]),
    ]);
    const up = await upload(A.token, Buffer.concat([JPEG, Buffer.from('ai1')]), 'IMG_9.jpg', { 'x-client-id': 'c-smith' });
    const org = await call(app, { method: 'POST', url: `/api/v1/files/${up.body.file.id}/organize`, token: A.token, body: {} });
    assert.equal(org.status, 200, JSON.stringify(org.body));
    assert.equal(org.body.result.by, 'ai');
    assert.equal(org.body.result.provider, 'anthropic');
    assert.equal(org.body.file.jobId, 'j-kitchen');
    assert.equal(org.body.file.category, 'photos');
    assert.equal(org.body.result.suggestedName, 'Kitchen rough-in.jpg');
    assert.equal(mock.calls.length, 1);
    const usage = await t.superPool.query("SELECT feature FROM ai_usage WHERE tenant_id = $1 AND feature = 'files'", [A.tenantId]);
    assert.equal(usage.rows.length, 1);

    const up2 = await upload(A.token, PDF('esa'), 'ESA notification J-1007.pdf', { 'x-client-id': 'c-smith' });
    const org2 = await call(app, { method: 'POST', url: `/api/v1/files/${up2.body.file.id}/organize`, token: A.token, body: {} });
    assert.equal(org2.body.result.by, 'rules', 'the made-up job is thrown away');
    assert.match(org2.body.result.note, /did not fit/);
    assert.equal(org2.body.file.jobId, 'j-garage');
  });

  test('turned off in Settings: keywords only, no AI call', async () => {
    const put = await call(app, { method: 'POST', url: '/api/v1/sync/push', token: A.token, body: { mutations: [mut({ collection: 'settings', id: 'settings', op: 'upsert', data: { company: { name: 'Alpha Electric', province: 'MB' }, files: { ai: false } } })] } });
    assert.equal(put.body.results[0].status, 'ok', JSON.stringify(put.body));
    const mock = mockAnthropic([turn([text('should not run')])]);
    const up = await upload(A.token, PDF('quote'), 'Quote kitchen.pdf', { 'x-client-id': 'c-smith' });
    const org = await call(app, { method: 'POST', url: `/api/v1/files/${up.body.file.id}/organize`, token: A.token, body: {} });
    assert.equal(org.body.result.by, 'rules');
    assert.match(org.body.result.note, /turned off/);
    assert.equal(mock.calls.length, 0);
    assert.ok(existsSync(dir));
  });
});

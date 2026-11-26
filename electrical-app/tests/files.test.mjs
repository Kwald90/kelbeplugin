// Files (#/files): the folder layout and keyword classifier (lib/files-classify.js, shared with the
// server), the tree the browser shows (lib/files-tree.js), the import checks and offline queue shape
// (lib/files-api.js), Office/text extraction (lib/files-text.js), shares from other apps
// (lib/files-share.js, sw.js, manifest.webmanifest) and the module wiring.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import {
  CATEGORIES, COMPANY_CATEGORIES, CATEGORY_IDS, MONEY_CATEGORIES, AUTO_FILE_CONFIDENCE, rulesClassify, suggestName, cleanStem, isJunkStem,
  safeName, autoFiles, pickCategory, pickJob, categoryLabel,
} from '../js/lib/files-classify.js';
import {
  parseLoc, locQuery, locHref, startLoc, placeOf, fileInLoc, folderTiles, crumbs, placeLabel, searchFiles, sortFiles, countIndex,
  visibleCategories, fileKind, fmtBytes, isUnsorted, locOfFile, foldersInLoc, jobsOf,
} from '../js/lib/files-tree.js';
import { importProblem, queuedAsFiles, mimeOf } from '../js/lib/files-api.js';
import { zipEntries, zipRead, xmlText, tidyText, extractText } from '../js/lib/files-text.js';
import { nativeItemsToFiles, base64ToFile, SHARE_DB, SHARE_STORE, SHARE_ROUTE } from '../js/lib/files-share.js';
import { SWITCH_BY_ID, moduleOn } from '../js/lib/modules.js';
import { FEATURE_PLAN } from '../js/plans.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const clients = [{ id: 'c1', name: 'Jane Smith' }, { id: 'c2', name: 'Brewhouse Holdings' }, { id: 'c3', name: 'Alder Co' }];
const jobs = [
  { id: 'j1', clientId: 'c1', number: 'J-1001', title: 'Smith kitchen reno', address: '12 Maple Cres, Winnipeg', status: 'in-progress' },
  { id: 'j2', clientId: 'c1', number: 'J-1007', title: 'Smith garage subpanel', address: '12 Maple Cres', status: 'scheduled' },
  { id: 'j3', clientId: 'c2', number: 'J-1002', title: 'Brewhouse service upgrade', address: '400 Main St', status: 'in-progress' },
  { id: 'j4', clientId: null, number: 'J-1010', title: 'Shop lighting', status: 'complete' },
];
const date = '2026-11-25';

describe('folder layout', () => {
  test('every customer and job gets the nine standard folders; the company area has its own', () => {
    assert.deepEqual(CATEGORIES.map((c) => c.label), ['Plans & drawings', 'Permits & inspections', 'Quotes & estimates', 'Invoices & bills', 'Photos', 'Specs & submittals', 'Contracts', 'Correspondence', 'Other']);
    assert.ok(COMPANY_CATEGORIES.length >= 5);
    assert.ok(COMPANY_CATEGORIES.every((c) => c.id.startsWith('co-')));
    assert.equal(new Set(CATEGORY_IDS).size, CATEGORY_IDS.length);
    for (const id of CATEGORY_IDS) assert.match(id, /^[a-z][a-z-]{1,30}$/, 'matches the database CHECK');
    assert.deepEqual(MONEY_CATEGORIES, ['quotes', 'invoices', 'contracts']);
    assert.equal(categoryLabel(null), 'Inbox');
  });
});

describe('keyword rules (the fallback when no AI is set up or offline)', () => {
  const classify = (file, fixed = {}) => rulesClassify(file, { clients, jobs, fixed, date });

  test('a camera photo dropped on a customer with two open jobs is filed at the customer, in Photos', () => {
    const r = classify({ name: 'IMG_2034.jpg', mime: 'image/jpeg' }, { clientId: 'c1' });
    assert.equal(r.category, 'photos');
    assert.equal(r.jobId, null, 'no clue which job: customer level, never a guess');
    assert.ok(autoFiles(r));
    assert.equal(r.suggestedName, '2026-11-25 Photo Jane Smith.jpg');
  });

  test('a job number in the name picks the job; permit words pick the folder', () => {
    const r = classify({ name: 'ESA notification J-1007.pdf', mime: 'application/pdf' }, { clientId: 'c1' });
    assert.equal(r.jobId, 'j2');
    assert.equal(r.category, 'permits');
    assert.ok(r.confidence >= AUTO_FILE_CONFIDENCE);
    assert.match(r.reason, /J-1007/);
    assert.equal(r.suggestedName, 'ESA notification J-1007.pdf', 'a meaningful name is kept');
  });

  test('in the Inbox, the address in the PDF text finds the customer and job', () => {
    const r = classify({ name: 'scan0001.pdf', mime: 'application/pdf', text: 'Electrical Safety Authority Notification of work. Site: 400 Main St. Permit number 123' });
    assert.equal(r.clientId, 'c2');
    assert.equal(r.jobId, 'j3');
    assert.equal(r.category, 'permits');
    assert.equal(r.suggestedName, '2026-11-25 Permit J-1002 Brewhouse service upgrade.pdf');
  });

  test('nothing to go on: it stays in the Inbox with a suggestion', () => {
    const r = classify({ name: 'random.pdf' });
    assert.equal(r.category, null);
    assert.equal(r.clientId, null);
    assert.ok(!autoFiles(r));
    assert.equal(r.suggestion.category, 'other');
  });

  test('a drop on a folder is never second-guessed', () => {
    const r = classify({ name: 'Invoice 9.pdf' }, { jobId: 'j1', category: 'permits' });
    assert.equal(r.category, 'permits');
    assert.equal(r.jobId, 'j1');
    assert.equal(r.clientId, 'c1');
  });

  test('company files use the company folders', () => {
    const r = classify({ name: 'WSIB clearance 2026.pdf' }, { company: true });
    assert.equal(r.category, 'co-insurance');
    assert.ok(autoFiles(r));
    assert.equal(pickCategory({ name: 'Truck registration.pdf' }, { company: true }).category, 'co-vehicles');
  });

  test('forwarding prefixes don\'t make an invoice look like correspondence', () => {
    const r = classify({ name: 'FW_ Copy of Invoice 4471 (2).pdf', text: 'INVOICE Amount due $400 Brewhouse Holdings' });
    assert.equal(r.category, 'invoices');
    assert.equal(r.clientId, 'c2');
    assert.equal(r.suggestedName, 'Invoice 4471.pdf');
  });

  test('drawings by sheet number or CAD type; emails by type', () => {
    assert.equal(classify({ name: 'E-2.1.pdf' }, { jobId: 'j3' }).category, 'plans');
    assert.equal(classify({ name: 'backyard.dwg' }, { jobId: 'j3' }).category, 'plans');
    assert.equal(classify({ name: 'Re schedule.eml' }, { jobId: 'j3' }).category, 'correspondence');
    assert.equal(classify({ name: 'clip.mov', mime: 'video/quicktime' }, { jobId: 'j3' }).category, 'photos');
  });

  test('a job that only shares a street name is not enough on its own when two jobs share it', () => {
    const r = pickJob({ name: 'Maple quote.pdf' }, { clients, jobs, fixed: { clientId: 'c1' } });
    assert.equal(r.jobId, null);
  });

  test('names: tidy, junk detection, safety', () => {
    assert.equal(cleanStem('FW_ Copy of Permit__final (2)'), 'Permit final');
    assert.ok(isJunkStem('IMG_2034'));
    assert.ok(isJunkStem('Screenshot 2026-11-25 at 10.32.11 AM'));
    assert.ok(isJunkStem('scan0001'));
    assert.ok(isJunkStem('3f2a9c1e-77b0-4c1d-9e2f-0a1b2c3d4e5f'));
    assert.ok(!isJunkStem('Panel schedule'));
    assert.equal(safeName('../../etc/passwd'), 'etc-passwd', 'no path separators or leading dots');
    assert.ok(!safeName('a/b\\c:d.pdf').match(/[\\/:]/));
    assert.equal(safeName(''), 'File');
    assert.equal(suggestName({ name: 'scan.PDF', category: 'quotes', job: jobs[0], date }), '2026-11-25 Quote J-1001 Smith kitchen reno.pdf');
  });
});

describe('the folder tree', () => {
  const folders = [
    { id: 'f1', name: 'Rough-in', clientId: 'c1', jobId: 'j1', category: 'photos', parentId: null },
    { id: 'f2', name: 'Kitchen', clientId: 'c1', jobId: 'j1', category: 'photos', parentId: 'f1' },
  ];
  const files = [
    { id: 'a', name: 'ESA.pdf', clientId: 'c1', jobId: 'j2', category: 'permits', createdAt: '2026-11-20T10:00:00Z', bytes: 100, mime: 'application/pdf', text: 'notification 12 maple' },
    { id: 'b', name: 'IMG_1.jpg', clientId: 'c1', jobId: null, category: 'photos', createdAt: '2026-11-21T10:00:00Z', bytes: 3000, mime: 'image/jpeg' },
    { id: 'c', name: 'scan.pdf', clientId: 'c1', jobId: null, category: null, createdAt: '2026-11-22T10:00:00Z', bytes: 50, mime: 'application/pdf' },
    { id: 'd', name: 'WSIB.pdf', clientId: null, jobId: null, category: 'co-insurance', createdAt: '2026-11-19T10:00:00Z', bytes: 10, mime: 'application/pdf' },
    { id: 'e', name: 'panel.jpg', clientId: 'c1', jobId: 'j1', category: 'photos', folderId: 'f2', createdAt: '2026-11-18T10:00:00Z', bytes: 20, mime: 'image/jpeg' },
    { id: 'x', name: 'old.pdf', clientId: 'c2', jobId: 'j3', category: 'quotes', deletedAt: '2026-11-23T00:00:00Z', bytes: 5, mime: 'application/pdf' },
    { id: 'u', name: 'mystery.pdf', clientId: null, jobId: null, category: null, createdAt: '2026-11-24T10:00:00Z', bytes: 5, mime: 'application/pdf' },
  ];
  const data = { files, folders, clients, jobs };

  test('locations round-trip through the address bar and ignore junk', () => {
    for (const loc of [{}, { at: 'inbox' }, { at: 'trash' }, { at: 'company', cat: 'co-insurance' }, { clientId: 'c1' }, { clientId: 'c1', cat: 'photos' }, { jobId: 'j1', cat: 'permits' }, { folderId: 'f1' }]) {
      assert.deepEqual(parseLoc(Object.fromEntries(new URLSearchParams(locQuery(loc)))), loc);
    }
    assert.deepEqual(parseLoc({ c: 'c1', cat: 'co-insurance' }), { clientId: 'c1' }, 'a company folder is not a customer folder');
    assert.deepEqual(parseLoc({ at: 'evil', c: '../x' }), {});
    assert.equal(locHref({ jobId: 'j1' }), '#/files?j=j1');
  });

  test('a focused job opens in its folder unless something else was asked for', () => {
    assert.deepEqual(startLoc({}, 'j1'), { jobId: 'j1' });
    assert.deepEqual(startLoc({ top: '1' }, 'j1'), {});
    assert.deepEqual(startLoc({ at: 'inbox' }, 'j1'), { at: 'inbox' });
    assert.deepEqual(startLoc({}, ''), {});
  });

  test('the top: Inbox, Company files, customers (most used first), jobs with no customer', () => {
    const rank = (list, items, idOf) => (list === 'files.clients' ? [...items].sort((a, b) => (idOf(b) === 'c3') - (idOf(a) === 'c3')) : items);
    const tiles = folderTiles({}, data, { rank });
    assert.deepEqual(tiles.slice(0, 2).map((t) => t.kind), ['inbox', 'company']);
    assert.equal(tiles[0].count, 2, 'scan.pdf and mystery.pdf need sorting');
    assert.equal(tiles[2].label, 'Alder Co', 'most used customer first');
    assert.deepEqual(tiles.slice(3, 5).map((t) => t.label), ['Brewhouse Holdings', 'Jane Smith'], 'then A–Z');
    assert.equal(tiles.at(-1).kind, 'area');
    const crew = folderTiles({}, data, { companyFiles: false });
    assert.ok(!crew.some((t) => t.kind === 'company'));
  });

  test('a customer shows its jobs (open first), then its standard folders; money folders hidden from crew', () => {
    const tiles = folderTiles({ clientId: 'c1' }, data);
    assert.deepEqual(tiles.filter((t) => t.kind === 'job').map((t) => t.loc.jobId), ['j2', 'j1']);
    assert.equal(tiles.filter((t) => t.kind === 'category').length, 9);
    assert.equal(tiles.find((t) => t.key === 'j:j2').count, 1);
    const crew = folderTiles({ clientId: 'c1' }, data, { money: false });
    assert.ok(!crew.some((t) => ['quotes', 'invoices', 'contracts'].includes(t.place?.category)));
    assert.equal(visibleCategories({ money: false }).length, 6);
    assert.deepEqual(jobsOf(jobs, null).map((j) => j.id), ['j4']);
  });

  test('which files sit where; unsorted ones show at their customer too', () => {
    const here = (loc) => files.filter((f) => fileInLoc(f, loc)).map((f) => f.id).sort();
    assert.deepEqual(here({ at: 'inbox' }), ['c', 'u']);
    assert.deepEqual(here({ clientId: 'c1' }), ['c']);
    assert.deepEqual(here({ clientId: 'c1', cat: 'photos' }), ['b']);
    assert.deepEqual(here({ jobId: 'j2', cat: 'permits' }), ['a']);
    assert.deepEqual(here({ at: 'company', cat: 'co-insurance' }), ['d']);
    assert.deepEqual(here({ folderId: 'f2' }), ['e']);
    assert.deepEqual(here({ jobId: 'j1', cat: 'photos' }), [], 'files in a made folder are not loose in its parent');
    assert.deepEqual(here({ at: 'trash' }), ['x']);
    assert.ok(isUnsorted(files[2]));
    assert.deepEqual(locOfFile(files[0]), { jobId: 'j2', cat: 'permits' });
    assert.deepEqual(foldersInLoc(folders, { jobId: 'j1', cat: 'photos' }).map((f) => f.id), ['f1']);
    const count = countIndex(files, folders);
    assert.equal(count('f:f1'), 1, 'folder counts include sub-folders');
    assert.equal(count('trash'), 1);
    assert.equal(count('company'), 1);
  });

  test('breadcrumbs and paths', () => {
    assert.deepEqual(crumbs({ jobId: 'j2', cat: 'permits' }, data).map((c) => c.label), ['Files', 'Jane Smith', 'J-1007 · Smith garage subpanel', 'Permits & inspections']);
    assert.deepEqual(crumbs({ folderId: 'f2' }, data).map((c) => c.label), ['Files', 'Jane Smith', 'J-1001 · Smith kitchen reno', 'Photos', 'Rough-in', 'Kitchen']);
    assert.deepEqual(crumbs({ at: 'company', cat: 'co-insurance' }, data).map((c) => c.label), ['Files', 'Company files', 'Insurance & WSIB']);
    assert.equal(placeLabel(files[0], data), 'Jane Smith › J-1007 · Smith garage subpanel › Permits & inspections');
    assert.equal(placeLabel(files[2], data), 'Inbox (Jane Smith)');
    assert.deepEqual(placeOf({ folderId: 'f2' }, data), { clientId: 'c1', jobId: 'j1', category: 'photos', folderId: 'f2', company: false });
    assert.deepEqual(placeOf({ jobId: 'j3' }, data), { clientId: 'c2', jobId: 'j3', category: null, folderId: null, company: false });
    assert.equal(placeOf({ at: 'company' }, data).company, true);
  });

  test('search reads names, text and the customer/job path; sorting', () => {
    assert.deepEqual(searchFiles(files, 'maple notification', data).map((f) => f.id), ['a']);
    assert.deepEqual(searchFiles(files, 'garage', data).map((f) => f.id), ['a']);
    assert.deepEqual(searchFiles(files, 'old', data), [], 'deleted files are not searched');
    assert.deepEqual(sortFiles(files.slice(0, 3), 'date').map((f) => f.id), ['c', 'b', 'a']);
    assert.deepEqual(sortFiles(files.slice(0, 3), 'size').map((f) => f.id), ['b', 'a', 'c']);
    assert.deepEqual(sortFiles(files.slice(0, 3), 'name').map((f) => f.id), ['a', 'b', 'c']);
  });

  test('kinds and sizes', () => {
    assert.equal(fileKind({ mime: 'application/pdf' }), 'pdf');
    assert.equal(fileKind({ mime: 'image/vnd.dwg', ext: 'dwg' }), 'cad');
    assert.equal(fileKind({ name: 'q.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'office');
    assert.equal(fileKind({ mime: 'video/quicktime' }), 'video');
    assert.equal(fmtBytes(512), '512 B');
    assert.equal(fmtBytes(2 * 1024 * 1024), '2.0 MB');
  });
});

describe('import checks and the offline queue', () => {
  const file = (name, size, type = '') => ({ name, size, type });
  test('empty, too large and program files are caught before uploading, with a clear message', () => {
    assert.match(importProblem(file('a.pdf', 0)), /empty/);
    assert.match(importProblem(file('a.pdf', 80 * 1024 * 1024)), /up to 70 MB/);
    assert.match(importProblem(file('setup.exe', 10)), /Programs/);
    assert.match(importProblem(file('page.html', 10)), /web pages/);
    assert.equal(importProblem(file('plan.pdf', 10)), null);
    assert.equal(mimeOf({ name: 'x.DOCX', type: '' }), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });
  test('waiting uploads show in their folder as pending files', () => {
    const [f] = queuedAsFiles([{ id: 'queued-1', name: 'scan.pdf', size: 9, type: 'application/pdf', place: { clientId: 'c1' }, at: '2026-11-25T00:00:00Z', status: 'queued' }]);
    assert.equal(f.pending, true);
    assert.ok(fileInLoc(f, { at: 'inbox' }));
    assert.ok(fileInLoc(f, { clientId: 'c1' }));
  });
});

describe('text for filing', () => {
  function zip(entries) {
    const parts = [], central = [];
    let offset = 0;
    for (const { name, data, deflate } of entries) {
      const raw = Buffer.from(data);
      const body = deflate ? deflateRawSync(raw) : raw;
      const n = Buffer.from(name);
      const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(deflate ? 8 : 0, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
      const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(deflate ? 8 : 0, 10); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(n.length, 28); cen.writeUInt32LE(offset, 42);
      parts.push(local, n, body); central.push(cen, n);
      offset += 30 + n.length + body.length;
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return new Uint8Array(Buffer.concat([...parts, cd, end]));
  }
  const DOC = '<w:document><w:body><w:p><w:r><w:t>Quote for</w:t></w:r><w:r><w:t xml:space="preserve"> 12 Maple Cres &amp; garage</w:t></w:r></w:p></w:body></w:document>';

  test('reads Word text out of a .docx (stored and deflated entries)', async () => {
    for (const deflate of [false, true]) {
      const bytes = zip([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'word/document.xml', data: DOC, deflate }]);
      const entries = zipEntries(bytes);
      assert.deepEqual(entries.map((e) => e.name), ['[Content_Types].xml', 'word/document.xml']);
      const xml = new TextDecoder().decode(await zipRead(bytes, entries[1]));
      assert.equal(tidyText(xmlText(xml)), 'Quote for 12 Maple Cres & garage');
      const text = await extractText(new File([bytes], 'Quote.docx'));
      assert.equal(text, 'Quote for 12 Maple Cres & garage');
    }
  });

  test('plain text and CSV are read directly; unreadable files give no text', async () => {
    assert.equal(await extractText(new File(['Permit  number\n 55-1234'], 'notes.txt', { type: 'text/plain' })), 'Permit number 55-1234');
    assert.equal(await extractText(new File([new Uint8Array([1, 2, 3])], 'thing.bin')), '');
    assert.equal(await extractText(new File(['not a zip'], 'broken.docx')), '');
  });
});

describe('Send to Fishtape (shares from other apps)', () => {
  test('the manifest declares a POST multipart share target that the service worker handles', () => {
    const m = JSON.parse(read('../manifest.webmanifest'));
    assert.equal(m.share_target.action, './share-target');
    assert.equal(m.share_target.method, 'POST');
    assert.equal(m.share_target.enctype, 'multipart/form-data');
    assert.equal(m.share_target.params.files[0].name, 'files');
    assert.ok(m.share_target.params.files[0].accept.includes('application/pdf'));
    const sw = read('../sw.js');
    assert.match(sw, /share-target/);
    assert.match(sw, /form\.getAll\('files'\)/);
    assert.ok(sw.includes(`indexedDB.open('${SHARE_DB}', 1)`), 'same database as lib/files-share.js');
    assert.ok(sw.includes(`createObjectStore('${SHARE_STORE}', { autoIncrement: true })`));
    assert.ok(sw.includes(SHARE_ROUTE.slice(1)), 'opens the Files import');
    assert.match(sw, /Response\.redirect\(.*, 303\)/);
  });

  test('files from the native plugins become File objects; ones without data are reported', () => {
    const { files, skipped } = nativeItemsToFiles([
      { name: 'permit.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64') },
      { name: 'huge.mov', mimeType: 'video/quicktime', error: 'too large' },
    ]);
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'permit.pdf');
    assert.equal(files[0].type, 'application/pdf');
    assert.equal(files[0].size, 8);
    assert.deepEqual(skipped, [{ name: 'huge.mov', reason: 'too large' }]);
    assert.equal(base64ToFile(Buffer.from('hi').toString('base64'), 'a.txt', 'text/plain').size, 2);
  });
});

describe('module wiring', () => {
  test('Files is a module with a switch (on by default) and a plan', () => {
    assert.ok(SWITCH_BY_ID.files);
    assert.equal(SWITCH_BY_ID.files.core, true);
    assert.equal(moduleOn({ modules: { files: false } }, 'files'), false);
    assert.equal(moduleOn({}, 'files'), true);
    assert.equal(FEATURE_PLAN.files, 'pro');
    const index = read('../js/modules/index.js');
    assert.match(index, /import files from '\.\/files\.js';/);
  });

  test('the module and its libraries keep to the CSP: no inline styles or HTML strings', () => {
    for (const p of ['../js/modules/files.js', '../js/lib/files-tree.js', '../js/lib/files-api.js', '../js/lib/files-share.js', '../js/lib/files-text.js']) {
      const src = read(p);
      assert.ok(!/innerHTML|style:\s*'|setAttribute\('style'|eval\(|new Function/.test(src), p);
    }
  });
});

// Run: node --test electrical-app/tests/
// CSV parsing, XLSX reading, importer presets and mapping, money/unit/date normalisation,
// duplicates, QuickBooks export rows and tax codes, notifications and onboarding steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { parseCSV, createCsvParser, withHeaders, toCSV, csvCell, readXlsx, excelSerialToISO, decodeText, rowsFromBuffer } from '../js/lib/csv.js';
import * as I from '../js/lib/importers.js';
import * as Q from '../js/lib/qbo-export.js';
import { deriveNotifications, mergeNotifications, unreadCount, addNotificationSource, pruneReadKeys } from '../js/lib/notify.js';
import { taxComponents } from '../js/lib/tax.js';
import { docTotals } from '../js/lib/money.js';

// ---- CSV -------------------------------------------------------------------------------

test('CSV: quotes, escaped quotes, commas and line breaks inside fields, CRLF, BOM', () => {
  const text = '﻿Name,Notes,Amount\r\n"Smith, Jo","He said ""hi""\nthen left",12.50\r\nPlain,,3\n';
  assert.deepEqual(parseCSV(text), [['Name', 'Notes', 'Amount'], ['Smith, Jo', 'He said "hi"\nthen left', '12.50'], ['Plain', '', '3']]);
});

test('CSV: lone CR line ends, blank lines dropped, empty quoted fields, trailing delimiter', () => {
  assert.deepEqual(parseCSV('a,b\rc,d\r\r\n\n"",x,\n'), [['a', 'b'], ['c', 'd'], ['', 'x', '']]);
});

test('CSV: semicolon and tab delimiters are detected', () => {
  assert.deepEqual(parseCSV('a;b;c\n1;"2;5";3'), [['a', 'b', 'c'], ['1', '2;5', '3']]);
  assert.deepEqual(parseCSV('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

test('CSV: the incremental parser gives the same rows when fed in pieces (split inside quotes)', () => {
  const text = 'h1,h2\n"multi\nline, with ""quotes""",2\nx,y';
  const p = createCsvParser();
  const rows = [];
  for (let i = 0; i < text.length; i += 3) rows.push(...p.push(text.slice(i, i + 3)));
  rows.push(...p.end());
  assert.deepEqual(rows, parseCSV(text));
  // "" split between two chunks
  const q = createCsvParser();
  const r2 = [...q.push('a\n"x"'), ...q.push('"y"'), ...q.end()];
  assert.deepEqual(r2, [['a'], ['x"y']]);
});

test('CSV: headers made unique; blank rows removed', () => {
  const { headers, rows } = withHeaders([['Phone', 'Phone', ''], ['1', '2', '3'], ['', '', '']]);
  assert.deepEqual(headers, ['Phone', 'Phone (2)', 'Column 3']);
  assert.equal(rows.length, 1);
});

test('CSV out: quoting, formula guard, numbers left alone, round trip', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('-12.50'), '-12.50');
  assert.equal(csvCell('-cmd'), "'-cmd");
  assert.equal(csvCell(-3), '-3');
  const rows = [['x', 'y'], ['He said "hi"', 'two\nlines']];
  assert.deepEqual(parseCSV(toCSV(rows)), rows);
  assert.ok(toCSV(rows).endsWith('\r\n'));
});

test('Windows-1252 files from old Excel decode', () => {
  const bytes = new Uint8Array([0x43, 0x61, 0x66, 0xe9]); // "Café" in cp1252, invalid UTF-8
  assert.equal(decodeText(bytes.buffer), 'Café');
});

// A tiny .xlsx built by hand: shared strings, an inline string, a number, a date-styled cell.
function zip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(enc.encode(text));
    const nameB = enc.encode(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt16LE(nameB.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(data.length, 20); cen.writeUInt16LE(nameB.length, 28); cen.writeUInt32LE(offset, 42);
    parts.push(local, nameB, data); central.push(cen, nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  const buf = Buffer.concat([...parts, cd, end]);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
}

test('XLSX: first sheet to rows (shared and inline strings, numbers, dates, gaps)', async () => {
  const x = zip({
    'xl/sharedStrings.xml': '<sst><si><t>Product/Service Name</t></si><si><t>Sales Price / Rate</t></si><si><r><t>Wire </t></r><r><t>&amp; cable</t></r></si><si><t>As of</t></si></sst>',
    'xl/styles.xml': '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>3</v></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12.5</v></c><c r="C2" t="inlineStr"><is><t>note</t></is></c><c r="D2" s="1"><v>46314</v></c></row></sheetData></worksheet>',
  });
  const rows = await readXlsx(x);
  assert.deepEqual(rows, [['Product/Service Name', 'Sales Price / Rate', '', 'As of'], ['Wire & cable', '12.5', 'note', '2026-10-19']]);
  assert.deepEqual(await rowsFromBuffer(x), rows);
  assert.equal(excelSerialToISO(46314), '2026-10-19');
});

// ---- normalisation -----------------------------------------------------------------------

test('money to exact cents', () => {
  const c = (s) => I.parseMoneyCents(s).cents;
  assert.equal(c('$1,234.56'), 123456);
  assert.equal(c('CA$ 12'), 1200);
  assert.equal(c('(45.00)'), -4500);
  assert.equal(c('1 234,56 $'), 123456);
  assert.equal(c('1.234,56'), 123456);
  assert.equal(c('12,5'), 1250);
  assert.equal(c('12,345'), 1234500);
  assert.equal(c('0.1'), 10);
  assert.equal(c('19.999'), 2000);
  assert.equal(c('-3.005'), -301);
  assert.equal(c(4.35), 435);
  assert.equal(I.parseMoneyCents('abc').ok, false);
  assert.equal(I.parseMoneyCents('').empty, true);
});

test('units normalised to the tokens wire runs price from', () => {
  const u = I.normalizeUnit;
  assert.equal(u('Each'), 'ea'); assert.equal(u('EA.'), 'ea'); assert.equal(u(''), 'ea'); assert.equal(u('pcs'), 'ea');
  assert.equal(u('LF'), 'ft'); assert.equal(u('feet'), 'ft'); assert.equal(u('per 100 ft'), '100ft'); assert.equal(u('C'), '100ft');
  assert.equal(u('MFT'), '1000ft'); assert.equal(u('Metre'), 'm'); assert.equal(u('hrs'), 'h'); assert.equal(u('Coil'), 'roll');
  assert.equal(u('Stick'), 'stick'); assert.equal(u('Box'), 'box');
});

test('dates in many shapes; order detected', () => {
  assert.equal(I.parseDate('2026-10-19'), '2026-10-19');
  assert.equal(I.parseDate('10/19/2026'), '2026-10-19');
  assert.equal(I.parseDate('19/10/2026'), '2026-10-19');
  assert.equal(I.parseDate('03/04/2026', { order: 'dmy' }), '2026-04-03');
  assert.equal(I.parseDate('03/04/2026'), '2026-03-04');
  assert.equal(I.parseDate('Oct 19, 2026'), '2026-10-19');
  assert.equal(I.parseDate('19-Oct-2026'), '2026-10-19');
  assert.equal(I.parseDate('46314'), '2026-10-19');
  assert.equal(I.parseDate('2026-02-30'), null);
  assert.equal(I.parseDate('soon'), null);
  assert.equal(I.detectDateOrder(['01/02/2026', '25/02/2026']), 'dmy');
  assert.equal(I.detectDateOrder(['02/25/2026']), 'mdy');
  assert.equal(I.detectDateOrder(['01/02/2026']), null);
});

test('roles, job statuses and client types from other systems', () => {
  assert.equal(I.normalizeRole('Journeyman Electrician'), 'electrician');
  assert.equal(I.normalizeRole('2nd year apprentice'), 'apprentice');
  assert.equal(I.normalizeRole('Site Foreman'), 'foreman');
  assert.equal(I.normalizeRole('Office Manager'), 'admin');
  assert.equal(I.normalizeJobStatus('Requires invoicing'), 'complete');
  assert.equal(I.normalizeJobStatus('Active'), 'in-progress');
  assert.equal(I.normalizeJobStatus('Upcoming'), 'scheduled');
  assert.equal(I.normalizeClientType('TRUE'), 'commercial');
  assert.equal(I.normalizeClientType('homeowner'), 'residential');
  assert.equal(I.normalizeClientType('', { company: 'Acme Ltd' }), 'commercial');
});

// ---- presets and mapping -----------------------------------------------------------------

test('presets are detected from export headers', () => {
  assert.equal(I.detectPreset(['J-ID', 'Display Name', 'Is Company?', 'Billing Street', 'Main Phone', 'Archived']).id, 'jobber-clients');
  assert.equal(I.detectPreset(['Product/Service Name', 'Sales Description', 'SKU', 'Type', 'Sales Price / Rate', 'Income Account', 'Purchase Cost', 'Expense Account']).id, 'qbo-products');
  assert.equal(I.detectPreset(['Customer', 'Phone Numbers', 'Email', 'Full Name', 'Billing Address', 'Customer Type']).id, 'qbo-customers');
  assert.equal(I.detectPreset(['Display name', 'First name', 'Last name', 'Mobile number', 'Home number', 'Work number', 'Emails', 'Service address']).id, 'hcp-customers');
  assert.equal(I.detectPreset(['Name', 'Email'], 'clients').id, 'generic-clients');
  assert.equal(I.detectPreset(['Whatever']), null);
});

test('QuickBooks products: mapping, money, units and quantity on hand', () => {
  const headers = ['Product/Service Name', 'Sales Description', 'SKU', 'Type', 'Sales Price / Rate', 'Income Account', 'Purchase Description', 'Purchase Cost', 'Expense Account', 'Quantity On Hand', 'Reorder Point'];
  const map = I.autoMap(headers, 'items', 'qbo-products');
  assert.equal(map.name, 0); assert.equal(map.sku, 2); assert.equal(map.priceCents, 4); assert.equal(map.costCents, 7); assert.equal(map.qtyOnHand, 9);
  const r = I.normalizeRow(['Decora switch 15A', 'Single pole, white', 'SW-DEC-15', 'Inventory', '$18.95', 'Sales', '', '6.10', 'COGS', '24', '10'], map, 'items', { presetId: 'qbo-products' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.record.priceCents, 1895);
  assert.equal(r.record.costCents, 610);
  assert.equal(r.record.unit, 'ea');
  assert.equal(r.record.reorderPoint, 10);
  assert.equal(r.extra.qtyOnHand, 24);
  assert.equal(r.record.description, 'Single pole, white');
  const bad = I.normalizeRow(['', '', 'X', '', 'twelve', '', '', '', '', '', ''], map, 'items', { presetId: 'qbo-products' });
  assert.equal(bad.record, null);
  assert.ok(bad.errors.some((e) => /not an amount/.test(e)));
});

test('Jobber clients: name, address from parts, first of several phones, company type', () => {
  const headers = ['J-ID', 'Display Name', 'First Name', 'Last Name', 'Company Name', 'Is Company?', 'Main Phone', 'Mobile Phone', 'Email', 'Billing Street', 'Billing City', 'Billing Province', 'Billing Postal Code', 'Tags', 'Note'];
  const map = I.autoMap(headers, 'clients', 'jobber-clients');
  map.__alts = I.altColumns(headers, 'jobber-clients');
  const r = I.normalizeRow(['42', 'Harbour Dental', 'Pat', 'Lee', 'Harbour Dental', 'TRUE', '', '(306) 555-0142', 'OPS@Harbour.example', '42 Harbour St', 'Regina', 'sk', 's4p3y2', 'repeat, vip', 'Gate 1234'], map, 'clients', { presetId: 'jobber-clients' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.record.name, 'Harbour Dental');
  assert.equal(r.record.email, 'ops@harbour.example');
  assert.equal(r.record.phone, '(306) 555-0142', 'empty Main Phone falls through to Mobile Phone');
  assert.equal(r.record.address, '42 Harbour St, Regina, SK S4P3Y2');
  assert.equal(r.record.type, 'commercial');
  assert.deepEqual(r.record.tags, ['repeat', 'vip']);
  assert.match(r.record.notes, /Gate 1234/);
  const noName = I.normalizeRow(['1', '', 'Sam', 'Ray', '', 'FALSE', '', '', 'bad-email', '', '', '', '', '', ''], map, 'clients', { presetId: 'jobber-clients' });
  assert.ok(noName.errors.some((e) => /Email/.test(e)), 'a bad email is a row error');
});

test('generic mapping by aliases, including "contains" matches', () => {
  const map = I.autoMap(['Customer Name', 'Customer Email Address', 'Cell', 'Street Address', 'Town', 'Prov', 'Zip'], 'clients');
  assert.equal(map.name, 0); assert.equal(map.email, 1); assert.equal(map.phone, 2); assert.equal(map.street, 3); assert.equal(map.city, 4); assert.equal(map.postal, 6);
});

test('jobs and employees rows', () => {
  const jm = I.autoMap(['Job #', 'Title', 'Client', 'Status', 'Start Date', 'End Date'], 'jobs');
  const j = I.normalizeRow(['1042', 'Service upgrade', 'Linden Residence', 'Active', '19/10/2026', '20/10/2026'], jm, 'jobs', { dateOrder: 'dmy' });
  assert.deepEqual(j.errors, []);
  assert.equal(j.record.status, 'in-progress');
  assert.equal(j.record.startDate, '2026-10-19');
  assert.equal(j.extra.client, 'Linden Residence');
  const em = I.autoMap(['First Name', 'Last Name', 'Position', 'Hourly Rate', 'License Number', 'License Expiration', 'Active'], 'employees');
  const e = I.normalizeRow(['Sam', 'Rivera', 'Foreman', '$52.50', 'ME-1', '2027-03-31', 'yes'], em, 'employees');
  assert.deepEqual(e.errors, []);
  assert.equal(e.record.name, 'Sam Rivera');
  assert.equal(e.record.rateCents, 5250);
  assert.equal(e.record.role, 'foreman');
});

test('duplicates: in the file and against existing records, by email, phone, name or SKU', () => {
  const map = I.autoMap(['Name', 'Email', 'Phone'], 'clients');
  const state = I.newPlanState('clients', [{ id: 'c1', name: 'Old Client', email: 'old@x.example', phone: '' }, { id: 'c2', name: 'Phone Only', phone: '+1 306-555-0100' }]);
  const { items } = I.planRows([
    ['New Person', 'new@x.example', ''],
    ['Someone', 'OLD@x.example', ''],
    ['Other', '', '(306) 555-0100'],
    ['New  person!', '', ''],
    ['', '', ''],
  ], { targetId: 'clients', map, state, mode: 'skip' });
  assert.deepEqual(items.map((i) => i.action), ['create', 'skip', 'skip', 'skip', 'error']);
  assert.equal(items[1].id, 'c1');
  assert.equal(items[2].id, 'c2');
  assert.match(items[3].warnings.join(), /row 2/);
  const upd = I.planRows([['Someone', 'old@x.example', '306 555 0199']], { targetId: 'clients', map, state: I.newPlanState('clients', [{ id: 'c1', name: 'Old Client', email: 'old@x.example' }]), mode: 'update' });
  assert.equal(upd.items[0].action, 'update');
  assert.deepEqual(I.mergePatch('clients', { name: 'Old Client', email: 'old@x.example', phone: '', tags: ['a'], type: 'commercial' }, { ...upd.items[0].record, tags: ['b'] }, upd.items[0].provided),
    { name: 'Someone', phone: '306 555 0199', tags: ['a', 'b'] }, 'only what the file gave; the default type does not overwrite');
  const items2 = I.planRows([['W', 'sku-1'], ['W2', ' SKU-1 ']], { targetId: 'items', map: I.autoMap(['Name', 'SKU'], 'items'), state: I.newPlanState('items', []) }).items;
  assert.deepEqual(items2.map((i) => i.action), ['create', 'skip']);
  assert.deepEqual(I.planSummary(items), { create: 1, update: 0, skip: 3, error: 1, warnings: 3 });
});

test('a 2,000-row client file plans in well under a second', () => {
  const rows = Array.from({ length: 2000 }, (_, i) => [`Client ${i}`, `c${i}@x.example`, `306-555-${String(i).padStart(4, '0')}`]);
  const map = I.autoMap(['Name', 'Email', 'Phone'], 'clients');
  const t0 = Date.now();
  const state = I.newPlanState('clients', []);
  let creates = 0;
  for (let i = 0; i < rows.length; i += 200) creates += I.planRows(rows.slice(i, i + 200), { targetId: 'clients', map, state, startLine: i + 2 }).items.filter((x) => x.action === 'create').length;
  assert.equal(creates, 2000);
  assert.ok(Date.now() - t0 < 1000);
});

test('templates have one header per field and a valid example', () => {
  for (const t of Object.keys(I.TARGETS)) {
    const [hdr, ex] = I.templateRows(t);
    assert.equal(hdr.length, I.TARGETS[t].fields.length, t);
    const r = I.normalizeRow(ex, I.autoMap(hdr, t), t, { dateOrder: 'mdy' });
    assert.deepEqual(r.errors, [], t);
  }
});

// ---- QuickBooks export ----------------------------------------------------------------------

const inv = (o) => ({ id: o.id || 'i1', number: 'INV-3001', clientId: 'c1', status: 'sent', issueDate: '2026-10-05', dueDate: '2026-10-19', lines: [], ...o });

test('tax codes per line follow the document taxes and province', () => {
  const on = inv({ taxProvince: 'ON', taxes: taxComponents({ province: 'ON', treatment: 'standard', date: '2026-10-05' }) });
  assert.equal(Q.taxCodeFor(on, 'material'), 'HST ON');
  const bcReal = inv({ taxProvince: 'BC', taxes: taxComponents({ province: 'BC', treatment: 'real-property', date: '2026-10-05' }) });
  assert.equal(Q.taxCodeFor(bcReal, 'material'), 'GST', 'real property contract: GST only');
  const bcGoods = inv({ taxProvince: 'BC', lines: [{ qty: 1, unitCents: 100, kind: 'material' }, { qty: 1, unitCents: 100, kind: 'labour' }], taxes: taxComponents({ province: 'BC', treatment: 'separate-goods', date: '2026-10-05' }) });
  assert.equal(Q.taxCodeFor(bcGoods, 'material'), 'GST/PST BC');
  assert.equal(Q.taxCodeFor(bcGoods, 'labour'), 'GST');
  const sk = inv({ taxProvince: 'SK', taxes: taxComponents({ province: 'SK', treatment: 'pst-all', date: '2026-10-05' }) });
  assert.equal(Q.taxCodeFor(sk, 'labour'), 'GST/PST SK');
  const mb = inv({ taxProvince: 'MB', taxes: taxComponents({ province: 'MB', treatment: 'pst-all', date: '2026-10-05' }) });
  assert.equal(Q.taxCodeFor(mb, 'material'), 'GST/PST MB');
  assert.equal(Q.taxCodeFor(inv({ taxProvince: 'AB', taxes: [] }), 'material'), 'Exempt');
  assert.equal(Q.taxCodeFor(on, 'material', { 'HST|ON': 'H' }), 'H', 'the company’s own names win');
  assert.equal(Q.taxCodeFor(inv({ taxPct: 13 }), 'material'), 'Tax 13%');
  assert.deepEqual(Q.taxKeysUsed([bcGoods]).map((k) => k.key).sort(), ['GST', 'GST+PST|BC'].sort());
});

test('invoice rows: one per line, markup line, totals match, problems reported', () => {
  const taxes = taxComponents({ province: 'ON', treatment: 'standard', date: '2026-10-05' });
  const a = inv({ taxProvince: 'ON', taxes, markupPct: 10, notes: 'Thanks!', lines: [
    { description: 'Receptacle', qty: 12, unitCents: 1200, kind: 'material' },
    { description: 'Labour', qty: 3.5, unitCents: 9500, kind: 'labour' },
  ] });
  const neg = inv({ id: 'i2', number: 'INV-3002', taxes, lines: [{ description: 'Discount', qty: 1, unitCents: -500, kind: 'other' }] });
  const orphan = inv({ id: 'i3', number: 'INV-3003', clientId: null, lines: [{ description: 'x', qty: 1, unitCents: 100, kind: 'other' }] });
  const names = Q.customerNames([{ id: 'c1', name: 'Harbour: Dental "Clinic"' }]);
  const r = Q.invoiceRows({ invoices: [a, neg, orphan], names, dateFormat: 'DD/MM/YYYY' });
  assert.deepEqual(r.rows[0], Q.INVOICE_HEADERS);
  assert.equal(r.count, 1);
  assert.equal(r.rows.length, 4);
  assert.deepEqual(r.rows[1].slice(0, 4), ['INV-3001', 'Harbour Dental Clinic', '05/10/2026', '19/10/2026']);
  assert.deepEqual(r.rows[1].slice(6, 12), ['Materials', 'Receptacle', '12', '12', '144.00', 'HST ON']);
  assert.deepEqual(r.rows[2].slice(6, 12), ['Labour', 'Labour', '3.5', '95', '332.50', 'HST ON']);
  assert.deepEqual(r.rows[3].slice(6, 11), ['Materials', 'Materials markup (10%)', '1', '14.4', '14.40']);
  const sum = r.rows.slice(1).reduce((s, x) => s + Math.round(Number(x[10]) * 100), 0);
  assert.equal(sum, docTotals(a).subtotalCents);
  assert.deepEqual(r.problems.map((p) => p.number), ['INV-3002', 'INV-3003']);
  assert.equal(Q.fmtDay('2026-10-05', 'MM/DD/YYYY'), '10/05/2026');
});

test('files split at QuickBooks limits without splitting an invoice', () => {
  const rows = [['InvoiceNo', 'x']];
  for (let i = 0; i < 150; i++) for (let l = 0; l < 3; l++) rows.push([`INV-${i}`, l]);
  const files = Q.splitFiles(rows, { maxRows: 1000, maxInvoices: 100, keyIndex: 0 });
  assert.equal(files.length, 2);
  assert.equal(new Set(files[0].slice(1).map((r) => r[0])).size, 100);
  for (const f of files) assert.deepEqual(f[0], ['InvoiceNo', 'x']);
  const big = [['n'], ...Array.from({ length: 2500 }, (_, i) => [i])];
  assert.deepEqual(Q.splitFiles(big, { maxRows: 1000 }).map((f) => f.length - 1), [1000, 1000, 500]);
});

test('customers: unique QuickBooks names and address split', () => {
  const names = Q.customerNames([{ id: 'a', name: 'Lee', createdAt: '1' }, { id: 'b', name: 'lee', createdAt: '2' }, { id: 'c', name: 'Lee', createdAt: '3' }]);
  assert.deepEqual([...names.values()], ['Lee', 'lee (2)', 'Lee (3)']);
  assert.deepEqual(Q.splitAddress('42 Harbour St, Regina, SK S4P 3Y2'), { street: '42 Harbour St', city: 'Regina', province: 'SK', postal: 'S4P 3Y2', country: '' });
  assert.deepEqual(Q.splitAddress('Unit 4, 9 Linden Ct, Calgary AB t2p1j9, Canada'), { street: 'Unit 4, 9 Linden Ct', city: 'Calgary', province: 'AB', postal: 'T2P 1J9', country: 'Canada' });
  const rows = Q.customerRows([{ id: 'a', name: 'Acme Ltd', type: 'commercial', email: 'a@x.example', phone: '306', address: '1 Main St, Regina, SK' }]);
  assert.deepEqual(rows[0], Q.CUSTOMER_HEADERS);
  assert.deepEqual(rows[1], ['Acme Ltd', 'Acme Ltd', 'a@x.example', '306', '1 Main St', 'Regina', 'SK', '', 'Canada']);
});

test('payment rows (SaasAnt layout) and the generic summary', () => {
  const taxes = taxComponents({ province: 'AB', treatment: 'standard', date: '2026-10-05' });
  const a = inv({ taxProvince: 'AB', taxes, lines: [{ description: 'Work', qty: 1, unitCents: 10000, kind: 'labour' }] });
  const names = Q.customerNames([{ id: 'c1', name: 'Client' }]);
  const r = Q.paymentRows({ payments: [{ invoiceId: 'i1', amountCents: 5250, date: '2026-10-10', method: 'e-transfer', reference: 'ABC' }, { invoiceId: 'gone', amountCents: 1, date: '2026-10-11' }, { invoiceId: 'i1', amountCents: 1, date: '2026-09-01' }],
    invoicesById: new Map([['i1', a]]), names, from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(r.rows[0], Q.PAYMENT_HEADERS);
  assert.deepEqual(r.rows[1], ['P-0001', 'Client', '10/10/2026', 'E-Transfer', 'Undeposited Funds', 'INV-3001', '52.50', 'ABC', '', 'CAD']);
  assert.equal(r.problems.length, 1);
  const g = Q.genericInvoiceRows({ invoices: [a], names, paidOf: () => 5250 });
  assert.deepEqual(g[0].slice(-5), ['GST', 'Tax total', 'Total', 'Paid', 'Balance']);
  assert.deepEqual(g[1].slice(-5), ['5.00', '5.00', '105.00', '52.50', '52.50']);
  assert.deepEqual(Q.invoicesInRange([a, inv({ id: 'd', status: 'draft' }), inv({ id: 'v', status: 'void' }), inv({ id: 'o', issueDate: '2026-11-01' })], { from: '2026-10-01', to: '2026-10-31' }).map((i) => i.id), ['i1']);
});

// ---- notifications ------------------------------------------------------------------------

function fakeStore(data) {
  return { list: (c, pred) => (data[c] || []).filter((r) => !pred || pred(r)) };
}

test('derived notifications: my jobs, time to approve, expiring permits and licences', () => {
  const now = new Date('2026-10-19T15:00:00Z');
  const store = fakeStore({
    jobs: [{ id: 'j1', number: 'J-1', title: 'Panel', crewIds: ['e1'], status: 'scheduled', updatedAt: '2026-10-18T00:00:00Z' }, { id: 'j2', crewIds: ['e1'], status: 'complete' }, { id: 'j3', crewIds: ['e2'], status: 'scheduled' }],
    timeEntries: [{ id: 't1', employeeId: 'e2', clockOut: '2026-10-18T22:00:00Z', approved: false }, { id: 't2', employeeId: 'e2', clockOut: '2026-10-18T23:00:00Z', approved: true }, { id: 't3', employeeId: 'e1', clockOut: '2026-10-18T23:00:00Z', approved: false }],
    permits: [{ id: 'p1', number: 'EP-9', status: 'issued', expiryDate: '2026-10-24' }, { id: 'p2', status: 'issued', expiryDate: '2027-10-24' }],
    certifications: [],
    employees: [{ id: 'e1', name: 'Me', licenceExpiry: '2026-11-01' }, { id: 'e2', name: 'Sam', licenceExpiry: '2026-10-01' }],
  });
  const all = deriveNotifications(store, { employeeId: 'e1', can: () => true }, now);
  const keys = all.map((n) => n.key);
  assert.ok(keys.includes('job:j1:e1'));
  assert.ok(!keys.some((k) => k.startsWith('job:j2') || k.startsWith('job:j3')));
  const time = all.find((n) => n.kind === 'timesheet');
  assert.equal(time.title, '1 time entry waiting for approval', 'my own entries are not mine to approve');
  assert.ok(all.find((n) => n.key.startsWith('exp:permit:p1')).title.includes('5 days'));
  assert.ok(all.find((n) => n.key.startsWith('exp:lic:e2')).title.includes('expired 18 days ago'));
  assert.ok(all.find((n) => n.key.startsWith('exp:lic:e1')).title.startsWith('Your licence'));
  const crew = deriveNotifications(store, { employeeId: 'e1', can: (p) => ['jobs', 'time'].includes(p) }, now);
  assert.deepEqual(crew.map((n) => n.kind).sort(), ['expiring', 'job_assigned'], 'no approvals, no permits, only my licence');
  const off = addNotificationSource(() => [{ key: 'ann:1', title: 'Office closed Monday', link: '#/dashboard', at: '2026-10-19T00:00:00Z' }]);
  assert.ok(deriveNotifications(store, { employeeId: null, can: () => false }, now).some((n) => n.kind === 'announcement'));
  off();
});

test('merging server and derived items, read state and pruning', () => {
  const list = mergeNotifications(
    [{ id: 's1', kind: 'payment', title: 'Paid', createdAt: '2026-10-19T10:00:00Z', readAt: null }, { id: 's2', kind: 'lead', title: 'Lead', createdAt: '2026-10-17T10:00:00Z', readAt: '2026-10-18T00:00:00Z' }],
    [{ key: 'job:j1:e1', kind: 'job_assigned', title: 'Job', at: '2026-10-18T00:00:00Z' }, { key: 'time:1:t1', kind: 'timesheet', title: 'Time', at: '2026-10-16T00:00:00Z' }],
    new Set(['time:1:t1', 'stale']));
  assert.deepEqual(list.map((i) => i.title), ['Paid', 'Job', 'Lead', 'Time']);
  assert.equal(unreadCount(list), 2);
  assert.deepEqual(pruneReadKeys(new Set(['time:1:t1', 'stale']), [{ key: 'time:1:t1' }]), ['time:1:t1']);
});

// ---- onboarding ---------------------------------------------------------------------------

test('onboarding steps tick themselves off from real data', async () => {
  const { detectSteps, progress, showFor } = await import('../js/modules/onboarding.js');
  const { DEFAULT_SETTINGS } = await import('../js/store.js');
  const fresh = detectSteps({ settings: structuredClone(DEFAULT_SETTINGS), synced: true, items: 0, jobs: 0, planSets: 0, employees: 1, server: { members: 1 } });
  assert.equal(fresh.length, 9);
  assert.equal(progress(fresh).done, 0);
  assert.equal(progress(fresh).next.id, 'company');
  const s = structuredClone(DEFAULT_SETTINGS);
  Object.assign(s.company, { name: 'TG Electrical', phone: '403-555-0100', gstHstNo: '123456789 RT0001', province: 'AB', logo: 'data:image/png;base64,xx' });
  s.labourRateCents = 11000;
  s.onboarding = { skipped: { plans: true } };
  const steps = detectSteps({ settings: s, synced: true, items: 120, jobs: 1, planSets: 0, employees: 3, server: { members: 4, pins: 2, payments: true } });
  const by = Object.fromEntries(steps.map((x) => [x.id, x]));
  for (const id of ['company', 'province', 'logo', 'rates', 'pricebook', 'crew', 'connect', 'job']) assert.ok(by[id].done, id);
  assert.ok(by.plans.skipped && !by.plans.done);
  assert.match(by.crew.detail, /4 members · 2 with a PIN/);
  assert.equal(progress(steps).complete, true);
  // A bad GST/HST number keeps the company step open, and says what is missing.
  s.company.gstHstNo = '123';
  const again = detectSteps({ settings: s, synced: false, items: 0, jobs: 0, planSets: 0, employees: 1, server: null });
  assert.equal(again.find((x) => x.id === 'company').done, false);
  assert.match(again.find((x) => x.id === 'company').detail, /GST\/HST number/);
  // Ontario is the default province: it needs an explicit confirm.
  const ontario = detectSteps({ settings: structuredClone(DEFAULT_SETTINGS), items: 0, jobs: 0, planSets: 0, employees: 0 });
  assert.equal(ontario.find((x) => x.id === 'province').done, false);
  const confirmed = structuredClone(DEFAULT_SETTINGS); confirmed.onboarding = { provinceAt: '2026-10-19' };
  assert.equal(detectSteps({ settings: confirmed, items: 0, jobs: 0, planSets: 0, employees: 0 }).find((x) => x.id === 'province').done, true);
  // Shown to owners and admins until done or dismissed.
  const admin = { isAdmin: () => true }, crew = { isAdmin: () => false };
  assert.equal(showFor(admin, DEFAULT_SETTINGS, fresh), true);
  assert.equal(showFor(crew, DEFAULT_SETTINGS, fresh), false);
  assert.equal(showFor(admin, { onboarding: { dismissedAt: 'x' } }, fresh), false);
});

test('API key scope summaries', async () => {
  const { describeScopes, keyStatus } = await import('../js/modules/developer.js');
  assert.equal(describeScopes(['*:read']), 'Read everything');
  assert.equal(describeScopes(['jobs:read', 'estimates:write']), 'Jobs (read), Estimates (write)');
  assert.equal(keyStatus({ revokedAt: 'x' }), 'revoked');
  assert.equal(keyStatus({ expiresAt: '2000-01-01T00:00:00Z' }), 'expired');
  assert.equal(keyStatus({}), 'active');
});

// Run: node --test electrical-app/tests/
// The panel schedule as a spreadsheet: the TG Electric template layout (lib/panel-sheet.js), the
// hand-written .xlsx writer and reader (lib/xlsx.js), and the import of a filled sheet back into a
// panel. Pure-function tests; the DOM grid in js/modules/panels.js renders from the same layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as X from '../js/lib/xlsx.js';
import * as PS from '../js/lib/panel-sheet.js';
import { panelFromImport, occupancy as occFromModule, slotCount as slotCountFromModule, halfOf as halfOfFromModule } from '../js/modules/panels.js';

const dec = new TextDecoder();
const enc = new TextEncoder();

// The schedule in "Tanner Billings Panel schedule.pdf": 200 A 120/240 V, 40 spaces, even circuits
// on the left, 1/2 at the bottom; 2-poles on 37/39, 29/31, 23/25, 15/17, 12/14, 2/4; tandem 1A/1B.
function tgPanel() {
  const c = (slot, description, amps, extra = {}) => ({ slot, description, amps, poles: 1, loadVA: 0, breakerType: 'standard', phase: '', ...extra });
  return {
    id: 'p1', name: 'TANNER BILLINGS RTM', location: 'MECHANICAL ROOM', voltage: '120/240 1ph', mainType: 'MB', mainAmps: 200, busAmps: 200, slots: 40,
    circuits: [
      c(37, 'FURNACE', 100, { poles: 2 }),
      c(35, 'HRV', 15),
      c(33, 'HEAT TRACE', 15),
      c(29, 'SUBMERSIBLE PUMP', 20, { poles: 2 }),
      c(27, 'CRAWL SPACE LIGHTS', 15),
      c(23, 'CONDENSER', 20, { poles: 2 }),
      c(21, 'SEPTIC ALARM', 15),
      c(19, 'SUMP PUMP', 15),
      c(15, 'WATER HEATER', 20, { poles: 2 }),
      c(13, 'BEDROOM PLUGS', 15, { breakerType: 'afci' }),
      c(11, 'OUTSIDE PLUGS', 15, { breakerType: 'afci' }),
      c(9, 'LIVING ROOM PLUGS', 15, { breakerType: 'afci' }),
      c(7, 'DISHWASHER', 15),
      c(5, 'FRIDGE', 15),
      c(3, 'MICROWAVE', 15, { breakerType: 'afci' }),
      c(1, 'COUNTER PLUG', 20, { half: 'A', breakerType: 'tandem' }),
      c(1, 'COUNTER PLUG', 20, { half: 'B', breakerType: 'tandem' }),
      c(18, 'BEDROOM PLUGS', 15, { breakerType: 'afci' }),
      c(16, 'BATHROOM', 15),
      c(12, 'RANGE', 40, { poles: 2 }),
      c(10, 'LIGHTS & SMOKE DETECTORS', 15, { purpose: 'smoke' }),
      c(8, 'OUTSIDE PLUGS', 15, { breakerType: 'afci' }),
      c(6, 'WASHER', 15, { breakerType: 'afci' }),
      c(2, 'DRYER', 30, { poles: 2 }),
    ],
  };
}
const find = (L, pred) => L.cells.find(pred);
const cellAt = (L, r, col) => L.cells[L.cover[r][col]];

// ---------------------------------------------------------------------------
// zip + CRC
// ---------------------------------------------------------------------------

test('crc32 matches the standard check value', () => {
  assert.equal(X.crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(X.crc32(new Uint8Array(0)), 0);
});

test('zipStore writes a valid stored zip that unzip reads back', async () => {
  const files = [{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.xml', data: '<x>é</x>' }];
  const z = X.zipStore(files);
  const v = new DataView(z.buffer);
  assert.equal(v.getUint32(0, true), 0x04034b50, 'starts with a local file header');
  assert.equal(v.getUint16(8, true), 0, 'method 0: stored');
  assert.equal(v.getUint32(14, true), X.crc32(enc.encode('hello')), 'CRC in the local header');
  const eocd = z.length - 22;
  assert.equal(v.getUint32(eocd, true), 0x06054b50, 'ends with the end-of-central-directory record');
  assert.equal(v.getUint16(eocd + 10, true), 2, 'two entries');
  const cdOffset = v.getUint32(eocd + 16, true);
  assert.equal(v.getUint32(cdOffset, true), 0x02014b50, 'central directory where the EOCD says');
  assert.equal(cdOffset + v.getUint32(eocd + 12, true), eocd, 'central directory size adds up');
  const back = await X.unzip(z);
  assert.deepEqual([...back.keys()], ['a.txt', 'dir/b.xml']);
  assert.equal(dec.decode(back.get('dir/b.xml')), '<x>é</x>');
});

test('unzip inflates deflated entries (as Excel and Google Sheets write them)', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const raw = enc.encode('<sheet>'.repeat(50));
  const comp = new Uint8Array(deflateRawSync(raw));
  // Hand-build a one-entry zip using method 8.
  const name = enc.encode('x.xml');
  const local = new Uint8Array(30 + name.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(8, 8, true);
  lv.setUint32(14, X.crc32(raw), true); lv.setUint32(18, comp.length, true); lv.setUint32(22, raw.length, true);
  lv.setUint16(26, name.length, true); local.set(name, 30);
  const cd = new Uint8Array(46 + name.length);
  const cv = new DataView(cd.buffer);
  cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 8, true); cv.setUint32(16, X.crc32(raw), true);
  cv.setUint32(20, comp.length, true); cv.setUint32(24, raw.length, true); cv.setUint16(28, name.length, true); cd.set(name, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true);
  ev.setUint32(12, cd.length, true); ev.setUint32(16, local.length + comp.length, true);
  const zip = new Uint8Array([...local, ...comp, ...cd, ...end]);
  const out = await X.unzip(zip);
  assert.equal(dec.decode(out.get('x.xml')), '<sheet>'.repeat(50));
});

test('cell references and ranges', () => {
  assert.equal(X.colName(0), 'A');
  assert.equal(X.colName(25), 'Z');
  assert.equal(X.colName(26), 'AA');
  assert.equal(X.cellRef(0, 5), 'F1');
  assert.deepEqual(X.parseRef('$B$12'), { r: 11, c: 1 });
  assert.deepEqual(X.parseRange('F3:A1'), { r1: 0, c1: 0, r2: 2, c2: 5 });
  assert.equal(X.parseRef('nope'), null);
});

test('xlsxFileName names the file after the panel, safely', () => {
  assert.equal(X.xlsxFileName('LP-2 / Garage'), 'LP-2 - Garage.xlsx');
  assert.equal(X.xlsxFileName('TANNER BILLINGS RTM'), 'TANNER BILLINGS RTM.xlsx');
  assert.equal(X.xlsxFileName('', 'Panel schedule'), 'Panel schedule.xlsx');
});

// ---------------------------------------------------------------------------
// Workbook writer
// ---------------------------------------------------------------------------

test('buildXlsx writes the OOXML parts with merges, fills, borders, widths and a one-page print setup', async () => {
  const bytes = X.buildXlsx({
    sheets: [{
      name: 'Test: [1]',
      cols: [20, 8],
      rows: [
        { height: 15, cells: [{ v: 'PANEL NAME', s: { fill: '#d9d9d9', border: { top: 'thin', bottom: 'dotted', left: 'thin', right: 'double' } } }, { v: 'X & <Y>', s: { font: { bold: true } } }] },
        { cells: [{ v: 15 }, null] },
      ],
      merges: ['B1:C2'],
      showGrid: false,
      print: { orientation: 'portrait', fitToPage: true },
    }],
  });
  const files = await X.unzip(bytes);
  for (const p of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(files.has(p), `missing ${p}`);
  }
  const sheet = dec.decode(files.get('xl/worksheets/sheet1.xml'));
  assert.match(sheet, /<mergeCells count="1"><mergeCell ref="B1:C2"\/><\/mergeCells>/);
  assert.match(sheet, /<sheetPr><pageSetUpPr fitToPage="1"\/><\/sheetPr>/);
  assert.match(sheet, /<pageSetup paperSize="1" orientation="portrait" fitToWidth="1" fitToHeight="1"\/>/);
  assert.match(sheet, /<col min="1" max="1" width="20" customWidth="1"\/>/);
  assert.match(sheet, /showGridLines="0"/);
  assert.match(sheet, /<row r="1" ht="15" customHeight="1">/);
  assert.match(sheet, /<c r="A2"><v>15<\/v><\/c>/, 'numbers stay numbers');
  // every cell of a merged range is written (so its borders draw), with the anchor's style
  assert.match(sheet, /<c r="C1" s="\d+"\/>/);
  assert.match(sheet, /<c r="C2" s="\d+"\/>/);
  // schema order: sheetData before mergeCells before pageMargins before pageSetup
  assert.ok(sheet.indexOf('<sheetData>') < sheet.indexOf('<mergeCells') && sheet.indexOf('<mergeCells') < sheet.indexOf('<pageMargins') && sheet.indexOf('<pageMargins') < sheet.indexOf('<pageSetup'));
  const styles = dec.decode(files.get('xl/styles.xml'));
  assert.match(styles, /<patternFill patternType="solid"><fgColor rgb="FFD9D9D9"\/>/);
  assert.match(styles, /<right style="double">/);
  assert.match(styles, /<bottom style="dotted">/);
  assert.match(styles, /<b\/>/);
  const sst = dec.decode(files.get('xl/sharedStrings.xml'));
  assert.match(sst, /X &amp; &lt;Y&gt;/, 'text is XML-escaped');
  const wb = dec.decode(files.get('xl/workbook.xml'));
  assert.match(wb, /<sheet name="Test   1 " sheetId="1" r:id="rId1"\/>|<sheet name="Test   1" sheetId="1" r:id="rId1"\/>/, 'sheet name cleaned of []:');
  assert.match(wb, /_xlnm\.Print_Area/);
});

test('imageInfo reads PNG and JPEG sizes; dataUrlBytes decodes a logo data URL', () => {
  const png = tinyPng(3, 2);
  assert.deepEqual(X.imageInfo(png), { type: 'png', width: 3, height: 2 });
  // minimal JPEG header: SOI, APP0 (len 16), SOF0 with 8-bit precision, height 5, width 7
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0), 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x05, 0x00, 0x07, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(X.imageInfo(jpeg), { type: 'jpeg', width: 7, height: 5 });
  assert.equal(X.imageInfo(enc.encode('GIF89a')), null);
  const url = 'data:image/png;base64,' + Buffer.from(png).toString('base64');
  assert.deepEqual([...X.dataUrlBytes(url)], [...png]);
  assert.equal(X.dataUrlBytes('data:image/svg+xml;base64,PHN2Zz4='), null);
  assert.equal(X.dataUrlBytes(null), null);
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

test('the occupancy helpers moved to lib/panel-sheet.js and are re-exported unchanged', () => {
  assert.equal(occFromModule, PS.occupancy);
  assert.equal(slotCountFromModule, PS.slotCount);
  assert.equal(halfOfFromModule, PS.halfOf);
});

test('TG layout: even left, odd right, 40/39 at the top and 1/2 at the bottom', () => {
  const L = PS.sheetLayout(tgPanel(), { evenLeft: true, bottomUp: true });
  assert.equal(L.rows, 40, 'two sheet rows per space position');
  assert.equal(cellAt(L, 0, 1).text, '40', 'top-left CCT is 40');
  assert.equal(cellAt(L, 0, 4).text, '39', 'top-right CCT is 39');
  assert.equal(cellAt(L, 38, 1).text, '2', 'bottom-left CCT is 2');
  // the tandem 1A/1B at the bottom right: B above A, one sheet row each
  assert.equal(cellAt(L, 38, 4).text, '1B');
  assert.equal(cellAt(L, 39, 4).text, '1A');
  assert.equal(cellAt(L, 39, 5).text, 'COUNTER PLUG');
  assert.equal(cellAt(L, 39, 3).text, '20');
});

test('multi-pole breakers merge AMP and DESCRIPTION across their spaces; each space keeps its CCT cell', () => {
  const L = PS.sheetLayout(tgPanel());
  const furnace = find(L, (c) => c.kind === 'desc' && c.text === 'FURNACE');
  assert.equal(furnace.col, 5);
  assert.equal(furnace.r, 0);
  assert.equal(furnace.span, 4, '37 and 39: two spaces, four sheet rows');
  const furnaceAmp = find(L, (c) => c.kind === 'amp' && c.slot === 37);
  assert.equal(furnaceAmp.text, '100');
  assert.equal(furnaceAmp.span, 4);
  assert.equal(cellAt(L, 0, 4).text, '39');
  assert.equal(cellAt(L, 2, 4).text, '37');
  const range = find(L, (c) => c.kind === 'desc' && c.text === 'RANGE');
  assert.equal(range.col, 0);
  assert.equal(range.span, 4);
  assert.equal(cellAt(L, range.r, 1).text, '14', 'RANGE spans 14 (above) and 12');
  assert.equal(cellAt(L, range.r + 2, 1).text, '12');
  const dryerAmp = find(L, (c) => c.kind === 'amp' && c.slot === 2);
  assert.equal(dryerAmp.text, '30');
  assert.equal(dryerAmp.col, 2);
});

test('AFCI is written in the amp cell; legs alternate A/B (red/grey) by space row', () => {
  const L = PS.sheetLayout(tgPanel());
  assert.equal(find(L, (c) => c.kind === 'amp' && c.slot === 18).text, '15 AFI');
  assert.equal(find(L, (c) => c.kind === 'amp' && c.slot === 16).text, '15');
  const leg = (slot) => find(L, (c) => c.kind === 'cct' && c.slot === slot).leg;
  assert.equal(leg(2), 'A');
  assert.equal(leg(4), 'B');
  assert.equal(leg(6), 'A');
  assert.equal(leg(3), 'B');
  assert.equal(leg(5), 'A');
  assert.equal(leg(39), 'B');
  assert.equal(leg(37), 'A');
  // three-phase legs run A/B/C
  const three = PS.sheetLayout({ voltage: '208/120 3ph', slots: 12, circuits: [] });
  assert.deepEqual([1, 3, 5, 7].map((s) => three.cells.find((c) => c.kind === 'cct' && c.slot === s).leg), ['A', 'B', 'C', 'A']);
});

test('A/B halves are separated by a dotted edge; space boundaries stay solid', () => {
  const L = PS.sheetLayout(tgPanel());
  const b = cellAt(L, 38, 5); // 1B desc
  const a = cellAt(L, 39, 5); // 1A desc
  assert.equal((b.r + b.span) % 2, 1, '1B bottom edge is mid-space: dotted');
  assert.equal(a.r % 2, 1, '1A top edge is mid-space: dotted');
  const full = find(L, (c) => c.kind === 'desc' && c.text === 'HRV');
  assert.equal(full.r % 2, 0);
  assert.equal((full.r + full.span) % 2, 0, 'a full space has solid top and bottom');
});

test('empty spaces: whole on screen, split A/B on paper like the blank template (only when tandems fit)', () => {
  const screen = PS.sheetLayout(tgPanel(), { splitEmpty: false });
  assert.equal(cellAt(screen, 0, 1).text, '40');
  assert.equal(cellAt(screen, 0, 1).span, 2);
  const paper = PS.sheetLayout(tgPanel(), { splitEmpty: true });
  assert.equal(cellAt(paper, 0, 1).text, '40B');
  assert.equal(cellAt(paper, 1, 1).text, '40A');
  assert.equal(cellAt(paper, 0, 0).state, 'emptyHalf');
  const noTandems = PS.sheetLayout(tgPanel(), { splitEmpty: true, tandems: false });
  assert.equal(cellAt(noTandems, 0, 1).text, '40');
});

test('odd-left / top-down option mirrors the sheet', () => {
  const L = PS.sheetLayout(tgPanel(), { evenLeft: false, bottomUp: false });
  assert.equal(cellAt(L, 0, 1).text, '1A', 'tandem 1 at the top left, A above B');
  assert.equal(cellAt(L, 1, 1).text, '1B');
  assert.equal(cellAt(L, 0, 4).text, '2');
  assert.equal(cellAt(L, 38, 1).text, '39');
  const furnace = find(L, (c) => c.kind === 'desc' && c.text === 'FURNACE');
  assert.equal(furnace.col, 0);
  assert.equal(furnace.r, 36);
  assert.equal(furnace.span, 4);
});

test('a quad inner 2-pole merges across its B half and the next space’s A half', () => {
  const panel = { voltage: '120/240 1ph', slots: 12, circuits: [
    { slot: 5, half: 'A', poles: 1, description: 'TOP', amps: 15, breakerType: 'tandem' },
    { slot: 5, half: 'B', poles: 2, description: 'INNER', amps: 30, breakerType: 'quad' },
    { slot: 7, half: 'B', poles: 1, description: 'BOTTOM', amps: 15, breakerType: 'tandem' },
  ] };
  for (const bottomUp of [true, false]) {
    const L = PS.sheetLayout(panel, { bottomUp });
    const inner = find(L, (c) => c.kind === 'desc' && c.text === 'INNER');
    assert.equal(inner.span, 2);
    const rows = [inner.r, inner.r + 1].map((r) => cellAt(L, r, inner.col === 0 ? 1 : 4).text).sort();
    assert.deepEqual(rows, ['5B', '7A']);
  }
});

test('every grid position is covered exactly once and nothing overlaps', () => {
  for (const opts of [{}, { splitEmpty: true }, { evenLeft: false, bottomUp: false, splitEmpty: true }]) {
    const L = PS.sheetLayout(tgPanel(), opts);
    const seen = Array.from({ length: L.rows }, () => new Array(6).fill(0));
    for (const c of L.cells) for (let r = c.r; r < c.r + c.span; r++) seen[r][c.col] += 1;
    assert.ok(seen.every((row) => row.every((n) => n === 1)), JSON.stringify(opts));
  }
});

test('an existing panel (no slots field, no half fields) still lays out', () => {
  const legacy = { voltage: '120/240 1ph', circuits: [{ slot: 1, description: 'Lights', amps: 15, poles: 1 }, { slot: 2, description: 'Dryer', amps: 30, poles: 2 }] };
  const L = PS.sheetLayout(legacy);
  assert.equal(L.slots, 24);
  assert.equal(L.rows, 24);
  assert.equal(find(L, (c) => c.kind === 'desc' && c.text === 'Dryer').span, 4);
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

test('parseAmpText reads what people type in the AMP cell', () => {
  assert.deepEqual(PS.parseAmpText('15'), { amps: 15, breakerType: null, poles: null });
  assert.deepEqual(PS.parseAmpText('15 AFI'), { amps: 15, breakerType: 'afci', poles: null });
  assert.deepEqual(PS.parseAmpText('15afci'), { amps: 15, breakerType: 'afci', poles: null });
  assert.deepEqual(PS.parseAmpText('20 gfi'), { amps: 20, breakerType: 'gfci', poles: null });
  assert.deepEqual(PS.parseAmpText('20 DF'), { amps: 20, breakerType: 'dual', poles: null });
  assert.deepEqual(PS.parseAmpText('15 AFI/GFI'), { amps: 15, breakerType: 'dual', poles: null });
  assert.deepEqual(PS.parseAmpText('40 2P'), { amps: 40, breakerType: null, poles: 2 });
  assert.deepEqual(PS.parseAmpText('30A 2P'), { amps: 30, breakerType: null, poles: 2 });
  assert.deepEqual(PS.parseAmpText('30/2'), { amps: 30, breakerType: null, poles: 2 });
  assert.deepEqual(PS.parseAmpText('60 hacr'), { amps: 60, breakerType: 'hacr', poles: null });
  assert.deepEqual(PS.parseAmpText(''), { amps: null, breakerType: null, poles: null });
  assert.equal(PS.parseAmpText('AFI').amps, null);
});

test('sheetAmpText writes the template style', () => {
  assert.equal(PS.sheetAmpText({ amps: 15, breakerType: 'afci' }), '15 AFI');
  assert.equal(PS.sheetAmpText({ amps: 40, poles: 2 }), '40');
  assert.equal(PS.sheetAmpText({ amps: 20, breakerType: 'tandem' }), '20');
  assert.equal(PS.sheetAmpText({ amps: null }), '');
  for (const t of ['15', '15 AFI', '20 GFI', '20 DF']) assert.equal(PS.sheetAmpText({ amps: PS.parseAmpText(t).amps, breakerType: PS.parseAmpText(t).breakerType }), t);
});

test('service line reads like the template and parses back', () => {
  assert.equal(PS.sheetServiceLine(tgPanel()), '200A - 120/240V - 1 PH');
  assert.equal(PS.sheetServiceLine({ voltage: '347/600 3ph', mainAmps: 400 }), '400A - 347/600V - 3 PH');
  assert.equal(PS.sheetServiceLine({ voltage: '600 3ph 3w', mainAmps: 100, mainType: 'MLO' }), '100A MLO - 600V - 3 PH 3W');
  assert.deepEqual(PS.parseServiceLine('200A - 120/240V - 1 PH'), { mainAmps: 200, voltage: '120/240 1ph', mainType: null });
  assert.equal(PS.parseServiceLine('225A 120/208V 3PH').voltage, '208/120 3ph');
  assert.equal(PS.parseServiceLine('100A MLO - 600V - 3 PH 3W').voltage, '600 3ph 3w');
  assert.equal(PS.parseServiceLine('100A MLO - 600V - 3 PH 3W').mainType, 'MLO');
});

test('sheet settings default to the template and can be switched per company', () => {
  assert.deepEqual(PS.sheetSettings({}), { evenLeft: true, bottomUp: true, contactLine: true });
  assert.deepEqual(PS.sheetSettings({ panelSheet: { evenLeft: false, bottomUp: false } }), { evenLeft: false, bottomUp: false, contactLine: true });
});

// ---------------------------------------------------------------------------
// The panel .xlsx
// ---------------------------------------------------------------------------

function tgXlsx(opts = {}) {
  const panel = tgPanel();
  const layout = PS.sheetLayout(panel, { splitEmpty: true, ...opts });
  return PS.panelXlsx(panel, {
    layout,
    highlight: (c) => (c.purpose === 'smoke' ? '#e2231a' : null),
    company: { name: 'TG Electric', phone: '431-866-2831', website: 'www.tgelectrical.ca', email: 'info@tgelectrical.ca' },
    logo: opts.logo || null,
  });
}

test('panel .xlsx: titleblock, headers, merged multi-poles, leg fills and fit-to-one-page portrait', async () => {
  const files = await X.unzip(tgXlsx());
  const sheet = dec.decode(files.get('xl/worksheets/sheet1.xml'));
  const sst = dec.decode(files.get('xl/sharedStrings.xml'));
  for (const s of ['PANEL NAME', 'TANNER BILLINGS RTM', 'PANEL LOCATION', 'MECHANICAL ROOM', '200A - 120/240V - 1 PH', 'DESCRIPTION', 'CCT. NO', 'AMP', 'FURNACE', '15 AFI', '1B', '40A', 'LIGHTS &amp; SMOKE DETECTORS', 'TG Electric', '431-866-2831']) {
    assert.ok(sst.includes(s), `shared strings missing ${s}`);
  }
  // Titleblock merges, then FURNACE's AMP (D) and DESCRIPTION (F) merged over 4 rows at the top of the body (row 5).
  for (const ref of ['B1:F1', 'B2:F2', 'A3:F3', 'D5:D8', 'F5:F8', 'E5:E6', 'E7:E8']) {
    assert.ok(sheet.includes(`<mergeCell ref="${ref}"/>`), `missing merge ${ref}`);
  }
  // 1A / 1B tandems are not merged
  assert.ok(!/<mergeCell ref="E43:E44"\/>/.test(sheet));
  assert.match(sheet, /<pageSetup paperSize="1" orientation="portrait" fitToWidth="1" fitToHeight="1"\/>/);
  assert.match(sheet, /<pageSetUpPr fitToPage="1"\/>/);
  const styles = dec.decode(files.get('xl/styles.xml'));
  assert.match(styles, /FFE06666/, 'red leg fill');
  assert.match(styles, /FF999999/, 'grey leg fill');
  assert.match(styles, /FFD9D9D9/, 'grey title and AMP fill');
  assert.match(styles, /style="double"/, 'double centre rule');
  assert.match(styles, /style="dotted"/, 'dotted A/B separators');
  // the smoke highlight becomes a pale red fill on the description
  assert.match(styles, new RegExp(`FF${PS.tint('#e2231a', 0.75).slice(1).toUpperCase()}`));
});

test('panel .xlsx merges never overlap (Excel would "repair" the file)', async () => {
  for (const opts of [{}, { evenLeft: false, bottomUp: false }]) {
    const files = await X.unzip(tgXlsx(opts));
    const sheet = dec.decode(files.get('xl/worksheets/sheet1.xml'));
    const ranges = [...sheet.matchAll(/<mergeCell ref="([A-Z]+\d+:[A-Z]+\d+)"\/>/g)].map((m) => X.parseRange(m[1]));
    const taken = new Set();
    for (const g of ranges) {
      for (let r = g.r1; r <= g.r2; r++) for (let c = g.c1; c <= g.c2; c++) {
        const k = `${r}:${c}`;
        assert.ok(!taken.has(k), `overlap at ${X.cellRef(r, c)}`);
        taken.add(k);
      }
    }
    const count = Number(/<mergeCells count="(\d+)"/.exec(sheet)[1]);
    assert.equal(count, ranges.length);
  }
});

test('panel .xlsx embeds the company logo as a picture in the logo block', async () => {
  const files = await X.unzip(tgXlsx({ logo: tinyPng(40, 20) }));
  assert.ok(files.has('xl/media/image1.png'));
  assert.ok(files.has('xl/drawings/drawing1.xml'));
  assert.ok(files.has('xl/drawings/_rels/drawing1.xml.rels'));
  assert.ok(files.has('xl/worksheets/_rels/sheet1.xml.rels'));
  const sheet = dec.decode(files.get('xl/worksheets/sheet1.xml'));
  assert.match(sheet, /<drawing r:id="rId1"\/><\/worksheet>$/);
  const types = dec.decode(files.get('[Content_Types].xml'));
  assert.match(types, /\/xl\/drawings\/drawing1\.xml/);
  const drawing = dec.decode(files.get('xl/drawings/drawing1.xml'));
  assert.match(drawing, /<xdr:row>44<\/xdr:row>/, 'anchored in the logo row under the 40 body rows');
  assert.match(drawing, /noChangeAspect="1"/);
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const key = (c) => `${c.slot}${c.half || ''}|${c.poles}|${c.description}|${c.amps}|${c.breakerType}`;
const norm = (cs) => cs.map((c) => key({ ...c, breakerType: c.breakerType || 'standard' })).sort();

test('import: the exported TG sheet reads back into the same panel', async () => {
  const grid = await X.readXlsx(tgXlsx());
  const parsed = PS.panelFromSheet(grid);
  assert.equal(parsed.name, 'TANNER BILLINGS RTM');
  assert.equal(parsed.location, 'MECHANICAL ROOM');
  assert.equal(parsed.voltage, '120/240 1ph');
  assert.equal(parsed.mainAmps, 200);
  assert.equal(parsed.slots, 40);
  assert.equal(parsed.skipped, 0);
  assert.deepEqual(norm(parsed.circuits), norm(tgPanel().circuits));
});

test('import reads the other side order / numbering direction too', async () => {
  const parsed = PS.panelFromSheet(await X.readXlsx(tgXlsx({ evenLeft: false, bottomUp: false })));
  assert.deepEqual(norm(parsed.circuits), norm(tgPanel().circuits));
});

test('import: a quad survives the round trip', async () => {
  const panel = { name: 'Q', voltage: '120/240 1ph', mainAmps: 100, slots: 12, circuits: [
    { slot: 5, half: 'A', poles: 1, description: 'TOP', amps: 15, breakerType: 'tandem' },
    { slot: 5, half: 'B', poles: 2, description: 'INNER', amps: 30, breakerType: 'quad' },
    { slot: 7, half: 'B', poles: 1, description: 'BOTTOM', amps: 15, breakerType: 'tandem' },
  ] };
  const bytes = PS.panelXlsx(panel, { layout: PS.sheetLayout(panel, { splitEmpty: true }) });
  const parsed = PS.panelFromSheet(await X.readXlsx(bytes));
  assert.deepEqual(norm(parsed.circuits), norm(panel.circuits));
});

test('import: a hand-filled sheet (Google Sheets style, inline strings) and panelFromImport', () => {
  // Header at row 3, title rows above; DESCRIPTION merged over 12/14 = a 2-pole.
  const cells = new Map(Object.entries({
    '0:0': 'PANEL NAME', '0:1': 'Garage sub',
    '1:0': 'PANEL LOCATION', '1:1': 'Garage',
    '2:0': '100A - 120/240V - 1 PH',
    '3:0': 'DESCRIPTION', '3:1': 'CCT. NO', '3:2': 'AMP', '3:3': 'AMP', '3:4': 'CCT. NO', '3:5': 'DESCRIPTION',
    '4:0': 'Welder', '4:1': '4', '4:2': '50', '4:4': '3', '4:5': 'Lights', '4:3': '15 afi',
    '6:1': '2', '6:4': '1B', '6:5': 'Door opener', '6:3': '15', '7:4': '1A',
  }));
  const merges = [
    { r1: 4, c1: 0, r2: 7, c2: 0 }, { r1: 4, c1: 2, r2: 7, c2: 2 },
    { r1: 4, c1: 1, r2: 5, c2: 1 }, { r1: 6, c1: 1, r2: 7, c2: 1 },
    { r1: 4, c1: 4, r2: 5, c2: 4 }, { r1: 4, c1: 5, r2: 5, c2: 5 }, { r1: 4, c1: 3, r2: 5, c2: 3 },
  ];
  const parsed = PS.panelFromSheet({ cells, merges });
  assert.equal(parsed.name, 'Garage sub');
  assert.equal(parsed.mainAmps, 100);
  assert.deepEqual(norm(parsed.circuits), norm([
    { slot: 2, poles: 2, description: 'Welder', amps: 50, breakerType: 'standard' },
    { slot: 3, poles: 1, description: 'Lights', amps: 15, breakerType: 'afci' },
    { slot: 1, half: 'B', poles: 1, description: 'Door opener', amps: 15, breakerType: 'tandem' },
  ]));
  assert.equal(parsed.slots, 12);
  const rec = panelFromImport(parsed, { jobId: 'j1' });
  assert.equal(rec.jobId, 'j1');
  assert.equal(rec.voltage, '120/240 1ph');
  assert.equal(rec.mainAmps, 100);
  assert.equal(rec.circuits.find((c) => c.slot === 2).phase, 'A-B');
  assert.equal(rec.circuits.find((c) => c.slot === 3).phase, 'B');
});

test('import refuses a sheet that is not a panel schedule', () => {
  assert.throws(() => PS.panelFromSheet({ cells: new Map([['0:0', 'Invoice']]), merges: [] }), /header/);
});

// A valid PNG of w×h (only the signature and IHDR matter to imageInfo; the rest keeps viewers happy).
function tinyPng(w, h) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type, data) => {
    const t = enc.encode(type);
    const body = new Uint8Array([...t, ...data]);
    const len = data.length;
    const crc = X.crc32(body);
    return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...body, (crc >>> 24) & 255, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255];
  };
  const ihdr = [(w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, (h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, 8, 0, 0, 0, 0];
  return new Uint8Array([...sig, ...chunk('IHDR', ihdr), ...chunk('IEND', [])]);
}

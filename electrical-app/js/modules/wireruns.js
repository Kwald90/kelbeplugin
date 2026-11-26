// Wire runs: named, saved runs measured with an AR tape, traced on a drawing or
// typed in, with drops and box allowances, totals per conductor, suggested rolls,
// a PDF report and "add to estimate". The maths lives in js/lib/wireruns.js.
//
// Video: the AR tape can record the camera while it measures, and a run can hold videos (recorded
// then, or recorded/picked later) to play back with a marker at each measured point and re-check
// the run. Small videos attach at once and upload in the background, resuming after a dropped
// signal; big ones, or ones made offline or on a device short of memory, wait on the device under
// Videos on this device (#/wireruns/recordings) until someone attaches them. Rules: lib/wirerun-video.js,
// device storage: lib/wirerun-recordings.js, server: lib/wirerun-video-upload.js.
//   #/wireruns               runs (filtered to the "Working on" job when one is chosen)
//   #/wireruns/:id           a run
//   #/wireruns/recordings    videos on this device: unattached recordings and storage
import { getUnits, fmtLength, parseLength, M_PER_FT } from '../lib/units.js';
import * as W from '../lib/wireruns.js';
import * as V from '../lib/wirerun-video.js';
import * as R from '../lib/wirerun-recordings.js';
import * as U from '../lib/wirerun-video-upload.js';
import { blobUrl, deleteBlob } from '../lib/local-blobs.js';
import { getArSupport, measurePath, isCancelled, AR_TIPS } from '../lib/ar-measure.js';
import { jobFocus, onJobFocus } from '../lib/job-focus.js';
import { isNativeApp } from '../lib/native.js';
import { BRAND } from '../brand.js';

// Icons drawn for this screen (24px grid, stroke), passed to ui.icon() as markup.
const ICON_AR = '<rect x="6.5" y="2.5" width="11" height="19" rx="2"/><path d="M12 8.5v7M8.5 12h7"/><circle cx="12" cy="12" r="1"/>';
const ICON_SHARE = '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"/>';
const ICON_TABLE = '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>';

const MAX_PHOTOS = 12;
const PHOTO_MAX_SIDE = 1600;
const PHOTO_MAX_BYTES = 400 * 1024;
const TIPS_KEY = 'ft.wireruns.arTipsSeen';
const RECORD_KEY = 'ft.wireruns.arRecord';
const ICON_VIDEO = '<rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="M15.5 10.5l6-3.5v10l-6-3.5z"/>';
const LIGHT_PAPER = '#f7f6f2';

export default {
  id: 'wireruns',
  title: 'Wire runs',
  icon: 'ruler',
  group: 'work',
  perm: 'drawings',
  render(root, ctx) {
    const [sub] = ctx.params;
    U.hookResumeOnOnline(ctx.store);
    U.resumeUploads(ctx.store);
    if (sub === 'new') return createRun(ctx);
    if (sub === 'recordings') return renderRecordings(root, ctx);
    if (sub) return renderEditor(root, ctx, sub);
    return renderList(root, ctx);
  },
};

const unitsFor = (store) => getUnits(store.settings()?.units);
const jobLabel = (j) => (j ? [j.number, j.title].filter(Boolean).join(' · ') : '');

function debounce(fn, ms) {
  let t = null;
  const d = () => { clearTimeout(t); t = setTimeout(() => { t = null; fn(); }, ms); };
  d.flush = () => { if (t) { clearTimeout(t); t = null; fn(); } };
  d.cancel = () => { clearTimeout(t); t = null; };
  return d;
}

// What the editor saves. Videos are left out: they change in the background (uploads) and are
// written on their own through lib/wirerun-recordings.js and lib/wirerun-video-upload.js.
function pick(run) {
  const { id, createdAt, updatedAt, videos, ...rest } = run;
  void id; void createdAt; void updatedAt; void videos;
  return rest;
}

const recordPref = () => { try { return localStorage.getItem(RECORD_KEY) !== '0'; } catch { return true; } };
const setRecordPref = (on) => { try { localStorage.setItem(RECORD_KEY, on ? '1' : '0'); } catch { /* storage blocked */ } };
const online = () => globalThis.navigator?.onLine !== false;
/** What happens to a video just attached, in words. */
const attachedNote = (store, bytes) => (bytes > V.MAX_UPLOAD_BYTES ? 'Attached. It is too big to upload, so it plays on this device only.'
  : store.synced === false ? 'Attached. The demo has no server, so it stays on this device.' : 'Attached. Uploading in the background.');
const deviceMemoryGb = () => (Number(globalThis.navigator?.deviceMemory) > 0 ? Number(globalThis.navigator.deviceMemory) : null);

// ---------- create ----------
function createRun({ store, query, auth }) {
  const jobId = query.jobId || jobFocus(store, auth);
  const job = jobId ? store.get('jobs', jobId) : null;
  const n = store.count('wireRuns', (r) => (job ? r.jobId === job.id : true)) + 1;
  const rec = store.add('wireRuns', W.newRun({ name: `Run ${n}`, jobId: job?.id || null }));
  location.replace(`#/wireruns/${rec.id}?fresh=1`);
}

// ---------- list ----------
function renderList(root, ctx) {
  const { store, ui, nav, query, auth } = ctx;
  const { h } = ui;
  const units = unitsFor(store);
  let q = '';
  // An explicit ?jobId= wins; otherwise the "Working on" job, if one is chosen.
  let jobId = query.jobId || jobFocus(store, auth);
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const host = h('div', { class: 'stack' });
  const tableHost = h('div');

  const jobSelect = h('select', {
    class: 'input wr-job-filter', 'aria-label': 'Filter by job',
    onChange: (e) => { jobId = e.target.value; history.replaceState(null, '', '#/wireruns' + (jobId ? '?jobId=' + jobId : '')); draw(); },
  },
  h('option', { value: '' }, 'All jobs'),
  h('option', { value: '__none', selected: jobId === '__none' }, 'Not linked to a job'),
  jobs.map((j) => h('option', { value: j.id, selected: j.id === jobId }, jobLabel(j))));

  const newHref = () => '#/wireruns/new' + (jobId && jobId !== '__none' ? '?jobId=' + jobId : '');

  const menu = (r) => {
    const s = ui.openSheet({
      title: r.name || 'Wire run', dialog: true,
      body: h('div', { class: 'list' },
        h('button', { type: 'button', class: 'list-row click wr-menu-row', onClick: () => { s.close(); renameRun(ctx, r); } }, ui.icon('edit', 18), 'Rename'),
        h('button', { type: 'button', class: 'list-row click wr-menu-row', onClick: () => { s.close(); const c = store.add('wireRuns', W.duplicateRun(r)); ui.toast(`Duplicated as ${c.name}`, 'success'); } }, ui.icon('copy', 18), 'Duplicate'),
        h('button', { type: 'button', class: 'list-row click wr-menu-row danger', onClick: () => { s.close(); deleteRun(ctx, r); } }, ui.icon('trash', 18), 'Delete')),
    });
  };

  function draw() {
    ui.clear(host);
    const all = store.list('wireRuns');
    const rows = W.filterRuns(all, { jobId, jobs }).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const totals = new Map(rows.map((r) => [r.id, W.runTotals(r)]));
    const sumOf = (k) => rows.reduce((s, r) => s + totals.get(r.id)[k], 0);
    h(host, null,
      h('div', { class: 'grid wr-stats' },
        ui.stat({ label: 'Runs', value: String(rows.length), hint: jobId && jobId !== '__none' ? jobLabel(jobById.get(jobId)) : 'All jobs' }),
        ui.stat({ label: 'Measured', value: W.fmtTotal(sumOf('runM'), units), hint: 'Sum of segments' }),
        ui.stat({ label: 'Wire to pull', value: W.fmtTotal(sumOf('conductorM'), units), hint: 'All conductors, with allowances', tone: 'accent' })),
      h('div', { class: 'row' }, ui.searchBox('Search runs', (v) => { q = v; drawTable(); }, q), jobSelect),
      tableHost);
    drawTable();

    function drawTable() {
      const list = W.filterRuns(rows, { q, jobs });
      ui.clear(tableHost);
      tableHost.append(ui.table({
        columns: [
          { key: 'name', label: 'Run', render: (r) => {
            const vids = (r.videos || []).length;
            const sub = [r.location, vids ? `${vids} video${vids === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
            return h('div', null, h('div', { class: 'wr-name' }, r.name || 'Untitled run'), sub ? h('div', { class: 'muted wr-sub' }, sub) : null);
          }, sort: (r) => (r.name || '').toLowerCase() },
          { key: 'job', label: 'Job', render: (r) => (jobById.get(r.jobId) ? jobLabel(jobById.get(r.jobId)) : '—'), sort: (r) => jobById.get(r.jobId)?.number || '' },
          { key: 'method', label: 'Method', render: (r) => W.methodLabel(W.normalizeRun(r)) },
          { key: 'run', label: 'Run length', align: 'right', render: (r) => W.fmtTotal(totals.get(r.id).runM, units), sort: (r) => totals.get(r.id).runM },
          { key: 'wire', label: 'Wire', align: 'right', render: (r) => W.fmtTotal(totals.get(r.id).conductorM, units), sort: (r) => totals.get(r.id).conductorM },
          { key: 'updated', label: 'Updated', render: (r) => ui.fmtDate(r.updatedAt), sort: (r) => r.updatedAt || '' },
          { key: 'more', label: '', render: (r) => {
            const b = ui.button('', { variant: 'ghost', size: 'sm', icon: 'more', title: `More for ${r.name || 'run'}`, onClick: (e) => { e.stopPropagation(); menu(r); } });
            b.addEventListener('keydown', (e) => e.stopPropagation()); // Enter opens the menu, not the row
            return b;
          } },
        ],
        rows: list,
        onRowClick: (r) => nav('#/wireruns/' + r.id),
        empty: ui.empty({
          icon: 'ruler', title: all.length ? 'No runs match' : 'No wire runs yet',
          text: all.length ? 'Try another search or job.' : 'Measure a run with the AR tape, trace it on a plan, or type the lengths in. Then get totals per conductor, rolls to buy and a PDF.',
          action: all.length ? null : ui.button('New run', { variant: 'primary', icon: 'plus', href: newHref() }),
        }),
      }));
    }
  }

  const recCount = () => R.listRecordings(store).length;
  const videosBtn = ui.button(`Videos on this device${recCount() ? ` (${recCount()})` : ''}`, { icon: ICON_VIDEO, href: '#/wireruns/recordings' });
  root.append(ui.page({
    title: 'Wire runs',
    subtitle: 'Measure runs along walls and conduit, add allowances, and see how much wire to pull and buy.',
    actions: [videosBtn, ui.button('New run', { variant: 'primary', icon: 'plus', onClick: () => nav(newHref()) })],
  }, host));
  draw();
  const offRuns = store.on('wireRuns', draw);
  const offFocus = onJobFocus((f) => {
    if (query.jobId) return; // a link to one job keeps it
    jobId = f;
    for (const o of jobSelect.options) o.selected = o.value === jobId;
    draw();
  });
  const offRecs = R.onRecordingsChange(() => { const n = recCount(); videosBtn.lastChild.textContent = `Videos on this device${n ? ` (${n})` : ''}`; });
  return () => { offRuns(); offFocus(); offRecs(); };
}

async function renameRun({ store, ui }, r) {
  const name = await ui.promptDialog('Name', { title: 'Rename run', value: r.name || '', okLabel: 'Rename' });
  if (name == null || !name.trim()) return null;
  store.update('wireRuns', r.id, { name: name.trim() });
  return name.trim();
}

async function deleteRun({ store, ui }, r) {
  const videos = V.normalizeVideos(store.get('wireRuns', r.id)?.videos || r.videos);
  const what = videos.length ? `Its segments, photos and ${videos.length} video${videos.length === 1 ? '' : 's'} go too` : 'Its segments and photos go too';
  if (!(await ui.confirmDialog(`Delete "${r.name || 'this run'}"? ${what}. This can't be undone.`, { okLabel: 'Delete' }))) return false;
  store.remove('wireRuns', r.id);
  // The videos' bytes on this device and on the server go with the run. Offline, the server copy
  // stays until someone deletes it there (an unfinished upload is dropped after a week).
  await Promise.all(videos.map(async (v) => {
    if (v.localId) await deleteBlob(v.localId);
    if (v.mediaId) await U.deleteMedia(v.mediaId).catch(() => {});
  }));
  ui.toast('Run deleted');
  return true;
}

// ---------- editor ----------
function renderEditor(root, ctx, id) {
  const { store, ui, nav, auth, query } = ctx;
  const { h } = ui;
  const rec = store.get('wireRuns', id);
  if (!rec) {
    root.append(ui.page({ title: 'Run not found' }, ui.empty({ icon: 'ruler', title: 'This wire run no longer exists', action: ui.button('All wire runs', { href: '#/wireruns' }) })));
    return;
  }
  const run = W.normalizeRun(rec);
  const units = unitsFor(store);
  const imperial = units === 'imperial';
  const BARE = imperial ? 'ft' : 'm';
  const BARE_SMALL = imperial ? 'in' : 'mm';
  let removed = false;
  let alive = true;

  const save = debounce(() => {
    if (removed) return;
    store.update('wireRuns', id, { ...pick(run), totalM: W.runTotals(run).totalM });
  }, 450);
  const changed = () => { refreshTotals(); save(); };

  // ----- small form helpers -----
  const fmtInput = (m) => {
    if (!m) return '';
    if (imperial) return fmtLength(m, { units, denom: 16 });
    return m < 1 ? `${Math.round(m * 1000)} mm` : `${Number(m.toFixed(3))} m`;
  };
  function lengthInput({ value, bare = BARE, label, placeholder, onChange }) {
    const read = () => (input.value.trim() === '' ? 0 : parseLength(input.value, { units, bare }));
    const input = h('input', {
      class: 'input wr-len num', type: 'text', inputmode: imperial ? 'text' : 'decimal', autocomplete: 'off', enterkeyhint: 'done',
      value: fmtInput(value), placeholder: placeholder || (imperial ? (bare === 'in' ? '12"' : `12' 6"`) : (bare === 'mm' ? '300 mm' : '3.5 m')), 'aria-label': label,
      onInput: () => {
        const v = read();
        const bad = v == null || v < 0;
        input.classList.toggle('invalid', bad);
        input.setAttribute('aria-invalid', String(bad));
        if (!bad) onChange(v);
      },
      onBlur: () => { const v = read(); if (v != null && v >= 0 && input.value.trim()) input.value = fmtInput(v); },
    });
    return input;
  }
  const labeled = (label, control, hint) => h('label', { class: 'field' }, h('span', null, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
  const textInput = (value, placeholder, onInput, extra = {}) => h('input', { class: 'input', value: value ?? '', placeholder, onInput: (e) => onInput(e.target.value), ...extra });
  const numInput = (value, onInput, extra = {}) => h('input', {
    class: 'input num', type: 'number', inputmode: 'decimal', min: '0', step: '1', value: value ?? '',
    onInput: (e) => onInput(e.target.value === '' ? 0 : Number(e.target.value)), ...extra,
  });
  const iconBtn = (icon, title, onClick, opts = {}) => ui.button('', { variant: opts.danger ? 'ghost danger' : 'ghost', size: 'sm', icon, title, onClick, disabled: opts.disabled });
  const move = (arr, i, d, redraw) => { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; redraw(); changed(); };
  // Removing a row never asks first; it offers Undo instead.
  const removeAt = (arr, i, redraw, what) => {
    const [gone] = arr.splice(i, 1);
    redraw(); changed();
    undoToast(ui, `${what} removed`, () => {
      if (!alive) return;
      arr.splice(Math.min(i, arr.length), 0, gone);
      redraw(); changed();
    });
  };

  // ----- details -----
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const detailsHost = h('div', { class: 'form-grid' });
  const nameInput = textInput(run.name, 'e.g. Kitchen feed', (v) => { run.name = v; titleEl.textContent = v || 'Untitled run'; crumbName.textContent = v || 'Untitled run'; save(); }, { required: true, 'aria-label': 'Run name' });
  function drawDetails() {
    ui.clear(detailsHost);
    const method = h('div', { class: 'wr-toggle', role: 'radiogroup', 'aria-label': 'Wiring method' },
      W.METHODS.map((m) => h('button', {
        type: 'button', role: 'radio', class: 'wr-toggle-btn', 'aria-checked': String(run.wiringMethod === m.id),
        onClick: () => {
          if (run.wiringMethod === m.id) return;
          run.wiringMethod = m.id;
          run.conduit = m.id === 'conduit' ? (run.conduit || { type: 'EMT', tradeSize: '21' }) : null;
          drawDetails(); drawConductors(); changed();
        },
      }, m.label)));
    h(detailsHost, null,
      h('label', { class: 'field span-2' }, h('span', null, 'Name *'), nameInput),
      labeled('Job', h('select', { class: 'input', onChange: (e) => { run.jobId = e.target.value || null; save(); } },
        h('option', { value: '' }, '— none —'), jobs.map((j) => h('option', { value: j.id, selected: j.id === run.jobId }, jobLabel(j))))),
      labeled('Location', textInput(run.location, 'e.g. Kitchen, north wall', (v) => { run.location = v; save(); })),
      h('div', { class: 'field' }, h('span', null, 'Wiring method'), method),
      run.wiringMethod === 'conduit' ? labeled('Conduit', h('select', { class: 'input', onChange: (e) => { run.conduit.type = e.target.value; changed(); } },
        W.CONDUIT_TYPES.map((t) => h('option', { value: t.id, selected: t.id === run.conduit.type }, t.label)))) : null,
      run.wiringMethod === 'conduit' ? labeled('Trade size', h('select', { class: 'input', onChange: (e) => { run.conduit.tradeSize = e.target.value; changed(); } },
        W.TRADE_SIZES.map((t) => h('option', { value: t.id, selected: t.id === String(run.conduit.tradeSize) }, t.label)))) : null);
  }

  // ----- segments -----
  const segHost = h('div', { class: 'wr-rows' });
  function drawSegs() {
    ui.clear(segHost);
    if (!run.segments.length) segHost.append(h('div', { class: 'wr-empty muted' }, 'No segments yet. Measure with the AR tape, trace a plan, or type a length.'));
    run.segments.forEach((s, i) => {
      const tone = s.source === 'ar' ? 'info' : s.source === 'plan' ? 'accent' : s.source === 'video' ? 'warning' : 'neutral';
      segHost.append(h('div', { class: 'wr-seg' },
        h('span', { class: 'wr-seg-n num', 'aria-hidden': 'true' }, i + 1),
        h('div', { class: 'wr-seg-main' },
          textInput(s.label, 'Label, e.g. Panel to kitchen', (v) => { s.label = v; save(); }, { 'aria-label': `Segment ${i + 1} label` }),
          textInput(s.note, 'Note', (v) => { s.note = v; save(); }, { 'aria-label': `Segment ${i + 1} note`, class: 'input wr-note' })),
        h('div', { class: 'wr-seg-len' },
          lengthInput({ value: s.lengthM, label: `Segment ${i + 1} length`, onChange: (v) => { s.lengthM = v; changed(); } }),
          ui.badge(W.SOURCES[s.source], tone)),
        h('div', { class: 'wr-actions' },
          iconBtn('<path d="M12 19V5M5 12l7-7 7 7"/>', 'Move up', () => move(run.segments, i, -1, drawSegs), { disabled: i === 0 }),
          iconBtn('<path d="M12 5v14M5 12l7 7 7-7"/>', 'Move down', () => move(run.segments, i, 1, drawSegs), { disabled: i === run.segments.length - 1 }),
          iconBtn('trash', 'Delete segment', () => removeAt(run.segments, i, drawSegs, s.label || `Segment ${i + 1}`), { danger: true }))));
    });
  }
  const addManual = () => {
    run.segments.push(W.newSegment({ label: `Segment ${run.segments.length + 1}`, source: 'manual' }));
    drawSegs(); changed();
    segHost.querySelector('.wr-seg:last-child .wr-len')?.focus();
  };

  // ----- AR -----
  let arSupport = null;
  const arNote = h('span', { class: 'wr-ar-note muted' }, 'Checking for AR…');
  const recordToggle = h('label', { class: 'field check wr-rec-toggle', hidden: true },
    h('input', { type: 'checkbox', checked: recordPref(), onChange: (e) => setRecordPref(e.target.checked) }),
    h('span', null, 'Record video while measuring'));
  getArSupport().then((s) => {
    arSupport = s;
    arNote.textContent = s.mode === 'native' ? 'AR ready (ARKit)' : s.mode === 'webxr' ? 'AR ready (WebXR)' : 'No AR on this device';
    recordToggle.hidden = s.mode === 'none';
  });
  const addFromAr = () => {
    if (!arSupport) { ui.toast('Still checking for AR, try again in a moment'); return; }
    if (arSupport.mode === 'none') { noArSheet(arSupport.reason); return; }
    let seen = false;
    try { seen = localStorage.getItem(TIPS_KEY) === '1'; } catch { /* storage blocked */ }
    if (seen) startAr(); else arTipsSheet();
  };
  function startAr() {
    // measurePath must start inside the tap handler: WebXR needs the user's gesture.
    const record = recordPref();
    measurePath({ units, record }).then(afterAr).catch((e) => {
      if (isCancelled(e)) return;
      console.error(e);
      ui.toast(e?.message || 'AR measuring stopped', 'error', 4500);
    });
  }
  // Keep the recording on the device straight away (nothing is lost if the app closes), then ask.
  async function afterAr(path) {
    let recording = null;
    if (path.video?.blob) {
      try {
        recording = await R.saveRecording(store, path.video.blob, {
          durationMs: path.video.durationMs, mimeType: path.video.mimeType, source: path.video.source,
          jobId: run.jobId, runId: id, label: `${run.name || 'Wire run'}: AR path`, totalM: path.totalM,
          markers: V.markersFromPath(path),
        });
      } catch (e) { ui.toast(e?.message || "The video couldn't be kept on this device.", 'error', 7000); }
    }
    if (!alive) {
      if (recording) ui.toast('The AR measurement was not added (you left the run). Its video is under Wire runs > Videos on this device.', 'info', 6000);
      return;
    }
    confirmPath(path, { source: 'ar', recording, videoNote: recording ? '' : (path.videoNote || '') });
  }
  function arTipsSheet() {
    const dont = h('input', { type: 'checkbox' });
    const s = ui.openSheet({
      title: 'AR tape', dialog: true,
      body: h('div', { class: 'stack' },
        h('p', { class: 'wr-p' }, 'Aim the dot at the wall or conduit. Tap to drop a point at each end and at every bend. Undo removes the last point. Done adds the run.'),
        h('ul', { class: 'wr-tips' }, AR_TIPS.map((t) => h('li', null, t))),
        h('label', { class: 'field check' }, dont, h('span', null, "Don't show this again"))),
      actions: [
        ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }),
        ui.button('Start', { variant: 'primary', icon: ICON_AR, onClick: () => {
          if (dont.checked) { try { localStorage.setItem(TIPS_KEY, '1'); } catch { /* ignore */ } }
          s.close();
          startAr();
        } }),
      ],
    });
  }
  function noArSheet(reason) {
    const s = ui.openSheet({
      title: 'AR measuring is not available here', dialog: true,
      body: h('div', { class: 'stack' },
        h('p', { class: 'wr-p' }, reason || 'This device has no AR support.'),
        h('p', { class: 'wr-p muted' }, 'The AR tape works in Chrome on Android phones that support ARCore, and in the Fishtape iOS app. You can still trace the run on a plan or type the length, and record or pick a video of the run under Videos to re-check it later.')),
      actions: [
        ui.button('Close', { variant: 'ghost', onClick: () => s.close() }),
        ui.button('Type a length', { icon: 'edit', onClick: () => { s.close(); addManual(); } }),
        ui.button('Trace on a plan', { variant: 'primary', icon: 'pen', onClick: () => { s.close(); addFromPlan(); } }),
      ],
    });
  }

  // ----- plan trace -----
  function addFromPlan() {
    const drawings = store.list('drawings').sort((a, b) =>
      (Number(b.jobId === run.jobId && !!run.jobId) - Number(a.jobId === run.jobId && !!run.jobId)) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const s = ui.openSheet({
      title: 'Trace on a plan',
      body: drawings.length ? h('div', { class: 'stack' },
        h('p', { class: 'wr-p muted' }, 'Pick a drawing, then tap points along the route. Lengths come from the drawing scale.'),
        h('div', { class: 'list' }, drawings.map((d) => h('button', {
          type: 'button', class: 'list-row click wr-dw-row',
          onClick: () => { s.close(); traceOn(d); },
        },
        h('span', { class: 'wr-dw-thumb' }, d.thumb ? h('img', { src: d.thumb, alt: '' }) : ui.icon('pen', 20)),
        h('span', { class: 'grow' },
          h('span', { class: 'title' }, d.name || 'Untitled drawing'),
          h('span', { class: 'meta' }, [jobById.get(d.jobId)?.number, d.scale > 0 ? `Scale ${d.scale} px = 1 ft` : 'No scale: you will set one', d.underlay ? 'Plan underlay' : null].filter(Boolean).join(' · '))),
        ui.icon('chevron-right', 18)))))
        : ui.empty({ icon: 'pen', title: 'No drawings yet', text: 'Import a floor plan or sketch one in Plans & drawings, then trace runs on it.', action: ui.button('Plans & drawings', { href: '#/drawings' }) }),
    });
  }
  async function traceOn(d) {
    const res = await traceSheet(ui, d, units);
    if (!res) return;
    const scaleNote = res.calibrated ? `scale set while tracing (${Math.round(res.scale * 10) / 10} px per ft)` : `drawing scale ${res.scale} px per ft`;
    confirmPath(res.path, { source: 'plan', label: `Trace on ${d.name || 'plan'}`, note: `Traced on "${d.name || 'plan'}", ${scaleNote}`, drawingId: d.id });
  }

  // ----- confirm a measured path -----
  function confirmPath(path, { source, label = '', note = '', drawingId = null, recording = null, videoNote = '' }) {
    const legs = path.segments || [];
    const labelIn = h('input', { class: 'input', value: label || (source === 'ar' ? `AR path ${run.segments.length + 1}` : source === 'video' ? 'Frame measurement' : 'Plan trace') });
    const split = h('input', { type: 'checkbox' });
    const keepSnap = h('input', { type: 'checkbox', checked: true });
    // A recording made while measuring: attach now, keep on the device for later, or drop it.
    let videoChoice = null;
    let decision = null;
    let added = false;
    let videoBlock = null;
    if (recording) {
      decision = V.attachDecision({ bytes: recording.bytes, online: online(), deviceMemoryGb: deviceMemoryGb() });
      videoChoice = decision.action;
      const opt = (value, text) => h('label', { class: 'field check' },
        h('input', { type: 'radio', name: `wr-vid-${recording.id}`, value, checked: videoChoice === value, onChange: () => { videoChoice = value; } }),
        h('span', null, text));
      videoBlock = h('div', { class: 'wr-vid-choice stack' },
        h('div', { class: 'wr-sub-head' }, h('strong', null, `Video ${V.fmtClock(recording.durationMs)} · ${V.fmtBytes(recording.bytes)}`), h('span', { class: 'muted' }, decision.message)),
        opt('attach', 'Attach it to this run'),
        opt('keep', 'Keep it on this device and attach it later'),
        opt('delete', "Don't keep the video"));
    } else if (videoNote) {
      videoBlock = h('p', { class: 'wr-p muted' }, `No video this time: ${videoNote}`);
    }
    const s = ui.openSheet({
      title: source === 'ar' ? 'Add AR measurement' : source === 'video' ? 'Add frame measurement' : 'Add plan trace', dialog: true,
      body: h('div', { class: 'stack' },
        h('div', { class: 'wr-big num' }, W.fmtSeg(path.totalM, units)),
        legs.length > 1 ? h('ol', { class: 'wr-legs muted' }, legs.map((l) => h('li', { class: 'num' }, W.fmtSeg(l.lengthM, units)))) : null,
        source === 'ar' ? h('p', { class: 'wr-p muted' }, `AR lengths are estimates, typically within about ${W.AR_TYPICAL_ERROR_PCT}% in good conditions.`) : null,
        source === 'video' ? h('p', { class: 'wr-caution' }, 'Measured on a still frame from a scale you set. It is only right along the flat surface your reference lies on, seen square-on; anything at an angle or nearer the camera comes out wrong. Use it as a check.') : null,
        labeled('Label', labelIn),
        legs.length > 1 ? h('label', { class: 'field check' }, split, h('span', null, `Add each leg as its own segment (${legs.length})`)) : null,
        path.snapshot ? h('img', { class: 'wr-snap', src: path.snapshot, alt: 'AR snapshot' }) : null,
        path.snapshot ? h('label', { class: 'field check' }, keepSnap, h('span', null, 'Save the snapshot with the photos')) : null,
        videoBlock),
      actions: [
        ui.button('Discard', { variant: 'ghost', onClick: () => s.close() }),
        ui.button('Add', { variant: 'primary', icon: 'check', onClick: () => {
          const segs = W.segmentsFromPath(path, { source, label: labelIn.value.trim(), note, split: split.checked });
          run.segments.push(...segs);
          if (drawingId) run.drawingId = drawingId;
          if (path.snapshot && keepSnap.checked && run.photos.length < MAX_PHOTOS) {
            run.photos.push({ id: W.newId(), dataUrl: path.snapshot, caption: labelIn.value.trim(), takenAt: new Date().toISOString() });
            drawPhotos();
          }
          added = true;
          s.close();
          drawSegs(); changed();
          save.flush();
          ui.toast(`Added ${W.fmtSeg(path.totalM, units)}`, 'success');
          if (recording) placeVideo(recording, path, segs, videoChoice, decision);
        } }),
      ],
      onClose: () => { if (recording && !added) keepOrDropVideo(recording); },
    });
  }

  // The measurement was added: put its video where the person chose, with a marker per point.
  async function placeVideo(rec, path, segs, choice, decision) {
    if (choice === 'delete') { await R.deleteRecording(store, rec.id); return; }
    R.updateRecording(store, rec.id, { markers: V.markersFromPath(path, { segIds: segs.map((x) => x.id) }) });
    if (choice === 'keep') {
      ui.toast(decision?.action === 'keep' ? decision.message : 'The video is on this device. Attach it from Videos on this run when you need it.', 'info', 8000);
      drawVideos();
      return;
    }
    try {
      const v = R.attachRecording(store, rec.id, id, { actorId: store.actorId });
      drawVideos();
      U.uploadVideo(store, id, v.id).catch(() => { /* offline: resumes when the connection is back */ });
    } catch (e) { ui.toast(e?.message || "Couldn't attach the video", 'error', 5000); }
  }

  // The measurement was discarded: ask whether its video is still wanted.
  function keepOrDropVideo(rec) {
    const d = ui.openSheet({
      title: 'Keep the video?', dialog: true,
      body: h('p', { class: 'wr-p' }, `The measurement was not added. Keep its ${V.fmtClock(rec.durationMs)} video (${V.fmtBytes(rec.bytes)}) on this device to attach later?`),
      actions: [
        ui.button('Delete the video', { variant: 'ghost danger', onClick: () => { R.deleteRecording(store, rec.id); d.close(); } }),
        ui.button('Keep it', { variant: 'primary', onClick: () => { d.close(); drawVideos(); ui.toast('Kept under Videos on this device', 'success'); } }),
      ],
    });
  }

  // ----- videos -----
  const videoHost = h('div', { class: 'wr-videos' });
  const videoFoot = h('div', { class: 'row wr-add' });
  let localIds = new Set(); // localIds whose bytes are on this device
  let pollTimer = null;
  const runVideos = () => V.normalizeVideos(store.get('wireRuns', id)?.videos);
  async function refreshLocal() {
    localIds = await R.presentLocally(runVideos().map((v) => v.localId));
    if (alive) drawVideos();
  }
  let videoDrawPending = false;
  videoHost.addEventListener('focusout', () => setTimeout(() => { if (videoDrawPending && !videoHost.contains(document.activeElement)) drawVideos(); }, 0));
  function drawVideos() {
    if (!alive) return;
    // don't pull a name field out from under someone typing in it; redraw when they leave it
    if (videoHost.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') { videoDrawPending = true; return; }
    videoDrawPending = false;
    ui.clear(videoHost);
    const vids = runVideos();
    if (!vids.length) videoHost.append(h('div', { class: 'wr-empty muted' }, 'No videos. Tick "Record video while measuring" before using the AR tape, or record or pick a video of the run.'));
    vids.forEach((v, i) => videoHost.append(videoRow(v, i)));
    const recs = R.listRecordings(store);
    const mine = recs.filter((r) => r.runId === id).length;
    ui.clear(videoFoot).append(
      ui.button('Record or pick a video', { size: 'sm', icon: ICON_VIDEO, onClick: addVideoFile }),
      ui.button(`Attach a recording${recs.length ? ` (${recs.length})` : ''}`, { size: 'sm', icon: 'plus', disabled: !recs.length, onClick: attachSheet }),
      h('a', { class: 'wr-vid-store', href: '#/wireruns/recordings' }, mine ? `${mine} recording${mine === 1 ? '' : 's'} of this run waiting on this device` : 'Videos on this device'));
    schedulePoll(vids);
  }
  function videoRow(v, i) {
    const hasLocal = localIds.has(v.localId);
    const st = V.videoStatus(v, { hasLocal });
    const prog = U.uploadProgress(v.id);
    const meta = [V.VIDEO_SOURCES[v.source], V.fmtClock(v.durationMs), V.fmtBytes(v.bytes), v.markers.length ? `${v.markers.length} marker${v.markers.length === 1 ? '' : 's'}` : null, ui.fmtDate(v.recordedAt)].filter(Boolean).join(' · ');
    const playable = hasLocal || (v.mediaId && ['ready', 'processing'].includes(v.status));
    const name = h('input', { class: 'input wr-vid-name', value: v.label || `Video ${i + 1}`, 'aria-label': `Video ${i + 1} name`,
      onChange: (e) => U.patchRunVideo(store, id, v.id, { label: e.target.value.trim() }) });
    const pct = prog ? Math.round((prog.sent / Math.max(1, prog.total)) * 100) : 0;
    return h('div', { class: 'wr-vid' },
      h('button', { type: 'button', class: 'wr-vid-play', title: playable ? 'Play and re-check' : 'Not playable on this device yet', 'aria-label': `Play ${v.label || `video ${i + 1}`}`, disabled: !playable, onClick: () => openReview(v.id) }, ui.icon('play', 22)),
      h('div', { class: 'wr-vid-main' }, name, h('div', { class: 'muted wr-sub' }, meta),
        prog ? h('div', { class: 'progress wr-vid-progress', role: 'progressbar', 'aria-label': 'Upload progress', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('i', { style: { width: `${pct}%` } })) : null,
        v.status === 'failed' && v.error ? h('div', { class: 'wr-sub wr-vid-err' }, v.error) : null),
      ui.badge(prog ? `uploading ${pct}%` : st.label, st.tone),
      h('div', { class: 'wr-actions' },
        V.needsUpload(v, { hasLocal }) && !U.isUploading(v.id) ? iconBtn('upload', 'Upload now', () => uploadNow(v)) : null,
        !v.mediaId && hasLocal ? iconBtn('<path d="M9 14l-5-5 5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/>', 'Detach (keep it on this device to attach later)', () => detach(v)) : null,
        v.status === 'ready' && hasLocal ? iconBtn('eraser', `Free ${V.fmtBytes(v.bytes)} on this device (the server keeps the video)`, () => freeCopy(v)) : null,
        iconBtn('trash', 'Remove video', () => removeVid(v), { danger: true })));
  }
  function uploadNow(v) {
    if (!online()) { ui.toast('No connection. It uploads by itself when you are back online.', 'info', 4000); return; }
    U.uploadVideo(store, id, v.id).then(() => drawVideos()).catch((e) => ui.toast(e?.message || 'Upload stopped; it will try again later.', 'warning', 5000));
    drawVideos();
  }
  function detach(v) {
    try { R.detachVideo(store, id, v.id); ui.toast('Moved to Videos on this device', 'success'); } catch (e) { ui.toast(e.message, 'error'); }
    drawVideos();
  }
  async function freeCopy(v) {
    if (!(await ui.confirmDialog(`Remove the ${V.fmtBytes(v.bytes)} copy on this device? The video stays on the server and still plays here when you are online (measuring on a frame needs a connection then).`, { title: 'Free up space', okLabel: 'Remove the copy', danger: false }))) return;
    await R.dropLocalCopy(store, id, v.id);
    await refreshLocal();
    ui.toast('Space freed', 'success');
  }
  async function removeVid(v) {
    if (!(await ui.confirmDialog(`Remove "${v.label || 'this video'}" from the run? It is deleted from this device${v.mediaId ? ' and the server' : ''}. The measurements stay.`, { okLabel: 'Remove' }))) return;
    const { serverError } = await R.removeVideo(store, id, v.id, { deleteServer: U.deleteMedia });
    if (serverError) ui.toast("Removed here, but the server copy couldn't be deleted right now.", 'warning', 5000);
    else ui.toast('Video removed');
    drawVideos();
  }
  // Uploads finishing elsewhere and the server's optimising: check every few seconds while open.
  function schedulePoll(vids) {
    const waiting = vids.some((v) => v.mediaId && ['uploading', 'processing'].includes(v.status) && !U.isUploading(v.id));
    if (!waiting || pollTimer || !online()) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (!alive) return;
      try { await U.refreshServerStatus(store, id); } catch { /* try again next time */ }
      drawVideos();
    }, 5000);
  }
  async function addVideoFile() {
    const file = await pickVideo();
    if (!file) return;
    let rec;
    try {
      const durationMs = await probeDuration(file);
      rec = await R.saveRecording(store, file, { durationMs, mimeType: file.type, source: 'file', jobId: run.jobId, runId: id, label: (file.name || '').replace(/\.[a-z0-9]+$/i, '').slice(0, 80) || `${run.name || 'Wire run'} video` });
    } catch (e) { ui.toast(e?.message || "Couldn't keep that video", 'error', 6000); return; }
    const d = V.attachDecision({ bytes: rec.bytes, online: online(), deviceMemoryGb: deviceMemoryGb() });
    if (d.action === 'keep') { ui.toast(d.message, 'info', 8000); drawVideos(); return; }
    try {
      const v = R.attachRecording(store, rec.id, id, { actorId: store.actorId });
      U.uploadVideo(store, id, v.id).catch(() => {});
      ui.toast(d.message, 'success', 4000);
    } catch (e) { ui.toast(e.message, 'error'); }
    await refreshLocal();
  }
  function attachSheet() {
    const recs = R.listRecordings(store);
    const rank = (r) => (r.runId === id ? 0 : r.jobId && r.jobId === run.jobId ? 1 : 2);
    const sorted = [...recs].sort((a, b) => rank(a) - rank(b) || b.recordedAt.localeCompare(a.recordedAt));
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const sheet = ui.openSheet({
      title: 'Attach a recording',
      body: h('div', { class: 'stack' },
        h('p', { class: 'wr-p muted' }, 'Recordings kept on this device. Attaching one adds it to this run with its markers and uploads it in the background.'),
        h('div', { class: 'list' }, sorted.map((r) => h('button', {
          type: 'button', class: 'list-row click wr-dw-row',
          onClick: () => {
            try {
              const v = R.attachRecording(store, r.id, id, { actorId: store.actorId });
              sheet.close();
              U.uploadVideo(store, id, v.id).catch(() => {});
              ui.toast(attachedNote(store, r.bytes), 'success', 4000);
              refreshLocal();
            } catch (e) { ui.toast(e.message, 'error'); }
          },
        },
        h('span', { class: 'wr-dw-thumb' }, ui.icon('play', 20)),
        h('span', { class: 'grow' },
          h('span', { class: 'title' }, r.label || 'Recording'),
          h('span', { class: 'meta' }, [r.runId === id ? 'made on this run' : jobLabel(jobById.get(r.jobId)) || 'no job', V.fmtClock(r.durationMs), V.fmtBytes(r.bytes), r.markers.length ? `${r.markers.length} markers` : null, ui.fmtDate(r.recordedAt)].filter(Boolean).join(' · '))),
        ui.icon('chevron-right', 18))))),
    });
  }

  // ----- re-check: play a video beside the run's measurements -----
  let closeReview = null;
  async function openReview(videoId) {
    const v = runVideos().find((x) => x.id === videoId);
    if (!v) return;
    let src = '', local = false;
    if (v.localId) { src = (await blobUrl(v.localId)) || ''; local = !!src; }
    if (!src && v.mediaId) {
      // a signed link that expires in about 15 minutes; reviewSheet renews it if it runs out mid-watch
      try { const m = await U.fetchMedia(v.mediaId); if (m?.url) src = U.mediaUrl(m.url); } catch { /* offline */ }
    }
    if (!src) { ui.toast(online() ? 'The video is still being prepared on the server. Try again in a minute.' : 'This video is not on this device, and there is no connection to stream it.', 'info', 5000); return; }
    reviewSheet({ video: v, src, local });
  }

  function reviewSheet({ video, src, local }) {
    let markers = video.markers;
    const vid = h('video', { class: 'wr-review-video', controls: true, playsInline: true, preload: 'auto' });
    // A server copy: ask for it with CORS (the API allows the app's origins) so "Measure on this
    // frame" may read its pixels, and renew the signed link if it expires while open.
    if (!local) { vid.crossOrigin = 'anonymous'; U.keepMediaFresh(vid, () => U.fetchMedia(video.mediaId)); }
    vid.src = src;
    const timeEl = h('span', { class: 'num wr-review-time' }, '0:00');
    const list = h('ol', { class: 'wr-review-marks' });
    const segList = h('ul', { class: 'wr-review-segs' });
    const segById = () => new Map(run.segments.map((x, i) => [x.id, { seg: x, n: i + 1 }]));
    let active = -1;
    const seek = (ms) => { vid.pause(); vid.currentTime = Math.max(0, ms / 1000); };
    const stepFrame = (dir) => { vid.pause(); vid.currentTime = Math.max(0, vid.currentTime + dir / 30); };
    const jump = (dir) => { const i = V.stepMarker(markers, vid.currentTime * 1000, dir); if (i >= 0) seek(markers[i].atMs); };
    function drawMarks() {
      ui.clear(list);
      const segs = segById();
      if (!markers.length) list.append(h('li', { class: 'muted wr-review-none' }, 'No markers. Use "Mark this moment" to add your own.'));
      markers.forEach((m, i) => {
        const s = m.segId ? segs.get(m.segId) : null;
        list.append(h('li', null, h('button', { type: 'button', class: ['wr-review-mark', i === active ? 'on' : null], onClick: () => seek(m.atMs) },
          h('span', { class: 'num wr-review-at' }, V.fmtClock(m.atMs, { tenths: true })),
          h('span', { class: 'grow' }, m.label,
            m.legM != null ? h('span', { class: 'muted' }, ` · leg ${W.fmtSeg(m.legM, units)}`) : null,
            s ? h('span', { class: 'muted' }, ` · segment ${s.n}${s.seg.label ? ` (${s.seg.label})` : ''}`) : null))));
      });
      const activeSeg = active >= 0 ? markers[active].segId : null;
      ui.clear(segList);
      run.segments.forEach((x, i) => segList.append(h('li', { class: x.id === activeSeg ? 'on' : null },
        h('span', null, `${i + 1}. ${x.label || 'Segment'}`), h('span', { class: 'num' }, W.fmtSeg(x.lengthM, units)))));
      if (!run.segments.length) segList.append(h('li', { class: 'muted' }, 'No segments yet.'));
    }
    vid.addEventListener('timeupdate', () => {
      timeEl.textContent = V.fmtClock(vid.currentTime * 1000, { tenths: true });
      const i = V.markerAt(markers, vid.currentTime * 1000);
      if (i !== active) { active = i; drawMarks(); }
    });
    vid.addEventListener('error', () => ui.toast("This video won't play here. A WebM recording may need the server's optimised copy; try again once it shows \"on the server\".", 'error', 6000));
    const markHere = async () => {
      vid.pause();
      const at = Math.round(vid.currentTime * 1000);
      const label = await ui.promptDialog(`Name the moment at ${V.fmtClock(at)}`, { title: 'Mark this moment', okLabel: 'Add marker', value: '' });
      if (label == null) return;
      markers = V.withMarker(markers, { atMs: at, label }, video.durationMs || null);
      U.patchRunVideo(store, id, video.id, { markers });
      drawMarks();
    };
    const measureFrame = async () => {
      vid.pause();
      const at = Math.round(vid.currentTime * 1000);
      let frame;
      try { frame = grabFrame(vid); } catch (e) {
        ui.toast(e?.name === 'SecurityError' ? "This frame can't be read here: the server didn't allow this app to use the video's pixels. Measure on the device that recorded it, or in the browser." : "Couldn't read this frame.", 'error', 7000);
        return;
      }
      const ok = await ui.confirmDialog("AR can't re-measure a recorded frame: a still picture has no depth or tracking. You can measure on the picture against something of known length instead: set the scale by tapping both ends of it (a 4 ft sheet edge, a 2x4 box, a stud bay), then tap along the wire. It is only right along the same flat surface as the reference, seen square-on.", { title: 'Measure on this frame', okLabel: 'Set the scale', danger: false });
      if (!ok) return;
      el.classList.add('wr-review-hidden');
      const res = await traceSheet(ui, { name: `${video.label || 'Video'} at ${V.fmtClock(at)}`, underlay: frame.dataUrl, underlayX: 0, underlayY: 0, underlayW: frame.width, underlayH: frame.height, scale: null }, units);
      el.classList.remove('wr-review-hidden');
      if (!res) return;
      const scaleNote = `scale set on the frame (${Math.round(res.scale * 10) / 10} px per ft)`;
      confirmPath(res.path, { source: 'video', label: `Frame at ${V.fmtClock(at)}`, note: `Measured on a still frame at ${V.fmtClock(at)} of "${video.label || 'video'}", ${scaleNote}. Approximate.` });
    };
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      closeReview = null;
      document.removeEventListener('keydown', onKey);
      vid.pause();
      vid.removeAttribute('src');
      vid.load();
      el.remove();
      if (local) URL.revokeObjectURL(src);
    };
    const onKey = (e) => {
      if (document.querySelector('.scrim, .wr-trace')) return;
      if (e.target?.closest?.('input, textarea')) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight' && e.shiftKey) jump(1);
      else if (e.key === 'ArrowLeft' && e.shiftKey) jump(-1);
      else if (e.key === 'ArrowRight' || e.key === '.') stepFrame(1);
      else if (e.key === 'ArrowLeft' || e.key === ',') stepFrame(-1);
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    const el = h('div', { class: 'wr-review', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Re-check ${video.label || 'video'}` },
      h('header', { class: 'wr-trace-head' },
        h('div', { class: 'wr-trace-title' }, h('strong', null, video.label || 'Video'), h('span', { class: 'muted wr-trace-scale' }, [V.VIDEO_SOURCES[video.source], V.fmtClock(video.durationMs), local ? 'from this device' : 'streamed from the server'].filter(Boolean).join(' · '))),
        timeEl,
        ui.button('', { variant: 'ghost', icon: 'x', title: 'Close', onClick: close })),
      h('div', { class: 'wr-review-body' },
        h('div', { class: 'wr-review-stage' }, vid,
          h('div', { class: 'wr-review-tools' },
            ui.button('Previous point', { size: 'sm', icon: 'chevron-left', onClick: () => jump(-1) }),
            ui.button('', { size: 'sm', icon: '<path d="M11 6l-6 6 6 6"/><path d="M19 6v12"/>', title: 'Back one frame', onClick: () => stepFrame(-1) }),
            ui.button('', { size: 'sm', icon: '<path d="M13 6l6 6-6 6"/><path d="M5 6v12"/>', title: 'Forward one frame', onClick: () => stepFrame(1) }),
            ui.button('Next point', { size: 'sm', icon: 'chevron-right', onClick: () => jump(1) }),
            ui.button('Mark this moment', { size: 'sm', icon: 'marker', onClick: markHere }),
            ui.button('Measure on this frame', { size: 'sm', variant: 'primary', icon: 'ruler', onClick: measureFrame }))),
        h('aside', { class: 'wr-review-side' },
          h('h3', null, 'Points in the video'), list,
          h('h3', null, 'Run measurements'), segList,
          h('p', { class: 'wr-p muted wr-review-help' }, 'Tap a point to jump to it. Arrow keys step a frame; Shift+arrow jumps between points.'))));
    document.body.append(el);
    closeReview = close;
    drawMarks();
  }

  // ----- allowances -----
  const allowHost = h('div', { class: 'stack' });
  const liveDrop = [];
  function drawAllowances() {
    ui.clear(allowHost);
    liveDrop.length = 0;
    const a = run.allowances;
    const drops = h('div', { class: 'wr-rows' });
    a.drops.forEach((d, i) => {
      const sub = h('span', { class: 'wr-sub-total num' });
      liveDrop.push(() => { sub.textContent = `= ${W.fmtTotal(d.count * d.lengthM, units)}`; });
      drops.append(h('div', { class: 'wr-drop' },
        textInput(d.label, 'e.g. Receptacles', (v) => { d.label = v; save(); }, { 'aria-label': `Drop ${i + 1} label` }),
        h('span', { class: 'wr-x' }, numInput(d.count, (v) => { d.count = Math.max(0, v || 0); changed(); }, { 'aria-label': `Drop ${i + 1} count` }), '×'),
        lengthInput({ value: d.lengthM, label: `Drop ${i + 1} length each`, onChange: (v) => { d.lengthM = v; changed(); } }),
        sub,
        iconBtn('trash', 'Delete drop', () => removeAt(a.drops, i, drawAllowances, 'Drop'), { danger: true })));
    });
    const freeMm = Math.round(W.CEC_FREE_CONDUCTOR_M * 1000);
    h(allowHost, null,
      h('div', null,
        h('div', { class: 'wr-sub-head' }, h('strong', null, 'Drops'), h('span', { class: 'muted' }, 'Down the wall from the ceiling (or up from the floor) to each box')),
        drops,
        ui.button('Add drop', { size: 'sm', icon: 'plus', onClick: () => { a.drops.push({ label: '', count: 1, lengthM: imperial ? 4 * M_PER_FT : 1.2 }); drawAllowances(); changed(); } })),
      h('div', { class: 'form-grid' },
        labeled('Boxes', numInput(a.boxCount, (v) => { a.boxCount = Math.max(0, v || 0); changed(); }, { 'aria-label': 'Number of boxes' })),
        labeled('Makeup per box', lengthInput({ value: a.boxMakeupM, bare: BARE_SMALL, label: 'Makeup per box', onChange: (v) => { a.boxMakeupM = v; changed(); } }),
          `Default ${W.fmtSeg(W.DEFAULT_BOX_MAKEUP_M, units)}: two cable ends × ${freeMm} mm free conductor (${W.CEC_FREE_CONDUCTOR_REF}; 2024 value not yet verified).`),
        labeled('Panel makeup', lengthInput({ value: a.panelMakeupM, label: 'Panel makeup', onChange: (v) => { a.panelMakeupM = v; changed(); } }),
          `To the breaker and neutral bar. About ${W.fmtSeg(W.DEFAULT_PANEL_MAKEUP_M, units)} is usual; 0 if the run doesn't end at a panel.`),
        labeled('Waste %', numInput(a.wastePct, (v) => { a.wastePct = Math.max(0, v || 0); changed(); }, { step: '1', max: '100', 'aria-label': 'Waste percent' }),
          'Covers offsets, bends around framing and measuring error.')));
    liveDrop.forEach((f) => f());
  }

  // ----- conductors -----
  const condHost = h('div', { class: 'wr-rows' });
  const liveCond = new Map();
  const items = store.list('items');
  const pricedItems = W.wireItems(items).sort((a, b) => a.name.localeCompare(b.name));
  const sizeList = h('datalist', { id: `wr-sizes-${id}` });
  const typeList = h('datalist', { id: `wr-types-${id}` });
  function drawConductors() {
    ui.clear(condHost);
    liveCond.clear();
    const cable = run.wiringMethod === 'cable';
    ui.clear(sizeList).append(...(cable ? W.CABLE_SIZES : W.WIRE_SIZES).map((s) => h('option', { value: s })));
    ui.clear(typeList).append(...(cable ? W.CABLE_TYPES : W.WIRE_TYPES).map((s) => h('option', { value: s })));
    if (!run.conductors.length) condHost.append(h('div', { class: 'wr-empty muted' }, 'No conductors. Add the cable or the wires that go in the conduit.'));
    run.conductors.forEach((c, i) => {
      const total = h('strong', { class: 'num' });
      const rolls = h('span', { class: 'muted wr-rolls' });
      liveCond.set(c.id, { total, rolls });
      const desc = textInput(c.description, 'Description', (v) => { c.description = v; changed(); }, { 'aria-label': `Conductor ${i + 1} description` });
      // keep the description in step with type/size/material while it is still the automatic one
      const part = (key) => (v) => {
        const auto = !c.description || c.description === W.autoDescription(c);
        c[key] = v;
        if (auto) { c.description = W.autoDescription(c); desc.value = c.description; }
        changed();
      };
      const itemOpts = [...pricedItems];
      if (c.itemId && !itemOpts.some((it) => it.id === c.itemId)) {
        const it = items.find((x) => x.id === c.itemId);
        itemOpts.push({ id: c.itemId, name: it ? `${it.name} (priced per ${it.unit || '?'}, not a length)` : '(item deleted)', priceCents: it?.priceCents, unit: it?.unit });
      }
      condHost.append(h('div', { class: 'wr-cond' },
        h('div', { class: 'wr-cond-grid' },
          h('label', { class: 'field wr-cond-desc' }, h('span', null, 'Description'), desc),
          labeled('Type', textInput(c.type, cable ? 'NMD90' : 'T90 Nylon', part('type'), { list: typeList.id })),
          labeled('Size', textInput(c.size, cable ? '14/2' : '12', part('size'), { list: sizeList.id })),
          labeled('Material', h('select', { class: 'input', onChange: (e) => part('material')(e.target.value) },
            h('option', { value: 'cu', selected: c.material !== 'al' }, 'Copper'), h('option', { value: 'al', selected: c.material === 'al' }, 'Aluminum'))),
          labeled(cable ? 'Cables per run' : 'Conductors', numInput(c.count, (v) => { c.count = Math.max(0, v || 0); changed(); })),
          h('label', { class: 'field wr-cond-item' }, h('span', null, 'Price book'), h('select', { class: 'input', onChange: (e) => { c.itemId = e.target.value || null; save(); } },
            h('option', { value: '' }, '— none (custom line) —'),
            itemOpts.map((it) => h('option', { value: it.id, selected: it.id === c.itemId }, `${it.name}${it.priceCents != null ? ` · ${ui.fmtMoney(it.priceCents)}/${it.unit}` : ''}`))))),
        h('div', { class: 'wr-cond-foot' },
          h('div', { class: 'wr-cond-out' }, total, rolls),
          iconBtn('trash', 'Delete conductor', () => removeAt(run.conductors, i, drawConductors, 'Conductor'), { danger: true }))));
    });
    refreshTotals();
  }

  // ----- photos -----
  const photoHost = h('div', { class: 'wr-photos' });
  function drawPhotos() {
    ui.clear(photoHost);
    if (!run.photos.length) photoHost.append(h('div', { class: 'wr-empty muted' }, 'No photos. Add the route, the boxes or the panel for whoever pulls the wire.'));
    run.photos.forEach((p, i) => photoHost.append(h('figure', { class: 'wr-photo' },
      h('button', { type: 'button', class: 'wr-photo-view', title: 'View photo', 'aria-label': `View photo ${i + 1} full size`,
        onClick: () => ui.openSheet({ title: p.caption?.trim() || `Photo ${i + 1}`, wide: true, body: h('img', { src: p.dataUrl, alt: p.caption || `Photo ${i + 1}`, class: 'wr-photo-big' }) }) },
        h('img', { src: p.dataUrl, alt: p.caption || `Photo ${i + 1}`, loading: 'lazy' })),
      h('figcaption', null,
        textInput(p.caption, 'Caption', (v) => { p.caption = v; save(); }, { 'aria-label': `Photo ${i + 1} caption` }),
        iconBtn('trash', 'Delete photo', () => removeAt(run.photos, i, drawPhotos, 'Photo'), { danger: true })))));
  }
  async function addPhotos() {
    const room = MAX_PHOTOS - run.photos.length;
    if (room <= 0) { ui.toast(`Up to ${MAX_PHOTOS} photos per run`, 'error'); return; }
    const files = (await pickImages()).slice(0, room);
    let added = 0;
    for (const f of files) {
      try {
        const p = await downscaleImage(f);
        run.photos.push({ id: W.newId(), dataUrl: p.dataUrl, caption: '', takenAt: new Date().toISOString(), width: p.width, height: p.height });
        added++;
      } catch (e) { console.error(e); ui.toast(`Couldn't read ${f.name}`, 'error'); }
    }
    if (added) { drawPhotos(); changed(); ui.toast(`Added ${added} photo${added === 1 ? '' : 's'}`, 'success'); }
  }

  // ----- totals -----
  const totalsHost = h('div', { class: 'wr-totals' });
  function refreshTotals() {
    const t = W.runTotals(run);
    const row = (label, v, cls, hint) => h('div', { class: ['wr-trow', cls] }, h('span', null, label, hint ? h('span', { class: 'wr-thint' }, hint) : null), h('span', { class: 'num' }, v));
    ui.clear(totalsHost);
    h(totalsHost, null,
      row('Run length', W.fmtTotal(t.runM, units), null, `${t.segmentCount} segment${t.segmentCount === 1 ? '' : 's'}`),
      t.dropsM ? row('Drops', W.fmtTotal(t.dropsM, units), null, `${t.dropCount} drop${t.dropCount === 1 ? '' : 's'}`) : null,
      t.boxesM ? row('Box makeup', W.fmtTotal(t.boxesM, units), null, `${t.boxCount} × ${W.fmtSeg(t.boxMakeupM, units)}`) : null,
      t.panelM ? row('Panel makeup', W.fmtTotal(t.panelM, units)) : null,
      t.wasteM ? row(`Waste ${t.wastePct}%`, W.fmtTotal(t.wasteM, units)) : null,
      row('Per conductor', W.fmtTotal(t.totalM, units), 'grand'),
      h('div', { class: 'wr-tother muted num' }, W.fmtTotal(t.totalM, imperial ? 'metric' : 'imperial')),
      t.conductors.length ? h('div', { class: 'wr-tconds' }, t.conductors.map((c) => h('div', { class: 'wr-tcond' },
        h('div', { class: 'wr-trow' }, h('span', null, `${c.label}${c.count !== 1 ? ` × ${c.count}` : ''}`), h('strong', { class: 'num' }, W.fmtTotal(c.lengthM, units))),
        h('div', { class: 'muted wr-rolls' }, c.rolls ? [W.rollsLabel(c.rolls, units), W.leftoverLabel(c.rolls, units)].filter(Boolean).join(', ') : 'Cut to length')))) : null,
      run.wiringMethod === 'conduit' && t.conduitM ? h('div', { class: 'wr-tcond' },
        h('div', { class: 'wr-trow' }, h('span', null, `Conduit ${W.conduitLabel(run)}`), h('strong', { class: 'num' }, W.fmtTotal(t.conduitM, units))),
        h('div', { class: 'muted wr-rolls' }, `About ${t.conduitSticks} sticks of ${W.STICK_M} m (10 ft)`)) : null,
      t.bySource.ar ? h('p', { class: 'wr-caution' }, `${W.fmtTotal(t.bySource.ar, units)} was measured with the AR tape (typically within about ${W.AR_TYPICAL_ERROR_PCT}%). Check critical lengths with a tape.`) : null,
      t.bySource.video ? h('p', { class: 'wr-caution' }, `${W.fmtTotal(t.bySource.video, units)} was measured on still video frames against a scale set by hand. Treat it as approximate.`) : null);
    for (const c of t.conductors) {
      const live = liveCond.get(c.id);
      if (!live) continue;
      live.total.textContent = `${W.fmtTotal(c.lengthM, units)} total`;
      live.rolls.textContent = c.rolls ? [W.rollsLabel(c.rolls, units), W.leftoverLabel(c.rolls, units)].filter(Boolean).join(', ') : 'Cut to length (8 AWG and up)';
    }
    liveDrop.forEach((f) => f());
  }

  // ----- export -----
  const job = () => (run.jobId ? store.get('jobs', run.jobId) : null);
  const pdfBytes = () => {
    save.flush();
    const s = store.settings();
    const j = job();
    return W.buildRunPdf(run, {
      company: s.company || {}, job: j, client: j?.clientId ? store.get('clients', j.clientId) : null,
      dateLabel: ui.fmtDate(new Date()), units, brand: BRAND.name,
      drawingName: run.drawingId ? store.get('drawings', run.drawingId)?.name || '' : '',
    });
  };
  const downloadPdf = () => {
    try {
      const name = W.runFileName(run, job());
      ui.download(name, new Blob([pdfBytes()], { type: 'application/pdf' }));
      store.log('export', `PDF: ${run.name}`, 'wireRuns', id);
    } catch (e) { console.error(e); ui.toast(`Couldn't make the PDF: ${e.message}`, 'error', 4500); }
  };
  let canShare = false;
  // In the iOS app, Download PDF already opens the share sheet.
  try { canShare = !isNativeApp() && !!navigator.canShare?.({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] }); } catch { canShare = false; }
  const sharePdf = async () => {
    try {
      const file = new File([pdfBytes()], W.runFileName(run, job()), { type: 'application/pdf' });
      await navigator.share({ files: [file], title: run.name || 'Wire run' });
      store.log('export', `PDF shared: ${run.name}`, 'wireRuns', id);
    } catch (e) { if (e?.name !== 'AbortError') ui.toast(`Couldn't share: ${e.message}`, 'error'); }
  };
  const downloadCsv = () => {
    save.flush();
    ui.download(W.runFileName(run, job(), 'csv'), W.runToCsv(run, { units, jobLabel: jobLabel(job()) }), 'text/csv');
    store.log('export', `CSV: ${run.name}`, 'wireRuns', id);
  };
  const print = () => { save.flush(); printRun(ui, run, { store, units, job: job() }); };

  // ----- add to estimate -----
  function addToEstimate() {
    save.flush();
    const j = job();
    const drafts = store.list('estimates', (e) => e.status === 'draft' && (j ? e.jobId === j.id : true))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    let target = drafts[0]?.id || '__new';
    let includeConduit = true;
    let conduitItemId = W.matchConduitItem(run, items)?.id || '';
    const preview = h('div', { class: 'stack' });
    const drawPreview = () => {
      ui.clear(preview);
      const { lines, warnings } = W.estimateLines(run, items, { units, includeConduit, conduitItemId });
      const total = lines.reduce((s, l) => s + Math.round(l.qty * l.unitCents), 0);
      h(preview, null,
        lines.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table wr-est-table' },
          h('thead', null, h('tr', null, h('th', null, 'Line'), h('th', { class: 'right' }, 'Qty'), h('th', { class: 'right' }, 'Unit'), h('th', { class: 'right' }, 'Amount'))),
          h('tbody', null, lines.map((l) => h('tr', null,
            h('td', null, l.description, l.itemId ? null : h('div', { class: 'muted wr-sub' }, 'Custom line, price it on the estimate')),
            h('td', { class: 'right num' }, ui.fmtNum(l.qty, Number.isInteger(l.qty) ? 0 : 2)),
            h('td', { class: 'right num' }, ui.fmtMoney(l.unitCents)),
            h('td', { class: 'right num' }, ui.fmtMoney(Math.round(l.qty * l.unitCents)))))),
          h('tfoot', null, h('tr', null, h('td', { colspan: '3' }, h('strong', null, 'Adds')), h('td', { class: 'right num' }, h('strong', null, ui.fmtMoney(total))))))) : null,
        warnings.length ? h('ul', { class: 'wr-warn' }, warnings.map((w) => h('li', null, w))) : null);
      addBtn.disabled = !lines.length;
    };
    const conduitOpts = W.conduitItems(items);
    const body = h('div', { class: 'stack' },
      labeled('Estimate', h('select', { class: 'input', onChange: (e) => { target = e.target.value; } },
        drafts.map((e) => h('option', { value: e.id, selected: e.id === target }, `${e.number} · ${e.title || 'Untitled'} (draft)`)),
        h('option', { value: '__new', selected: target === '__new' }, 'New draft estimate')),
      j ? `Draft estimates for ${jobLabel(j)}.` : 'This run is not linked to a job, so a new estimate will not be either.'),
      run.wiringMethod === 'conduit' ? h('div', { class: 'stack' },
        h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: includeConduit, onChange: (e) => { includeConduit = e.target.checked; drawPreview(); } }), h('span', null, `Include the conduit (${W.conduitLabel(run)})`)),
        labeled('Conduit from the price book', h('select', { class: 'input', onChange: (e) => { conduitItemId = e.target.value; drawPreview(); } },
          h('option', { value: '' }, '— none (custom line) —'),
          conduitOpts.map((it) => h('option', { value: it.id, selected: it.id === conduitItemId }, `${it.name} · ${ui.fmtMoney(it.priceCents)}/${it.unit}`))))) : null,
      h('p', { class: 'wr-p muted' }, 'Quantities are the conductor totals with allowances, in each price-book item\'s unit, rounded up.'),
      preview);
    const addBtn = ui.button('Add lines', { variant: 'primary', icon: 'plus', onClick: () => {
      const { lines } = W.estimateLines(run, items, { units, includeConduit, conduitItemId });
      if (!lines.length) return;
      let est;
      if (target === '__new') {
        const s = store.settings();
        est = store.add('estimates', { ...W.newEstimateRecord({ number: store.nextNumber('estimate'), settings: s, job: j, run, validUntil: ui.today(30) }), lines });
      } else {
        const e = store.get('estimates', target);
        if (!e) { ui.toast('That estimate no longer exists', 'error'); return; }
        est = store.update('estimates', e.id, { lines: [...(e.lines || []), ...lines] }, { summary: `${e.number}: wire from ${run.name}` });
      }
      ui.clear(sheet.body).append(h('div', { class: 'stack' },
        h('p', { class: 'wr-p' }, `Added ${lines.length} line${lines.length === 1 ? '' : 's'} to ${est.number}.`)));
      ui.clear(sheet.el.querySelector('.sheet-foot')).append(
        ui.button('Back to the run', { variant: 'ghost', onClick: () => sheet.close() }),
        ui.button(`Open ${est.number}`, { variant: 'primary', icon: 'file-text', onClick: () => { sheet.close(); nav('#/estimates/' + est.id); } }));
    } });
    const sheet = ui.openSheet({ title: 'Add to estimate', body, actions: [ui.button('Cancel', { variant: 'ghost', onClick: () => sheet.close() }), addBtn] });
    drawPreview();
  }

  // ----- page -----
  const duplicate = () => {
    save.flush();
    const c = store.add('wireRuns', W.duplicateRun(run));
    ui.toast(`Duplicated as ${c.name}`, 'success');
    nav('#/wireruns/' + c.id);
  };
  const remove = async () => {
    save.flush();
    if (await deleteRun(ctx, run)) { removed = true; save.cancel(); nav('#/wireruns'); }
  };

  const crumbName = h('span', null, run.name || 'Untitled run');
  const page = ui.page({
    title: run.name || 'Untitled run',
    subtitle: h('span', null, h('a', { href: '#/wireruns' }, 'Wire runs'), ' / ', crumbName),
    actions: [
      ui.button('PDF', { icon: 'download', variant: 'primary', onClick: downloadPdf }),
      ui.button('Duplicate', { icon: 'copy', onClick: duplicate }),
      ui.button('Delete run', { icon: 'trash', variant: 'ghost danger', onClick: remove }),
    ],
  },
  sizeList, typeList,
  h('div', { class: 'wr-layout' },
    h('div', { class: 'stack' },
      h('section', { class: 'card' }, h('h3', null, 'Details'), detailsHost),
      h('section', { class: 'card' },
        h('div', { class: 'wr-card-head' }, h('h3', null, 'Segments'), arNote),
        segHost,
        h('div', { class: 'row wr-add' },
          ui.button('AR tape', { variant: 'primary', icon: ICON_AR, onClick: addFromAr }),
          ui.button('Trace on a plan', { icon: 'pen', onClick: addFromPlan }),
          ui.button('Type a length', { icon: 'edit', onClick: addManual })),
        recordToggle),
      h('section', { class: 'card' },
        h('div', { class: 'wr-card-head' }, h('h3', null, 'Videos'), h('span', { class: 'muted' }, 'Play back the run with a marker at each measured point')),
        videoHost,
        videoFoot),
      h('section', { class: 'card' }, h('h3', null, 'Allowances'), allowHost),
      h('section', { class: 'card' },
        h('h3', null, run.wiringMethod === 'conduit' ? 'Conductors' : 'Cable and conductors'),
        condHost,
        h('div', { class: 'row wr-add' }, ui.button('Add conductor', { size: 'sm', icon: 'plus', onClick: () => { run.conductors.push(W.newConductor(run.wiringMethod)); drawConductors(); changed(); } }))),
      h('section', { class: 'card' },
        h('div', { class: 'wr-card-head' }, h('h3', null, 'Photos'), h('span', { class: 'muted' }, `${MAX_PHOTOS} max, resized to save space`)),
        photoHost,
        h('div', { class: 'row wr-add' }, ui.button('Add photos', { size: 'sm', icon: 'image', onClick: addPhotos }))),
      h('section', { class: 'card' }, labeled('Notes', h('textarea', { rows: 4, placeholder: 'Route details, obstacles, who pulls it…', onInput: (e) => { run.notes = e.target.value; save(); } }, run.notes)))),
    h('aside', { class: 'wr-side stack' },
      h('section', { class: 'card' }, h('h3', null, 'Totals'), totalsHost),
      h('section', { class: 'card stack' },
        h('h3', null, 'Export'),
        h('div', { class: 'wr-export' },
          ui.button('Download PDF', { icon: 'download', onClick: downloadPdf }),
          canShare ? ui.button('Share PDF', { icon: ICON_SHARE, onClick: sharePdf }) : null,
          ui.button('Print', { icon: 'printer', onClick: print }),
          ui.button('CSV', { icon: ICON_TABLE, onClick: downloadCsv }))),
      auth.can('estimates') ? h('section', { class: 'card stack' },
        h('h3', null, 'Estimate'),
        h('p', { class: 'wr-p muted' }, 'Add the wire for this run to a draft estimate, priced from the price book.'),
        ui.button('Add to estimate', { icon: 'file-text', onClick: addToEstimate })) : null)));
  root.append(page);
  const titleEl = page.querySelector('.page-head h1');

  drawDetails();
  drawSegs();
  drawAllowances();
  drawConductors();
  drawPhotos();
  drawVideos();
  refreshLocal();
  refreshTotals();
  if (query.fresh) { nameInput.focus(); nameInput.select(); history.replaceState(null, '', '#/wireruns/' + id); }

  // Video entries change underneath the editor (uploads, other devices): redraw just that card.
  const offRun = store.on('wireRuns', (e) => { if (e?.record?.id === id || !e?.record) drawVideos(); });
  const offUpload = U.onUploadChange((videoId) => { if (runVideos().some((v) => v.id === videoId)) drawVideos(); });
  const offRecs = R.onRecordingsChange(() => drawVideos());

  return () => {
    alive = false;
    offRun(); offUpload(); offRecs();
    clearTimeout(pollTimer);
    closeReview?.();
    if (!removed) save.flush();
  };
}

function undoToast(ui, message, undo) {
  let used = false;
  const btn = ui.h('button', { type: 'button', class: 'wr-undo', onClick: () => {
    if (used) return;
    used = true;
    undo();
    btn.closest('.toast')?.remove();
  } }, 'Undo');
  ui.toast(ui.h('span', { class: 'wr-undo-msg' }, message, btn), 'info', 6000);
}

// ---------- video files ----------
/** Ask for one video: the camera (on phones the picker offers to record) or the library. Resolves File or null. */
function pickVideo() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.style.display = 'none';
    const done = (file) => { input.remove(); resolve(file || null); };
    input.addEventListener('change', () => done(input.files?.[0]));
    input.addEventListener('cancel', () => done(null));
    document.body.append(input);
    input.click();
  });
}

/** A video file's length in ms (0 when the browser can't read it). */
function probeDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    let settled = false;
    const done = (ms) => { if (settled) return; settled = true; URL.revokeObjectURL(url); v.removeAttribute('src'); resolve(ms); };
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : 0);
    v.onerror = () => done(0);
    setTimeout(() => done(0), 8000);
    v.src = url;
  });
}

/** The paused frame as a JPEG data URL (long side at most 1920). Throws SecurityError on a cross-origin video. */
function grabFrame(video) {
  const w = video.videoWidth, hgt = video.videoHeight;
  if (!w || !hgt) throw new Error('no frame');
  const k = Math.min(1, 1920 / Math.max(w, hgt));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(hgt * k);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return { dataUrl: c.toDataURL('image/jpeg', 0.85), width: c.width, height: c.height };
}

// ---------- videos on this device ----------
function renderRecordings(root, ctx) {
  const { store, ui, nav, auth } = ctx;
  const { h } = ui;
  const host = h('div', { class: 'stack' });
  const storageHost = h('div', { class: 'grid wr-stats' });
  const listHost = h('div');
  const attachedHost = h('div');
  let showAll = false;
  let alive = true;
  const jobsById = () => new Map(store.list('jobs').map((j) => [j.id, j]));

  async function drawStorage() {
    const recs = R.listRecordings(store);
    const runs = store.list('wireRuns');
    const present = await R.presentLocally(runs.flatMap((r) => (r.videos || []).map((v) => v.localId)));
    const use = V.storageUse(recs, runs, (lid) => present.has(lid));
    const est = await R.storageEstimate();
    if (!alive) return;
    ui.clear(storageHost).append(
      ui.stat({ label: 'Waiting to attach', value: V.fmtBytes(use.unattachedBytes), hint: `${use.unattachedCount} recording${use.unattachedCount === 1 ? '' : 's'}` }),
      ui.stat({ label: 'Attached, kept here', value: V.fmtBytes(use.attachedBytes), hint: `${use.attachedCount} video${use.attachedCount === 1 ? '' : 's'}` }),
      ui.stat({ label: 'App storage', value: est?.usage != null ? V.fmtBytes(est.usage) : '—', hint: est?.quota ? `of about ${V.fmtBytes(est.quota)} this device allows` : 'The browser does not say how much room is left', tone: est?.quota && est.usage / est.quota > 0.8 ? 'accent' : undefined }));
    drawAttached(runs, present);
  }

  function drawList() {
    const focus = jobFocus(store, auth);
    const all = R.listRecordings(store);
    const { shown, hidden } = showAll ? { shown: all, hidden: 0 } : V.recordingsForFocus(all, focus);
    const jobs = jobsById();
    ui.clear(listHost);
    const focusNote = focus && !showAll && hidden
      ? h('p', { class: 'wr-p muted' }, `Showing ${jobLabel(jobs.get(focus))} (the job you're working on). `, h('button', { type: 'button', class: 'wr-linkbtn', onClick: () => { showAll = true; drawList(); } }, `Show ${hidden} more from other jobs`))
      : null;
    listHost.append(h('section', { class: 'card stack' },
      h('div', { class: 'wr-card-head' }, h('h3', null, 'Waiting to attach'),
        ui.button('Record or pick a video', { size: 'sm', icon: ICON_VIDEO, onClick: addLoose })),
      focusNote,
      shown.length ? h('div', { class: 'wr-rows' }, shown.map((r) => recRow(r, jobs))) : h('div', { class: 'wr-empty muted' },
        all.length ? 'None for this job.' : 'No recordings waiting. Big AR recordings, and ones made offline, wait here until you attach them to a run.')));
  }

  function recRow(r, jobs) {
    const run = r.runId ? store.get('wireRuns', r.runId) : null;
    const meta = [V.VIDEO_SOURCES[r.source], V.fmtClock(r.durationMs), V.fmtBytes(r.bytes), r.markers.length ? `${r.markers.length} markers` : null, ui.fmtDate(r.recordedAt)].filter(Boolean).join(' · ');
    return h('div', { class: 'wr-vid' },
      h('button', { type: 'button', class: 'wr-vid-play', title: 'Play', 'aria-label': `Play ${r.label || 'recording'}`, onClick: () => playRec(r) }, ui.icon('play', 22)),
      h('div', { class: 'wr-vid-main' },
        h('input', { class: 'input wr-vid-name', value: r.label || 'Recording', 'aria-label': 'Recording name', onChange: (e) => R.updateRecording(store, r.id, { label: e.target.value.trim() }) }),
        h('div', { class: 'muted wr-sub' }, meta),
        h('div', { class: 'muted wr-sub' }, [jobs.get(r.jobId) ? jobLabel(jobs.get(r.jobId)) : 'No job', run ? `made on ${run.name || 'a run'}` : null].filter(Boolean).join(' · '))),
      h('div', { class: 'wr-actions' },
        ui.button(run ? `Attach to ${run.name || 'its run'}` : 'Attach to a run', { size: 'sm', icon: 'plus', onClick: () => (run ? attachTo(r, run.id) : pickRun(r)) }),
        run ? ui.button('', { size: 'sm', variant: 'ghost', icon: 'more', title: 'Attach to another run', onClick: () => pickRun(r) }) : null,
        ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'trash', title: 'Delete recording', onClick: () => delRec(r) })));
  }

  function drawAttached(runs, present) {
    const rows = [];
    for (const run of runs) {
      for (const v of V.normalizeVideos(run.videos)) if (v.localId && present.has(v.localId)) rows.push({ run, v });
    }
    ui.clear(attachedHost);
    if (!rows.length) return;
    attachedHost.append(h('section', { class: 'card stack' },
      h('div', { class: 'wr-card-head' }, h('h3', null, 'Attached videos kept on this device'), h('span', { class: 'muted' }, 'Once the server has a video you can free the copy here')),
      h('div', { class: 'wr-rows' }, rows.map(({ run, v }) => h('div', { class: 'wr-vid' },
        h('span', { class: 'wr-vid-play' }, ui.icon('play', 22)),
        h('div', { class: 'wr-vid-main' },
          h('a', { href: `#/wireruns/${run.id}`, class: 'wr-name' }, `${run.name || 'Wire run'}: ${v.label || 'video'}`),
          h('div', { class: 'muted wr-sub' }, [V.fmtClock(v.durationMs), V.fmtBytes(v.bytes), V.videoStatus(v, { hasLocal: true }).label].join(' · '))),
        h('div', { class: 'wr-actions' },
          v.status === 'ready'
            ? ui.button(`Free ${V.fmtBytes(v.bytes)}`, { size: 'sm', icon: 'eraser', onClick: async () => { await R.dropLocalCopy(store, run.id, v.id); ui.toast('Space freed', 'success'); drawStorage(); } })
            : h('span', { class: 'muted wr-sub' }, 'Not on the server yet')))))));
  }

  function playRec(r) {
    blobUrl(r.localId).then((url) => {
      if (!url) { ui.toast('That recording is no longer on this device.', 'error'); return; }
      ui.openSheet({
        title: r.label || 'Recording', wide: true,
        body: h('div', { class: 'stack' }, h('video', { class: 'wr-sheet-video', src: url, controls: true, playsInline: true }),
          r.markers.length ? h('p', { class: 'wr-p muted' }, `${r.markers.length} markers. Attach it to a run to step through them beside the measurements.`) : null),
        onClose: () => URL.revokeObjectURL(url),
      });
    });
  }

  function attachTo(r, runId) {
    try {
      const v = R.attachRecording(store, r.id, runId, { actorId: store.actorId });
      U.uploadVideo(store, runId, v.id).catch(() => {});
      ui.toast(attachedNote(store, r.bytes), 'success', 4000);
    } catch (e) { ui.toast(e.message, 'error'); }
  }

  function pickRun(r) {
    const focus = jobFocus(store, auth);
    const jobId = r.jobId || focus;
    let q = '';
    const jobs = jobsById();
    const listEl = h('div', { class: 'list' });
    const all = store.list('wireRuns').sort((a, b) => (Number(b.jobId === jobId && !!jobId) - Number(a.jobId === jobId && !!jobId)) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const draw = () => {
      ui.clear(listEl);
      const rows = W.filterRuns(all, { q, jobs: [...jobs.values()] }).slice(0, 60);
      if (!rows.length) listEl.append(h('div', { class: 'wr-empty muted' }, 'No runs match.'));
      rows.forEach((run) => listEl.append(h('button', { type: 'button', class: 'list-row click wr-dw-row', onClick: () => { sheet.close(); attachTo(r, run.id); } },
        h('span', { class: 'grow' }, h('span', { class: 'title' }, run.name || 'Untitled run'),
          h('span', { class: 'meta' }, [jobs.get(run.jobId) ? jobLabel(jobs.get(run.jobId)) : 'No job', `${(run.videos || []).length} video${(run.videos || []).length === 1 ? '' : 's'}`, ui.fmtDate(run.updatedAt)].join(' · '))),
        ui.icon('chevron-right', 18))));
    };
    const sheet = ui.openSheet({
      title: 'Attach to a run',
      body: h('div', { class: 'stack' },
        ui.searchBox('Search runs', (v) => { q = v; draw(); }, ''),
        listEl,
        ui.button('New run for this video', { icon: 'plus', onClick: () => {
          const n = store.count('wireRuns', (x) => (jobId ? x.jobId === jobId : true)) + 1;
          const rec = store.add('wireRuns', W.newRun({ name: r.label || `Run ${n}`, jobId: jobId || null }));
          sheet.close();
          attachTo(r, rec.id);
          nav('#/wireruns/' + rec.id);
        } })),
    });
    draw();
  }

  async function delRec(r) {
    if (!(await ui.confirmDialog(`Delete "${r.label || 'this recording'}" (${V.fmtBytes(r.bytes)}) from this device? It was never uploaded, so it is gone for good.`, { okLabel: 'Delete' }))) return;
    await R.deleteRecording(store, r.id);
    ui.toast('Recording deleted');
  }

  async function addLoose() {
    const file = await pickVideo();
    if (!file) return;
    try {
      const durationMs = await probeDuration(file);
      await R.saveRecording(store, file, { durationMs, mimeType: file.type, source: 'file', jobId: jobFocus(store, auth) || null, label: (file.name || '').replace(/\.[a-z0-9]+$/i, '').slice(0, 80) || 'Video' });
      ui.toast('Saved on this device. Attach it to a run when you are ready.', 'success', 4000);
    } catch (e) { ui.toast(e?.message || "Couldn't keep that video", 'error', 6000); }
  }

  h(host, null,
    h('p', { class: 'wr-p muted' }, "Recordings stay on this device until they're attached to a run; attached ones upload to the server in the background. Nothing here syncs to other devices by itself."),
    storageHost, listHost, attachedHost);
  root.append(ui.page({
    title: 'Videos on this device',
    subtitle: h('span', null, h('a', { href: '#/wireruns' }, 'Wire runs'), ' / Videos on this device'),
  }, host));
  const redraw = () => { if (!alive) return; drawList(); drawStorage(); };
  redraw();
  const offRecs = R.onRecordingsChange(redraw);
  const offFocus = onJobFocus(() => { showAll = false; drawList(); });
  const offRuns = store.on('wireRuns', () => drawStorage());
  return () => { alive = false; offRecs(); offFocus(); offRuns(); };
}

// ---------- photos ----------
function pickImages() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    const done = (files) => { input.remove(); resolve(files); };
    input.addEventListener('change', () => done([...(input.files || [])]));
    input.addEventListener('cancel', () => done([]));
    document.body.append(input);
    input.click();
  });
}

const approxBytes = (dataUrl) => Math.floor(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);

/** Downscale a picked image to a JPEG data URL under PHOTO_MAX_BYTES. */
async function downscaleImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let side = PHOTO_MAX_SIDE, q = 0.72, out = null, w = 0, hgt = 0;
    for (let i = 0; i < 8; i++) {
      const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      w = Math.max(1, Math.round(img.naturalWidth * k));
      hgt = Math.max(1, Math.round(img.naturalHeight * k));
      const c = document.createElement('canvas');
      c.width = w; c.height = hgt;
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, w, hgt);
      g.drawImage(img, 0, 0, w, hgt);
      out = c.toDataURL('image/jpeg', q);
      if (approxBytes(out) <= PHOTO_MAX_BYTES) break;
      if (q > 0.5) q -= 0.1; else side = Math.round(side * 0.8);
    }
    return { dataUrl: out, width: w, height: hgt };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- print ----------
function printRun(ui, run, { store, units, job }) {
  const { h } = ui;
  const t = W.runTotals(run);
  const co = store.settings().company || {};
  const client = job?.clientId ? store.get('clients', job.clientId) : null;
  const tr = (cells, cls) => h('tr', { class: cls }, cells.map((c, i) => h('td', { class: i ? 'right' : null }, c)));
  const node = h('div', { class: 'wr-print' }, h('article', { class: 'wr-doc' },
    h('header', { class: 'wr-doc-top' },
      h('div', null, h('div', { class: 'wr-doc-brand' }, co.name || 'Company'), h('div', { class: 'wr-doc-small' }, [co.address, co.phone, co.email].filter(Boolean).join(' · '))),
      h('div', { class: 'wr-doc-right' }, h('div', { class: 'wr-doc-kind' }, 'Wire run'), h('div', null, ui.fmtDate(new Date())))),
    h('h1', null, run.name || 'Untitled run'),
    h('p', { class: 'wr-doc-small' }, [jobLabel(job), client?.name, job?.address, run.location, W.methodLabel(run)].filter(Boolean).join(' · ')),
    h('h2', null, 'Segments'),
    h('table', null, h('thead', null, h('tr', null, ['#', 'Segment', 'Source', 'Length', 'Note'].map((x) => h('th', null, x)))),
      h('tbody', null, run.segments.map((s, i) => h('tr', null, h('td', null, i + 1), h('td', null, s.label || '—'), h('td', null, W.SOURCES[s.source]), h('td', { class: 'right' }, W.fmtSeg(s.lengthM, units)), h('td', null, s.note || '')))),
      h('tfoot', null, h('tr', null, h('td'), h('td', null, 'Run length'), h('td'), h('td', { class: 'right' }, W.fmtTotal(t.runM, units)), h('td')))),
    h('h2', null, 'Allowances'),
    h('table', null, h('tbody', null,
      t.drops.map((d) => tr([`Drop: ${d.label || 'drop'} (${d.count} × ${W.fmtSeg(d.lengthM, units)})`, W.fmtTotal(d.totalM, units)])),
      tr([`Box makeup (${t.boxCount} × ${W.fmtSeg(t.boxMakeupM, units)}, ${W.CEC_FREE_CONDUCTOR_REF})`, W.fmtTotal(t.boxesM, units)]),
      tr(['Panel makeup', W.fmtTotal(t.panelM, units)]),
      tr([`Waste ${t.wastePct}%`, W.fmtTotal(t.wasteM, units)]),
      tr(['Total per conductor', W.fmtTotal(t.totalM, units)], 'strong'))),
    h('h2', null, 'Conductors'),
    h('table', null, h('thead', null, h('tr', null, ['Conductor', 'Count', 'Total', 'Rolls'].map((x) => h('th', null, x)))),
      h('tbody', null, t.conductors.map((c) => h('tr', null, h('td', null, c.label), h('td', { class: 'right' }, c.count), h('td', { class: 'right' }, W.fmtTotal(c.lengthM, units)),
        h('td', null, c.rolls ? [W.rollsLabel(c.rolls, units), W.leftoverLabel(c.rolls, units)].filter(Boolean).join(', ') : 'Cut to length'))))),
    run.wiringMethod === 'conduit' ? h('p', null, `Conduit ${W.conduitLabel(run)}: ${W.fmtTotal(t.conduitM, units)} with waste, about ${t.conduitSticks} sticks.`) : null,
    run.notes ? [h('h2', null, 'Notes'), h('p', { class: 'wr-doc-notes' }, run.notes)] : null,
    run.photos.length ? [h('h2', null, 'Photos'), h('div', { class: 'wr-doc-photos' }, run.photos.map((p) => h('figure', null, h('img', { src: p.dataUrl, alt: '' }), p.caption ? h('figcaption', null, p.caption) : null)))] : null));
  document.body.append(node);
  document.body.classList.add('wr-printing');
  const done = () => { node.remove(); document.body.classList.remove('wr-printing'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 800); }, 60);
}

// ---------- trace on a drawing ----------
/**
 * Full-screen sheet over a drawing: tap points along the route, live length from the
 * drawing scale (px per foot). Resolves { path, scale, calibrated } or null.
 * Draws the drawing itself (underlay, strokes, symbols as dots) so the canvas module stays untouched.
 */
function traceSheet(ui, drawing, units) {
  const { h } = ui;
  return new Promise((resolve) => {
    let scale = drawing.scale > 0 ? Number(drawing.scale) : null;
    let calibrated = false;
    let mode = scale ? 'trace' : 'calibrate';
    const pts = [];
    let cal = [];
    let straight = false;
    let hover = null;
    const view = { x: 0, y: 0, zoom: 1 };
    let dpr = 1, cw = 0, ch = 0;

    const canvas = h('canvas', { class: 'wr-trace-canvas', 'aria-label': 'Drawing. Tap to add points.' });
    const totalEl = h('strong', { class: 'num' });
    const scaleEl = h('span', { class: 'muted wr-trace-scale' });
    const hint = h('div', { class: 'wr-trace-hint', role: 'status' });
    const undoBtn = ui.button('Undo', { size: 'sm', icon: 'undo', onClick: () => { if (mode === 'calibrate') cal.pop(); else pts.pop(); update(); } });
    const straightBtn = h('button', { type: 'button', class: 'btn sm wr-straight', 'aria-pressed': 'false', title: 'Snap each leg to horizontal or vertical',
      onClick: () => { straight = !straight; straightBtn.setAttribute('aria-pressed', String(straight)); } }, 'Straight');
    const calBtn = ui.button('Set scale', { size: 'sm', icon: 'ruler', onClick: () => { mode = 'calibrate'; cal = []; update(); } });
    const doneBtn = ui.button('Done', { variant: 'primary', icon: 'check', onClick: () => finish(true) });
    const closeBtn = ui.button('', { variant: 'ghost', icon: 'x', title: 'Cancel', onClick: () => finish(false) });
    const el = h('div', { class: 'wr-trace', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Trace on ${drawing.name || 'drawing'}` },
      h('header', { class: 'wr-trace-head' },
        h('div', { class: 'wr-trace-title' }, h('strong', null, drawing.name || 'Drawing'), scaleEl),
        h('div', { class: 'wr-trace-total' }, totalEl),
        h('div', { class: 'wr-trace-tools' }, undoBtn, straightBtn, calBtn, doneBtn, closeBtn)),
      h('div', { class: 'wr-trace-stage' }, canvas, hint));
    document.body.append(el);

    let img = null;
    if (drawing.underlay) { img = new Image(); img.onload = () => draw(); img.src = drawing.underlay; }
    const toM = (px) => W.pxToM(px, scale);
    const fmt = (m) => W.fmtSeg(m, units);
    const lenPx = () => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; };
    const toWorld = (sx, sy) => [(sx - view.x) / view.zoom, (sy - view.y) / view.zoom];

    function bounds() {
      let b = null;
      const grow = (x0, y0, x1, y1) => { b = b ? [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)] : [x0, y0, x1, y1]; };
      if (drawing.underlay && drawing.underlayW) grow(drawing.underlayX || 0, drawing.underlayY || 0, (drawing.underlayX || 0) + drawing.underlayW, (drawing.underlayY || 0) + drawing.underlayH);
      for (const s of drawing.strokes || []) for (const p of s.points || []) grow(p[0], p[1], p[0], p[1]);
      for (const o of drawing.objects || []) grow(o.x - 15, o.y - 15, o.x + 15, o.y + 15);
      for (const t of drawing.texts || []) grow(t.x, t.y, t.x + 120, t.y + 24);
      return b || [0, 0, 800, 600];
    }
    function fit() {
      const [x0, y0, x1, y1] = bounds();
      const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
      view.zoom = Math.min(cw / bw, ch / bh) * 0.9 || 1;
      view.x = cw / 2 - ((x0 + x1) / 2) * view.zoom;
      view.y = ch / 2 - ((y0 + y1) / 2) * view.zoom;
    }
    function resize() {
      const r = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      cw = r.width; ch = r.height;
      canvas.width = Math.max(1, Math.round(cw * dpr));
      canvas.height = Math.max(1, Math.round(ch * dpr));
      draw();
    }

    function draw() {
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = LIGHT_PAPER;
      g.fillRect(0, 0, cw, ch);
      // one-foot grid when it is big enough to help
      if (scale) {
        let step = scale * view.zoom;
        while (step > 0 && step < 8) step *= 5;
        if (step >= 8) {
          g.strokeStyle = 'rgba(28,27,25,0.08)';
          g.lineWidth = 1;
          g.beginPath();
          for (let x = ((view.x % step) + step) % step; x < cw; x += step) { g.moveTo(Math.round(x) + 0.5, 0); g.lineTo(Math.round(x) + 0.5, ch); }
          for (let y = ((view.y % step) + step) % step; y < ch; y += step) { g.moveTo(0, Math.round(y) + 0.5); g.lineTo(cw, Math.round(y) + 0.5); }
          g.stroke();
        }
      }
      g.save();
      g.translate(view.x, view.y);
      g.scale(view.zoom, view.zoom);
      if (img?.complete && img.naturalWidth) {
        g.globalAlpha = drawing.underlayOpacity ?? 1;
        g.drawImage(img, drawing.underlayX || 0, drawing.underlayY || 0, drawing.underlayW || img.naturalWidth, drawing.underlayH || img.naturalHeight);
        g.globalAlpha = 1;
      }
      const hidden = new Set((drawing.layers || []).filter((l) => l.visible === false).map((l) => l.id));
      g.lineCap = 'round'; g.lineJoin = 'round';
      for (const s of drawing.strokes || []) {
        if (hidden.has(s.layer) || !s.points?.length) continue;
        const p = s.points;
        g.strokeStyle = s.color || '#1c1b19';
        g.globalAlpha = (s.opacity ?? 1) * (s.tool === 'highlighter' ? 0.38 : 1);
        g.lineWidth = s.size || 2;
        g.beginPath();
        if (s.tool === 'rect') { const [a, c] = [p[0], p[p.length - 1]]; g.rect(a[0], a[1], c[0] - a[0], c[1] - a[1]); }
        else if (s.tool === 'line' || s.tool === 'measure') { g.moveTo(p[0][0], p[0][1]); g.lineTo(p[p.length - 1][0], p[p.length - 1][1]); }
        else { g.moveTo(p[0][0], p[0][1]); for (const q of p) g.lineTo(q[0], q[1]); }
        g.stroke();
      }
      g.globalAlpha = 1;
      g.lineWidth = 1.5;
      for (const o of drawing.objects || []) {
        if (hidden.has(o.layer)) continue;
        g.strokeStyle = o.color || '#1c1b19';
        g.beginPath(); g.arc(o.x, o.y, 9 * (o.scale || 1), 0, Math.PI * 2); g.stroke();
      }
      g.fillStyle = '#1c1b19';
      for (const t of drawing.texts || []) {
        if (hidden.has(t.layer)) continue;
        g.font = `${t.size || 18}px Inter, system-ui, sans-serif`;
        g.textBaseline = 'top';
        String(t.text || '').split('\n').forEach((line, i) => g.fillText(line, t.x, t.y + i * (t.size || 18) * 1.25));
      }
      g.restore();

      // the route, in screen space so it stays crisp
      const sp = (w) => [w[0] * view.zoom + view.x, w[1] * view.zoom + view.y];
      const path = (list, color, width) => {
        if (list.length < 2) return;
        g.strokeStyle = color; g.lineWidth = width;
        g.beginPath();
        list.forEach((w, i) => { const [x, y] = sp(w); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
        g.stroke();
      };
      const route = mode === 'calibrate' ? cal : pts;
      const lineColor = mode === 'calibrate' ? '#1f5fb8' : '#f5b301';
      path(route, 'rgba(28,27,25,0.55)', 7);
      path(route, lineColor, 4);
      if (hover && route.length && (mode === 'trace' || cal.length === 1)) {
        g.setLineDash([6, 6]);
        path([route[route.length - 1], snap(hover)], lineColor, 2);
        g.setLineDash([]);
      }
      for (const w of route) {
        const [x, y] = sp(w);
        g.fillStyle = '#ffffff'; g.strokeStyle = '#1c1b19'; g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, 5.5, 0, Math.PI * 2); g.fill(); g.stroke();
      }
      if (mode === 'trace' && scale) {
        g.font = '600 12px Inter, system-ui, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        for (let i = 1; i < pts.length; i++) {
          const [ax, ay] = sp(pts[i - 1]), [bx, by] = sp(pts[i]);
          if (Math.hypot(bx - ax, by - ay) < 40) continue;
          const label = fmt(toM(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])));
          const tw = g.measureText(label).width + 12;
          const mx = (ax + bx) / 2, my = (ay + by) / 2;
          g.fillStyle = '#1c1b19';
          g.beginPath(); g.roundRect ? g.roundRect(mx - tw / 2, my - 10, tw, 20, 10) : g.rect(mx - tw / 2, my - 10, tw, 20); g.fill();
          g.fillStyle = '#f5b301';
          g.fillText(label, mx, my + 0.5);
        }
      }
    }

    function snap(w) {
      if (!straight || mode !== 'trace' || !pts.length) return w;
      const last = pts[pts.length - 1];
      return Math.abs(w[0] - last[0]) >= Math.abs(w[1] - last[1]) ? [w[0], last[1]] : [last[0], w[1]];
    }

    function update() {
      if (mode === 'calibrate') {
        totalEl.textContent = 'Set the scale';
        hint.textContent = cal.length ? 'Tap the other end of the known length.' : 'Tap both ends of something you know the length of (a dimension line, a door, a wall).';
      } else {
        totalEl.textContent = pts.length > 1 ? fmt(toM(lenPx())) : '—';
        hint.textContent = pts.length ? 'Tap the next point. Drag to pan, pinch or scroll to zoom.' : 'Tap the start of the run, then each bend and the end. Drag to pan, pinch or scroll to zoom.';
      }
      scaleEl.textContent = scale ? (calibrated ? `Scale set here: ${Math.round(scale * 10) / 10} px = 1 ft` : `Drawing scale: ${scale} px = 1 ft`) : 'No scale on this drawing';
      undoBtn.disabled = mode === 'calibrate' ? !cal.length : !pts.length;
      doneBtn.disabled = mode !== 'trace' || pts.length < 2 || !scale;
      draw();
    }

    async function tapAt(sx, sy) {
      const w = toWorld(sx, sy);
      if (mode === 'calibrate') {
        cal.push(w);
        update();
        if (cal.length < 2) return;
        const px = Math.hypot(cal[1][0] - cal[0][0], cal[1][1] - cal[0][1]);
        const typed = await ui.promptDialog(units === 'imperial' ? 'Real length between the two points (e.g. 12\' 6")' : 'Real length between the two points (e.g. 3.8 m)', { title: 'Set the scale', okLabel: 'Set scale' });
        const m = typed == null ? null : parseLength(typed, { units, bare: units === 'imperial' ? 'ft' : 'm' });
        if (m > 0 && px > 2) { scale = px / (m / M_PER_FT); calibrated = true; mode = 'trace'; }
        else if (typed != null) ui.toast('Could not read that length', 'error');
        cal = [];
        if (!scale) mode = 'calibrate';
        update();
        return;
      }
      pts.push(snap(w));
      update();
    }

    // pointer input: tap adds a point, one finger drags, two fingers pinch, wheel zooms
    const pointers = new Map();
    let gesture = null;
    const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const pinch = () => {
      const [a, b] = [...pointers.values()];
      return { d: Math.hypot(b.x - a.x, b.y - a.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture?.(e.pointerId);
      const [x, y] = local(e);
      pointers.set(e.pointerId, { x, y });
      if (pointers.size === 1) gesture = { kind: 'tap', sx: x, sy: y, t: performance.now() };
      else if (pointers.size === 2) gesture = { kind: 'pinch', ...pinch(), zoom: view.zoom, vx: view.x, vy: view.y };
    });
    canvas.addEventListener('pointermove', (e) => {
      const [x, y] = local(e);
      if (!pointers.has(e.pointerId)) {
        if (e.pointerType === 'mouse') { hover = toWorld(x, y); draw(); }
        return;
      }
      const prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, { x, y });
      if (!gesture) return;
      if (gesture.kind === 'pinch' && pointers.size === 2) {
        const p = pinch();
        const z = Math.min(40, Math.max(0.02, gesture.zoom * (p.d / Math.max(1, gesture.d))));
        // keep the world point under the first midpoint under the current midpoint
        const wx = (gesture.mx - gesture.vx) / gesture.zoom, wy = (gesture.my - gesture.vy) / gesture.zoom;
        view.zoom = z; view.x = p.mx - wx * z; view.y = p.my - wy * z;
        draw();
      } else if (pointers.size === 1) {
        if (gesture.kind === 'tap' && Math.hypot(x - gesture.sx, y - gesture.sy) > 6) gesture.kind = 'pan';
        if (gesture.kind === 'pan') { view.x += x - prev.x; view.y += y - prev.y; draw(); }
      }
    });
    const up = (e) => {
      if (!pointers.has(e.pointerId)) return;
      const [x, y] = local(e);
      const g = gesture;
      pointers.delete(e.pointerId);
      if (g?.kind === 'tap' && e.type === 'pointerup' && performance.now() - g.t < 700) tapAt(x, y);
      gesture = pointers.size ? { kind: 'pan' } : null; // a finger left after a pinch only pans
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { hover = null; draw(); } });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = local(e);
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      const z = Math.min(40, Math.max(0.02, view.zoom * k));
      view.x = x - ((x - view.x) / view.zoom) * z;
      view.y = y - ((y - view.y) / view.zoom) * z;
      view.zoom = z;
      draw();
    }, { passive: false });
    const onKey = (e) => {
      if (document.querySelector('.scrim')) return; // a dialog on top handles its own keys
      if (e.key === 'Escape') finish(false);
      else if ((e.key === 'z' && (e.ctrlKey || e.metaKey)) || e.key === 'Backspace') { e.preventDefault(); undoBtn.click(); }
      else if (e.key === 'Enter' && !doneBtn.disabled) finish(true);
    };
    document.addEventListener('keydown', onKey);
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);

    let closed = false;
    function finish(ok) {
      if (closed) return;
      closed = true;
      ro.disconnect();
      document.removeEventListener('keydown', onKey);
      el.remove();
      if (!ok || pts.length < 2 || !scale) return resolve(null);
      const points = pts.map(([x, y]) => ({ x: toM(x), y: toM(y), z: 0 }));
      const legs = W.legLengths(points);
      resolve({ path: { totalM: legs.reduce((a, b) => a + b, 0), segments: legs.map((lengthM) => ({ lengthM })), points }, scale, calibrated });
    }

    requestAnimationFrame(() => { resize(); fit(); update(); doneBtn.focus?.(); });
  });
}

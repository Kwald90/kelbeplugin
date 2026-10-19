// Plans & drawings: the gallery (S01) and the canvas editor (S02–S10).
// A drawing may hold rooms[] (walls, doors, counters) for auto-place and the
// code check; older drawings without it open fine (normalizeDrawing adds it).
// A multi-page PDF imports as a plan set: one drawing per sheet, each with
// planSet { id, name, page, label, pageCount } (js/lib/plansets.js). The gallery
// shows a set as one card that opens up to its sheets; single drawings are unchanged.
import { openEditor } from '../canvas/editor.js';
import { uid } from '../store.js';
import {
  DEFAULT_LAYERS, groupDrawings, makePlanSet, sheetRecord, sheetLabel, hasOwnScale, renameSheet,
} from '../lib/plansets.js';
import { isPdf, openPdf, pickPages, importPages, chooseDialog } from '../canvas/plansets-ui.js';

const PAPER_LABEL = { none: 'Blank', dots: 'Dots', grid: 'Grid', iso: 'Isometric' };
/** What the gallery doesn't need from a drawing: copying every sheet's underlay would cost megabytes per card. */
const GALLERY_OMIT = ['underlay', 'strokes', 'texts', 'codeOptions', 'placement', 'view'];
const UPLOAD_SET_ICON = '<path d="M12 15V4M8 8l4-4 4 4"/><path d="M4 14v4a2 2 0 002 2h12a2 2 0 002-2v-4"/><path d="M7 20h10" opacity=".5"/>';

function createDrawing(store, jobId) {
  const job = jobId && store.get('jobs', jobId);
  const n = store.count('drawings', (d) => (jobId ? d.jobId === jobId : true)) + 1;
  return store.add('drawings', {
    name: job ? `${job.title} — plan ${n}` : `Untitled plan ${n}`,
    jobId: job ? job.id : null, paper: 'grid', scale: 24,
    layers: DEFAULT_LAYERS.map((l) => ({ ...l })),
    strokes: [], objects: [], texts: [], rooms: [], underlay: null, view: null, thumb: null,
  });
}

function gallery(root, { store, ui, nav, query }) {
  const { h, icon } = ui;
  let q = '';
  let jobFilter = query.jobId || '';
  const jobs = store.list('jobs');
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const grid = h('div');
  const expanded = new Set(query.set ? [query.set] : []);
  let all = [];
  const reload = () => { all = store.list('drawings', null, { omit: GALLERY_OMIT }); };

  const jobSelect = h('select', { class: 'input', 'aria-label': 'Filter by job', style: { width: 'auto', minWidth: '180px', borderRadius: '999px' },
    onChange: (e) => { jobFilter = e.target.value; history.replaceState(null, '', '#/drawings' + (jobFilter ? '?jobId=' + jobFilter : '')); draw(); } },
  h('option', { value: '' }, 'All jobs'), h('option', { value: '__none', selected: jobFilter === '__none' }, 'Not linked to a job'),
  jobs.map((j) => h('option', { value: j.id, selected: j.id === jobFilter }, `${j.number} · ${j.title}`)));

  const newDrawing = () => nav('#/drawings/new' + (jobFilter && jobFilter !== '__none' ? '?jobId=' + jobFilter : ''));
  const thumbOf = (d, emptyIcon = 'pen') => (d.thumb ? h('img', { src: d.thumb, alt: '', loading: 'lazy' }) : h('span', { class: 'dw-thumb-empty' }, icon(emptyIcon, 28)));
  const countSymbols = (list) => list.reduce((a, d) => a + (d.objects || []).length, 0);

  function card(d) {
    const job = d.jobId && jobById.get(d.jobId);
    const symbols = (d.objects || []).length;
    const rooms = (d.rooms || []).length;
    return h('a', { class: 'card click dw-card', href: '#/drawings/' + d.id, 'aria-label': `Open ${d.name}` },
      h('div', { class: ['dw-thumb', `paper-${d.paper || 'grid'}`] },
        thumbOf(d),
        Number(d.underlayW) > 0 ? h('span', { class: 'dw-flag' }, icon('image', 14), 'Plan') : null),
      h('div', { class: 'dw-meta' },
        h('div', { class: 'dw-name' }, d.name || 'Untitled'),
        h('div', { class: 'meta muted' }, [job ? `${job.number} · ` : '', `Edited ${ui.fmtDate(d.updatedAt)}`].join('')),
        h('div', { class: 'row', style: { marginTop: '6px', gap: '6px' } },
          ui.badge(PAPER_LABEL[d.paper] || 'Grid'),
          symbols ? ui.badge(`${symbols} symbol${symbols === 1 ? '' : 's'}`, 'accent') : null,
          rooms ? ui.badge(`${rooms} room${rooms === 1 ? '' : 's'}`) : null,
          (d.layers || []).length > 1 ? ui.badge(`${d.layers.length} layers`) : null)));
  }

  function sheetCard(d) {
    const symbols = (d.objects || []).length;
    return h('a', { class: 'card click dw-card dw-sheet', href: '#/drawings/' + d.id, 'aria-label': `Open ${d.name}` },
      h('div', { class: ['dw-thumb', `paper-${d.paper || 'grid'}`] }, thumbOf(d, 'image')),
      h('div', { class: 'dw-meta' },
        h('div', { class: 'dw-name' }, sheetLabel(d.planSet)),
        h('div', { class: 'meta muted' }, [d.planSet?.label ? `p.${d.planSet.page}` : null, hasOwnScale(d) ? 'Scale set' : 'No scale yet', symbols ? `${symbols} symbol${symbols === 1 ? '' : 's'}` : null].filter(Boolean).join(' · '))));
  }

  /** A plan set: one card (first sheet's thumbnail, sheet count) that opens up to its sheets. */
  function setCard(g) {
    const first = g.sheets[0];
    const job = first.jobId && jobById.get(first.jobId);
    const open = expanded.has(g.id);
    const symbols = countSymbols(g.sheets);
    const scaled = g.sheets.filter(hasOwnScale).length;
    const toggle = ui.button(open ? 'Hide sheets' : `Show ${g.sheets.length} sheets`, { variant: 'ghost', icon: open ? 'chevron-down' : 'chevron-right', onClick: () => { if (open) expanded.delete(g.id); else expanded.add(g.id); draw(); } });
    toggle.setAttribute('aria-expanded', String(open));
    const out = [h('div', { class: ['card', 'dw-card', 'dw-set', open ? 'open' : null], dataset: { set: g.id } },
      h('a', { class: 'dw-set-open', href: '#/drawings/' + first.id, 'aria-label': `Open ${g.name} at ${sheetLabel(first.planSet)}` },
        h('div', { class: ['dw-thumb', 'dw-thumb-set', `paper-${first.paper || 'grid'}`] },
          thumbOf(first, 'image'),
          h('span', { class: 'dw-flag' }, icon('layers', 14), `Plan set · ${g.sheets.length} sheets`)),
        h('div', { class: 'dw-meta' },
          h('div', { class: 'dw-name' }, g.name),
          h('div', { class: 'meta muted' }, [job ? `${job.number} · ` : '', `Edited ${ui.fmtDate(g.updatedAt)}`].join('')),
          h('div', { class: 'row', style: { marginTop: '6px', gap: '6px' } },
            ui.badge(`${sheetLabel(first.planSet)} – ${sheetLabel(g.sheets[g.sheets.length - 1].planSet)}`),
            symbols ? ui.badge(`${symbols} symbol${symbols === 1 ? '' : 's'}`, 'accent') : null,
            ui.badge(scaled === g.sheets.length ? 'All scaled' : `${scaled}/${g.sheets.length} scaled`, scaled === g.sheets.length ? 'success' : 'neutral')))),
      h('div', { class: 'dw-set-actions' },
        toggle,
        h('span', { class: 'grow' }),
        ui.button('', { variant: 'ghost', icon: 'more', title: `Options for ${g.name}`, onClick: () => setMenu(g) })))];
    if (open) out.push(h('div', { class: 'dw-set-sheets', role: 'group', 'aria-label': `Sheets in ${g.name}` }, g.sheets.map(sheetCard)));
    return out;
  }

  function setMenu(g) {
    const row = (ic, title, meta, fn, danger) => h('button', { class: ['list-row', 'click', 'dw-menu-row', danger ? 'danger' : null], type: 'button', onClick: () => { s.close(); fn(); } },
      icon(ic, 20), h('span', { class: 'grow' }, h('span', { class: 'title' }, title), meta ? h('span', { class: 'meta' }, meta) : null));
    const s = ui.openSheet({
      title: g.name,
      body: h('div', { class: 'list' },
        row('pen', 'Open the first sheet', sheetLabel(g.sheets[0].planSet), () => nav('#/drawings/' + g.sheets[0].id)),
        row('edit', 'Rename set', 'Sheet names follow', () => renameSet(g)),
        row('trash', 'Delete…', 'Every sheet, or just one', () => deleteSet(g), true)),
    });
  }

  async function renameSet(g) {
    const name = (await ui.promptDialog('Plan set name', { title: 'Rename plan set', value: g.name, okLabel: 'Rename' }))?.trim();
    if (!name || name === g.name) return;
    for (const d of g.sheets) {
      store.update('drawings', d.id, { name: renameSheet(d.name, g.name, name), planSet: { ...d.planSet, name } }, { summary: `Plan set renamed to ${name}`.slice(0, 80) });
    }
    ui.toast('Plan set renamed', 'success');
    reload(); draw();
  }

  async function deleteSet(g) {
    const pick = await chooseDialog(ui, {
      title: `Delete from ${g.name}`,
      message: `${g.name} has ${g.sheets.length} sheets. Delete every sheet, or pick one? This can't be undone.`,
      choices: [{ id: 'one', label: 'Pick one sheet' }, { id: 'all', label: `Delete all ${g.sheets.length} sheets`, variant: 'danger solid' }],
    });
    if (pick === 'all') {
      for (const d of g.sheets) store.remove('drawings', d.id);
      ui.toast(`Deleted ${g.sheets.length} sheets`);
    } else if (pick === 'one') {
      const sheetId = await new Promise((resolve) => {
        let chosen = null;
        const s = ui.openSheet({
          title: 'Delete which sheet?',
          body: h('div', { class: 'list' }, g.sheets.map((d) => h('button', { class: ['list-row', 'click', 'dw-menu-row'], type: 'button', onClick: () => { chosen = d.id; s.close(); } },
            h('span', { class: 'cv-sheet-thumb' }, d.thumb ? h('img', { src: d.thumb, alt: '', loading: 'lazy' }) : icon('image', 20)),
            h('span', { class: 'grow' }, h('span', { class: 'title' }, sheetLabel(d.planSet)), h('span', { class: 'meta' }, d.name))))),
          onClose: () => resolve(chosen),
        });
      });
      const d = sheetId && g.sheets.find((x) => x.id === sheetId);
      if (!d || !(await ui.confirmDialog(`Delete "${d.name}"? The other ${g.sheets.length - 1} sheets stay. This can't be undone.`, { okLabel: 'Delete sheet' }))) return;
      store.remove('drawings', d.id);
      ui.toast('Sheet deleted');
    } else return;
    reload(); draw();
  }

  /** Import a PDF as a plan set: one drawing per selected page, for the job picked here. */
  async function importPlanSet(given) {
    const file = given instanceof Blob ? given : await ui.pickFile('application/pdf,.pdf');
    if (!file) return;
    if (!isPdf(file)) { ui.toast('Pick a PDF of the plans', 'error'); return; }
    let doc = null;
    try {
      ui.toast('Reading PDF…', 'info', 1400);
      doc = await openPdf(file);
      const preset = jobFilter && jobFilter !== '__none' ? jobFilter : '';
      const jobPick = h('select', { name: 'jobId', 'aria-label': 'Job for these sheets' },
        ui.recordOptions(jobs, (j) => `${j.number} · ${j.title}`, 'Not linked to a job').map((o) => h('option', { value: o.value, selected: o.value === preset }, o.label)));
      const pages = doc.numPages > 1
        ? await pickPages(ui, doc, { title: `Import plan set · ${doc.name}`, extra: h('label', { class: 'field pp-job' }, h('span', null, 'Job'), jobPick) })
        : [1];
      if (!pages?.length) return;
      const setId = uid();
      const base = { jobId: jobPick.value || null, paper: 'grid' };
      let firstId = null;
      const res = await importPages(ui, doc, pages, async (r) => {
        const ps = makePlanSet({ id: setId, name: doc.name, page: r.page, label: r.label, pageCount: doc.numPages, pxPerPt: r.pxPerPt });
        const rec = sheetRecord(base, ps, r);
        if (doc.numPages === 1) rec.name = doc.name;
        const added = store.add('drawings', rec);
        firstId ||= added.id;
      });
      if (!res.done.length) return;
      if (base.jobId && jobFilter !== base.jobId) { jobFilter = base.jobId; jobSelect.value = base.jobId; history.replaceState(null, '', '#/drawings?jobId=' + base.jobId); }
      expanded.add(setId);
      reload(); draw();
      if (res.done.length === 1) { nav('#/drawings/' + firstId); return; }
      if (!res.failed.length && !res.cancelled) ui.toast(`Imported ${res.done.length} sheets from ${doc.name}`, 'success', 4000);
      grid.querySelector(`[data-set="${CSS.escape(setId)}"]`)?.scrollIntoView({ block: 'nearest' });
    } catch (err) {
      ui.toast(err?.message || 'Could not import that PDF', 'error', 4000);
    } finally {
      doc?.close();
    }
  }

  function draw() {
    ui.clear(grid);
    const needle = q.trim().toLowerCase();
    let rows = all;
    if (jobFilter === '__none') rows = rows.filter((d) => !d.jobId);
    else if (jobFilter) rows = rows.filter((d) => d.jobId === jobFilter);
    if (needle) rows = rows.filter((d) => `${d.name} ${d.planSet?.name || ''} ${jobById.get(d.jobId)?.title || ''} ${jobById.get(d.jobId)?.number || ''}`.toLowerCase().includes(needle));
    rows = [...rows].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    const newTile = h('button', { class: 'card dw-card dw-new', type: 'button', onClick: newDrawing },
      h('span', { class: 'dw-new-ico' }, icon('plus', 28)), h('strong', null, 'New drawing'),
      h('span', { class: 'muted' }, jobFilter && jobFilter !== '__none' ? `For ${jobById.get(jobFilter)?.number || 'this job'}` : 'Blank paper, grid or isometric'));
    const importTile = h('button', { class: 'card dw-card dw-new', type: 'button', onClick: () => importPlanSet() },
      h('span', { class: 'dw-new-ico' }, icon(UPLOAD_SET_ICON, 28)), h('strong', null, 'Import plan set'),
      h('span', { class: 'muted' }, 'A PDF of the plans: one drawing per sheet'));

    if (!rows.length && (needle || jobFilter)) {
      grid.append(h('div', { class: 'dw-grid' }, newTile, importTile), ui.empty({ icon: 'search', title: 'No drawings match', text: 'Try another search or job.' }));
      return;
    }
    if (!rows.length) {
      grid.append(ui.empty({ icon: 'pen', title: 'No drawings yet', text: 'Sketch a layout, or import the plans (a PDF set becomes one drawing per sheet) and mark them up with receptacles, switches, lights and wiring.',
        action: h('div', { class: 'row dw-empty-actions' },
          ui.button('Import plan set (PDF)', { icon: 'upload', onClick: () => importPlanSet() }),
          ui.button('New drawing', { variant: 'primary', icon: 'plus', onClick: newDrawing })) }));
      return;
    }
    // group by job, like projects in a sketchbook gallery; within a job, a plan set is one card
    const groups = new Map();
    for (const d of rows) {
      const k = d.jobId && jobById.has(d.jobId) ? d.jobId : '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(d);
    }
    let first = true;
    for (const [k, list] of groups) {
      const job = jobById.get(k);
      const entries = groupDrawings(list);
      grid.append(h('div', { class: 'dw-group' },
        h('h2', { class: 'section dw-group-head' },
          job ? h('a', { href: '#/jobs/' + job.id }, `${job.number} · ${job.title}`) : 'Not linked to a job',
          h('span', { class: 'muted' }, ` ${list.length}`)),
        h('div', { class: 'dw-grid' }, first ? [newTile, importTile] : null, entries.map((e) => (e.kind === 'set' ? setCard(e) : card(e.drawing))))));
      first = false;
    }
  }

  root.append(ui.page({
    title: 'Plans & drawings',
    subtitle: 'Sketch, import plans, draw rooms, auto-place boxes, check them against the CEC, then count symbols into a quote.',
    actions: [
      ui.button('Import plan set (PDF)', { icon: 'upload', onClick: () => importPlanSet() }),
      ui.button('New drawing', { variant: 'primary', icon: 'plus', onClick: newDrawing }),
    ],
  },
  h('div', { class: 'row', style: { marginBottom: '16px' } }, ui.searchBox('Search drawings', (v) => { q = v; draw(); }), jobSelect),
  grid));
  reload();
  draw();
  // exposed for tests
  globalThis.kelbeDrawings = { importFile: (file) => importPlanSet(file) };
  // another device's sync can add or change sheets while the gallery is open
  const off = store.on('drawings', (e) => { if (e.remote) { reload(); draw(); } });
  return () => { off(); if (globalThis.kelbeDrawings) delete globalThis.kelbeDrawings; };
}

export default {
  id: 'drawings',
  title: 'Plans & drawings',
  icon: 'pen',
  group: 'work',
  perm: 'drawings',
  render(root, ctx) {
    const [sub] = ctx.params;
    if (!sub) return gallery(root, ctx);
    if (sub === 'new') {
      const d = createDrawing(ctx.store, ctx.query.jobId);
      location.replace('#/drawings/' + d.id);
      return;
    }
    return openEditor(root, ctx, sub);
  },
};

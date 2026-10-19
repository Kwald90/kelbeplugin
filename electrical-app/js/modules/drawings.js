// Plans & drawings: the gallery (S01) and the canvas editor (S02–S10).
// A drawing may hold rooms[] (walls, doors, counters) for auto-place and the
// code check; older drawings without it open fine (normalizeDrawing adds it).
import { openEditor } from '../canvas/editor.js';

const PAPER_LABEL = { none: 'Blank', dots: 'Dots', grid: 'Grid', iso: 'Isometric' };

function createDrawing(store, jobId) {
  const job = jobId && store.get('jobs', jobId);
  const n = store.count('drawings', (d) => (jobId ? d.jobId === jobId : true)) + 1;
  return store.add('drawings', {
    name: job ? `${job.title} — plan ${n}` : `Untitled plan ${n}`,
    jobId: job ? job.id : null, paper: 'grid', scale: 24,
    layers: [{ id: 'L1', name: 'Plan', visible: true, locked: false, opacity: 1 }, { id: 'L2', name: 'Power', visible: true, locked: false, opacity: 1 }],
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

  const jobSelect = h('select', { class: 'input', 'aria-label': 'Filter by job', style: { width: 'auto', minWidth: '180px', borderRadius: '999px' },
    onChange: (e) => { jobFilter = e.target.value; history.replaceState(null, '', '#/drawings' + (jobFilter ? '?jobId=' + jobFilter : '')); draw(); } },
  h('option', { value: '' }, 'All jobs'), h('option', { value: '__none', selected: jobFilter === '__none' }, 'Not linked to a job'),
  jobs.map((j) => h('option', { value: j.id, selected: j.id === jobFilter }, `${j.number} · ${j.title}`)));

  const newDrawing = () => nav('#/drawings/new' + (jobFilter && jobFilter !== '__none' ? '?jobId=' + jobFilter : ''));

  function card(d) {
    const job = d.jobId && jobById.get(d.jobId);
    const symbols = (d.objects || []).length;
    const rooms = (d.rooms || []).length;
    return h('a', { class: 'card click dw-card', href: '#/drawings/' + d.id, 'aria-label': `Open ${d.name}` },
      h('div', { class: ['dw-thumb', `paper-${d.paper || 'grid'}`] },
        d.thumb ? h('img', { src: d.thumb, alt: '', loading: 'lazy' }) : h('span', { class: 'dw-thumb-empty' }, icon('pen', 28)),
        d.underlay ? h('span', { class: 'dw-flag' }, icon('image', 14), 'Plan') : null),
      h('div', { class: 'dw-meta' },
        h('div', { class: 'dw-name' }, d.name || 'Untitled'),
        h('div', { class: 'meta muted' }, [job ? `${job.number} · ` : '', `Edited ${ui.fmtDate(d.updatedAt)}`].join('')),
        h('div', { class: 'row', style: { marginTop: '6px', gap: '6px' } },
          ui.badge(PAPER_LABEL[d.paper] || 'Grid'),
          symbols ? ui.badge(`${symbols} symbol${symbols === 1 ? '' : 's'}`, 'accent') : null,
          rooms ? ui.badge(`${rooms} room${rooms === 1 ? '' : 's'}`) : null,
          (d.layers || []).length > 1 ? ui.badge(`${d.layers.length} layers`) : null)));
  }

  function draw() {
    ui.clear(grid);
    const needle = q.trim().toLowerCase();
    let rows = store.list('drawings');
    if (jobFilter === '__none') rows = rows.filter((d) => !d.jobId);
    else if (jobFilter) rows = rows.filter((d) => d.jobId === jobFilter);
    if (needle) rows = rows.filter((d) => `${d.name} ${jobById.get(d.jobId)?.title || ''} ${jobById.get(d.jobId)?.number || ''}`.toLowerCase().includes(needle));
    rows.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

    const newTile = h('button', { class: 'card dw-card dw-new', type: 'button', onClick: newDrawing },
      h('span', { class: 'dw-new-ico' }, icon('plus', 28)), h('strong', null, 'New drawing'),
      h('span', { class: 'muted' }, jobFilter && jobFilter !== '__none' ? `For ${jobById.get(jobFilter)?.number || 'this job'}` : 'Blank paper, grid or isometric'));

    if (!rows.length && (needle || jobFilter)) {
      grid.append(h('div', { class: 'dw-grid' }, newTile), ui.empty({ icon: 'search', title: 'No drawings match', text: 'Try another search or job.' }));
      return;
    }
    if (!rows.length) {
      grid.append(ui.empty({ icon: 'pen', title: 'No drawings yet', text: 'Sketch a layout, or import a floor plan and mark it up with receptacles, switches, lights and wiring.',
        action: ui.button('New drawing', { variant: 'primary', icon: 'plus', onClick: newDrawing }) }));
      return;
    }
    // group by job, like projects in a sketchbook gallery
    const groups = new Map();
    for (const d of rows) {
      const k = d.jobId && jobById.has(d.jobId) ? d.jobId : '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(d);
    }
    let first = true;
    for (const [k, list] of groups) {
      const job = jobById.get(k);
      grid.append(h('div', { class: 'dw-group' },
        h('h2', { class: 'section dw-group-head' },
          job ? h('a', { href: '#/jobs/' + job.id }, `${job.number} · ${job.title}`) : 'Not linked to a job',
          h('span', { class: 'muted' }, ` ${list.length}`)),
        h('div', { class: 'dw-grid' }, first ? newTile : null, list.map(card))));
      first = false;
    }
  }

  root.append(ui.page({
    title: 'Plans & drawings',
    subtitle: 'Sketch, import plans, draw rooms, auto-place boxes, check them against the CEC, then count symbols into a quote.',
    actions: [ui.button('New drawing', { variant: 'primary', icon: 'plus', onClick: newDrawing })],
  },
  h('div', { class: 'row', style: { marginBottom: '16px' } }, ui.searchBox('Search drawings', (v) => { q = v; draw(); }), jobSelect),
  grid));
  draw();
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

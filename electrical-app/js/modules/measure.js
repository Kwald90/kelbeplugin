// AR tape measure (#/measure): measure a real-world LENGTH or an AREA/perimeter with the camera and
// SAVE it with a label and an optional job. Reuses the AR session from lib/ar-measure.js (native
// ARKit/LiDAR in the iOS app, WebXR on ARCore Android): it returns the tapped points, so a length is
// the two-point distance and an area is the closed polygon through the corners (Newell's method),
// shown in both m² and ft². On a device without AR you can still type a length in. Saved measurements
// live in the `measurements` collection (synced).
import { getArSupport, measurePath, isCancelled, polygonArea, closedPerimeter } from '../lib/ar-measure.js';
import { fmtLength, getUnits, parseLength } from '../lib/units.js';
import { newMeasurement, sortMeasurements, measurementTitle, validLength, fmtArea, validArea } from '../lib/measurements.js';

const ICON_AR = '<rect x="6.5" y="2.5" width="11" height="19" rx="2"/><path d="M12 8.5v7M8.5 12h7"/><circle cx="12" cy="12" r="1"/>';
const ICON_AREA = '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/>';

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/measure.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/measure.css';
  document.head.append(link);
}

let arSupport = null;
function primeAr() { getArSupport().then((s) => { arSupport = s; }).catch(() => { arSupport = { mode: 'none' }; }); }

const jobLabel = (j) => (j ? `${j.number ? `${j.number} · ` : ''}${j.title || 'Job'}` : '');

// How a saved measurement reads in the list / sheet, in the current units.
function valueText(m, units) {
  if (m.kind === 'area') { const a = fmtArea(m.areaM2, { units }); return `${a.primary} (${a.other})`; }
  return fmtLength(m.lengthM, { units });
}

export default {
  id: 'measure',
  title: 'AR tape',
  icon: 'ruler',
  group: 'field',
  perm: 'jobs',
  render(root, ctx) {
    loadCss();
    primeAr();
    const { store, ui } = ctx;
    const { h } = ui;
    const host = h('div', { class: 'stack' });

    const draw = () => {
      ui.clear(host);
      const units = getUnits();
      const all = sortMeasurements(store.list('measurements'));
      const jobById = new Map(store.list('jobs').map((j) => [j.id, j]));

      host.append(h('section', { class: 'card measure-capture' },
        h('p', { class: 'muted', style: { marginTop: 0 } }, 'Measure a length (tap two ends) or an area (tap each corner, then Done). Save it with a label — and a job — to keep it. AR is an estimate; check critical cuts with a tape.'),
        h('div', { class: 'row' },
          ui.button('Measure length', { variant: 'primary', icon: ICON_AR, onClick: () => startMeasure('length') }),
          ui.button('Measure area', { icon: ICON_AREA, onClick: () => startMeasure('area') }),
          ui.button('Type a length', { icon: 'plus', onClick: () => saveSheet({ kind: 'length', lengthM: null, method: 'manual' }) }))));

      host.append(ui.table({
        columns: [
          { key: 'label', label: 'Measurement', render: (m) => measurementTitle(m), sort: (m) => measurementTitle(m).toLowerCase() },
          { key: 'kind', label: '', render: (m) => (m.kind === 'area' ? ui.badge('area') : ui.badge('length', 'neutral')) },
          { key: 'val', label: 'Value', align: 'right', render: (m) => valueText(m, units), sort: (m) => (m.kind === 'area' ? Number(m.areaM2) : Number(m.lengthM)) || 0 },
          { key: 'job', label: 'Job', render: (m) => (m.jobId ? jobLabel(jobById.get(m.jobId)) : '—') },
          { key: 'when', label: 'Taken', render: (m) => ui.fmtDate(m.takenAt || m.createdAt), sort: (m) => m.takenAt || m.createdAt || '' },
          { key: 'how', label: '', align: 'right', render: (m) => (m.method === 'manual' ? ui.badge('typed') : ui.badge('AR', 'info')) },
        ],
        rows: all,
        onRowClick: (m) => saveSheet({ id: m.id }),
        empty: ui.empty({
          icon: 'ruler',
          title: 'No saved measurements yet',
          text: 'Measure a length or an area with the camera (or type a length in) and save it here — label it, tie it to a job, and read it back any time.',
          action: ui.button('Measure length', { variant: 'primary', icon: ICON_AR, onClick: () => startMeasure('length') }),
        }),
      }));
    };

    // Run the AR session, then open the save sheet prefilled with what was measured.
    const startMeasure = (kind) => {
      if (!arSupport) { ui.toast('Still checking for AR, try again in a moment'); return; }
      if (arSupport.mode === 'none') {
        const s = ui.openSheet({
          title: 'AR measuring is not available here', dialog: true,
          body: h('div', { class: 'stack' },
            h('p', null, arSupport.reason || 'This device has no AR support.'),
            h('p', { class: 'muted', style: { margin: 0 } }, 'AR needs the Fishtape app on a LiDAR-equipped iPhone or iPad, or Chrome on an Android phone that supports ARCore. You can still type a length in.')),
          actions: [
            ui.button('Type a length', { variant: 'primary', icon: 'plus', onClick: () => { s.close(); saveSheet({ kind: 'length', lengthM: null, method: 'manual' }); } }),
            ui.button('Close', { variant: 'ghost', onClick: () => s.close() }),
          ],
        });
        return;
      }
      measurePath({ units: getUnits() }).then((path) => {
        if (kind === 'area') {
          const pts = path?.points || [];
          if (pts.length < 3) { ui.toast('Tap at least three corners for an area', 'error', 4500); return; }
          const areaM2 = polygonArea(pts);
          if (!validArea(areaM2)) { ui.toast('That area did not come out right — try again', 'error'); return; }
          saveSheet({ kind: 'area', areaM2, perimeterM: closedPerimeter(pts), method: 'ar' });
        } else {
          if (!(Number(path?.totalM) > 0)) { ui.toast('No length came back from AR', 'error'); return; }
          saveSheet({ kind: 'length', lengthM: path.totalM, method: 'ar' });
        }
      }).catch((e) => {
        if (isCancelled(e)) return;
        console.error(e);
        ui.toast(e?.message || 'AR measuring stopped', 'error', 4500);
      });
    };

    // Create or edit a saved measurement. {id} edits; otherwise a new length or area.
    const saveSheet = ({ id = null, kind = 'length', lengthM = null, areaM2 = null, perimeterM = null, method = 'ar' } = {}) => {
      const existing = id ? store.get('measurements', id) : null;
      if (id && !existing) { ui.toast('That measurement is gone.', 'error'); return; }
      const theKind = existing ? (existing.kind || 'length') : kind;
      const units = getUnits();
      const jobs = store.list('jobs').sort((a, b) => String(b.number || '').localeCompare(String(a.number || '')));
      const fields = [{ label: 'Label', name: 'label', value: existing?.label || '', placeholder: theKind === 'area' ? 'e.g. basement floor' : 'e.g. panel to junction box', span: true, required: true }];

      let readout = null;
      if (theKind === 'area') {
        const a = fmtArea(existing ? existing.areaM2 : areaM2, { units });
        const peri = existing ? existing.perimeterM : perimeterM;
        readout = h('div', { class: 'measure-readout' },
          h('div', { class: 'measure-big' }, a.primary),
          h('div', { class: 'muted' }, `${a.other}${peri ? ` · perimeter ${fmtLength(peri, { units })}` : ''}`));
      } else {
        const startM = existing ? existing.lengthM : lengthM;
        fields.push({ label: `Length${startM != null ? '' : ` (${units === 'imperial' ? 'e.g. 4\' 6"' : 'e.g. 1.37 m'})`}`, name: 'length', value: startM != null ? fmtLength(startM, { units, feet: units === 'imperial' }) : '', required: true, hint: existing || lengthM == null ? null : 'From AR — adjust if needed.' });
      }
      fields.push({ label: 'Job (optional)', name: 'jobId', type: 'select', value: existing?.jobId || '', options: [{ value: '', label: '— none —' }, ...jobs.map((j) => ({ value: j.id, label: jobLabel(j) }))] });
      fields.push({ label: 'Note', name: 'note', type: 'textarea', value: existing?.note || '', span: true, placeholder: 'What this measures, anything to remember' });
      const grid = ui.formGrid(fields);

      const s = ui.openSheet({
        title: existing ? 'Edit measurement' : (theKind === 'area' ? 'Save area' : 'Save measurement'),
        body: readout ? h('div', { class: 'stack' }, readout, grid) : grid,
        actions: [
          existing ? ui.button('Delete', { variant: 'ghost danger', icon: 'trash', onClick: () => {
            store.remove('measurements', existing.id); ui.toast('Measurement deleted'); s.close(); draw();
          } }) : ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }),
          ui.button(existing ? 'Save changes' : 'Save', { variant: 'primary', icon: 'check', onClick: () => {
            const v = ui.readForm(grid);
            if (!String(v.label || '').trim()) { ui.toast('Give it a label so you can find it later', 'error'); return; }
            const job = v.jobId ? store.get('jobs', v.jobId) : null;
            const common = { label: v.label.trim().slice(0, 200), jobId: v.jobId || null, clientId: job?.clientId || null, note: (v.note || '').trim().slice(0, 2000) };
            if (theKind === 'length') {
              const m = parseLength(v.length, { units });
              if (!validLength(m)) { ui.toast(`Enter a length like ${units === 'imperial' ? `4' 6"` : '1.37 or 1370 mm'}`, 'error'); return; }
              if (existing) store.update('measurements', existing.id, { ...common, lengthM: m }, { summary: 'measurement' });
              else store.add('measurements', newMeasurement({ kind: 'length', lengthM: m, unit: units, method, ...common, by: store.actorId }));
            } else if (existing) {
              store.update('measurements', existing.id, common, { summary: 'area' });
            } else {
              store.add('measurements', newMeasurement({ kind: 'area', areaM2, perimeterM, unit: units, method, ...common, by: store.actorId }));
            }
            ui.toast('Saved', 'success');
            s.close();
            draw();
          } }),
        ],
      });
    };

    root.append(ui.page({ title: 'AR tape measure', subtitle: 'Measure a length or an area with the camera, then save it with a label and a job.' }, host));
    draw();
    return store.on('measurements', () => { if (!document.querySelector('.sheet, .dialog')) draw(); });
  },
};

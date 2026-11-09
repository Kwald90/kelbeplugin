// AR tape measure (#/measure): measure a real-world length with the camera and SAVE it with a label
// and an optional job. Reuses the AR session from lib/ar-measure.js (native ARKit/LiDAR in the iOS
// app, WebXR on ARCore Android) and the unit formatting in lib/units.js. On a device without AR you
// can still type a length in. Saved lengths live in the `measurements` collection (synced).
import { getArSupport, measurePath, isCancelled } from '../lib/ar-measure.js';
import { fmtLength, getUnits, parseLength } from '../lib/units.js';
import { newMeasurement, sortMeasurements, measurementTitle, validLength } from '../lib/measurements.js';

const ICON_AR = '<rect x="6.5" y="2.5" width="11" height="19" rx="2"/><path d="M12 8.5v7M8.5 12h7"/><circle cx="12" cy="12" r="1"/>';

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/measure.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/measure.css';
  document.head.append(link);
}

let arSupport = null;
function primeAr() { getArSupport().then((s) => { arSupport = s; }).catch(() => { arSupport = { mode: 'none' }; }); }

const jobLabel = (j) => (j ? `${j.number ? `${j.number} · ` : ''}${j.title || 'Job'}` : '');

export default {
  id: 'measure',
  title: 'AR tape',
  icon: 'ruler',
  group: 'field',
  perm: 'jobs',
  render(root, ctx) {
    loadCss();
    primeAr();
    const { store, ui, nav } = ctx;
    const { h } = ui;
    const host = h('div', { class: 'stack' });

    const draw = () => {
      ui.clear(host);
      const units = getUnits();
      const all = sortMeasurements(store.list('measurements'));
      const jobById = new Map(store.list('jobs').map((j) => [j.id, j]));

      // Capture card.
      host.append(h('section', { class: 'card measure-capture' },
        h('p', { class: 'muted', style: { marginTop: 0 } }, 'Point the camera, tap the two ends, and the length comes back. Save it with a label — and a job — to keep it. AR lengths are estimates; check critical cuts with a tape.'),
        h('div', { class: 'row' },
          ui.button('Start measuring', { variant: 'primary', icon: ICON_AR, onClick: () => startMeasure() }),
          ui.button('Type it in', { icon: 'plus', onClick: () => saveSheet({ lengthM: null, method: 'manual' }) }))));

      // Saved list.
      host.append(ui.table({
        columns: [
          { key: 'label', label: 'Measurement', render: (m) => measurementTitle(m), sort: (m) => measurementTitle(m).toLowerCase() },
          { key: 'len', label: 'Length', align: 'right', render: (m) => fmtLength(m.lengthM, { units }), sort: (m) => Number(m.lengthM) || 0 },
          { key: 'job', label: 'Job', render: (m) => (m.jobId ? jobLabel(jobById.get(m.jobId)) : '—') },
          { key: 'when', label: 'Taken', render: (m) => ui.fmtDate(m.takenAt || m.createdAt), sort: (m) => m.takenAt || m.createdAt || '' },
          { key: 'how', label: '', align: 'right', render: (m) => (m.method === 'manual' ? ui.badge('typed') : ui.badge('AR', 'info')) },
        ],
        rows: all,
        onRowClick: (m) => saveSheet({ id: m.id }),
        empty: ui.empty({
          icon: 'ruler',
          title: 'No saved measurements yet',
          text: 'Measure a length with the camera (or type one in) and save it here — label it, tie it to a job, and read it back any time.',
          action: ui.button('Start measuring', { variant: 'primary', icon: ICON_AR, onClick: () => startMeasure() }),
        }),
      }));
    };

    // Run the AR session, then open the save sheet prefilled with the measured length.
    const startMeasure = () => {
      if (!arSupport) { ui.toast('Still checking for AR, try again in a moment'); return; }
      if (arSupport.mode === 'none') {
        const s = ui.openSheet({
          title: 'AR measuring is not available here', dialog: true,
          body: h('div', { class: 'stack' },
            h('p', null, arSupport.reason || 'This device has no AR support.'),
            h('p', { class: 'muted', style: { margin: 0 } }, 'AR measuring needs the Fishtape app on a LiDAR-equipped iPhone or iPad, or Chrome on an Android phone that supports ARCore. You can still type the length in.')),
          actions: [
            ui.button('Type it in', { variant: 'primary', icon: 'plus', onClick: () => { s.close(); saveSheet({ lengthM: null, method: 'manual' }); } }),
            ui.button('Close', { variant: 'ghost', onClick: () => s.close() }),
          ],
        });
        return;
      }
      measurePath({ units: getUnits() }).then((path) => {
        if (!(Number(path?.totalM) > 0)) { ui.toast('No length came back from AR', 'error'); return; }
        saveSheet({ lengthM: path.totalM, method: 'ar' });
      }).catch((e) => {
        if (isCancelled(e)) return;
        console.error(e);
        ui.toast(e?.message || 'AR measuring stopped', 'error', 4500);
      });
    };

    // Create or edit a saved measurement. {id} edits an existing one; {lengthM, method} starts a new one.
    const saveSheet = ({ id = null, lengthM = null, method = 'ar' } = {}) => {
      const existing = id ? store.get('measurements', id) : null;
      if (id && !existing) { ui.toast('That measurement is gone.', 'error'); return; }
      const units = getUnits();
      const startM = existing ? existing.lengthM : lengthM;
      const jobs = store.list('jobs').sort((a, b) => String(b.number || '').localeCompare(String(a.number || '')));
      const lenField = { label: `Length${startM != null ? '' : ` (${units === 'imperial' ? 'e.g. 4\' 6"' : 'e.g. 1.37 m'})`}`, name: 'length', value: startM != null ? fmtLength(startM, { units, feet: units === 'imperial' }) : '', required: true, hint: existing || lengthM == null ? null : 'From AR — adjust if needed.' };
      const grid = ui.formGrid([
        { label: 'Label', name: 'label', value: existing?.label || '', placeholder: 'e.g. panel to junction box', span: true, required: true },
        lenField,
        { label: 'Job (optional)', name: 'jobId', type: 'select', value: existing?.jobId || '', options: [{ value: '', label: '— none —' }, ...jobs.map((j) => ({ value: j.id, label: jobLabel(j) }))] },
        { label: 'Note', name: 'note', type: 'textarea', value: existing?.note || '', span: true, placeholder: 'What this measures, anything to remember' },
      ]);
      const s = ui.openSheet({
        title: existing ? 'Edit measurement' : 'Save measurement',
        body: grid,
        actions: [
          existing ? ui.button('Delete', { variant: 'ghost danger', icon: 'trash', onClick: () => {
            store.remove('measurements', existing.id); ui.toast('Measurement deleted'); s.close(); draw();
          } }) : ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }),
          ui.button(existing ? 'Save changes' : 'Save', { variant: 'primary', icon: 'check', onClick: () => {
            const v = ui.readForm(grid);
            const m = parseLength(v.length, { units });
            if (!validLength(m)) { ui.toast(`Enter a length like ${units === 'imperial' ? `4' 6"` : '1.37 or 1370 mm'}`, 'error'); return; }
            if (!String(v.label || '').trim()) { ui.toast('Give it a label so you can find it later', 'error'); return; }
            const job = v.jobId ? store.get('jobs', v.jobId) : null;
            if (existing) {
              store.update('measurements', existing.id, { label: v.label.trim().slice(0, 200), lengthM: m, jobId: v.jobId || null, clientId: job?.clientId || null, note: (v.note || '').trim().slice(0, 2000) }, { summary: 'measurement' });
            } else {
              store.add('measurements', newMeasurement({ lengthM: m, unit: units, method, jobId: v.jobId || null, clientId: job?.clientId || null, label: v.label, note: v.note, by: store.actorId }));
            }
            ui.toast('Saved', 'success');
            s.close();
            draw();
          } }),
        ],
      });
    };

    root.append(ui.page({ title: 'AR tape measure', subtitle: 'Measure a length with the camera, then save it with a label and a job.' }, host));
    draw();
    return store.on('measurements', () => { if (!document.querySelector('.sheet, .dialog')) draw(); });
  },
};

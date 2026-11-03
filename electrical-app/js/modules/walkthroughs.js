// Site walkthroughs (#/walkthroughs): a free-form video + photo record of a job site — the
// "CompanyCam walkthrough". You walk the site talking; it records video + audio and you grab stills
// as you go, then divide them into groups you name afterwards. No fixed room list — every job is
// different. Internal by default; the office can mark one visible to the client and print a report.
//   #/walkthroughs              the list (filter by job)
//   #/walkthroughs/new?jobId=   start one (pick a job + title)
//   #/walkthroughs/:id          record, capture stills, transcribe, organise, share, report
// Pure logic: js/lib/walkthroughs.js. Camera/stills: lib/safety-capture.js; video: lib/walkthrough-
// recorder.js + lib/local-blobs.js (device-local); transcript: lib/transcribe.js.
import {
  newWalkthrough, newCapture, progress, canShare, walkthroughLabel, legacyCaptures,
  withCapture, withoutCapture, assignCapture, relabelCapture, withGroup, renameGroup, withoutGroup,
  groupsWithCaptures, setRecording, mergeRecording, setTranscript, hasVideo, hasLocalVideo, videoStatus,
  hasTranscript, captureCount, MAX_CAPTURES,
} from '../lib/walkthroughs.js';
import { pickImages, downscaleImage } from '../lib/safety-capture.js';
import { recordingSupported, startRecording, fmtClock, MAX_UPLOAD_BYTES } from '../lib/walkthrough-recorder.js';
import { putBlob, getBlob, blobUrl, deleteBlob } from '../lib/local-blobs.js';
import { uploadWalkthroughVideo, fetchWalkthroughMedia, deleteWalkthroughMedia, transcribeWalkthroughVideo, mediaUrl } from '../lib/walkthrough-upload.js';
import { liveDictationSupported, startLiveDictation, appendPhrase, aiTranscriptionAvailable, setAiTranscription } from '../lib/transcribe.js';

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/walkthroughs.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/walkthroughs.css';
  document.head.append(link);
}

export default {
  id: 'walkthroughs',
  title: 'Walkthroughs',
  icon: 'image',
  group: 'field',
  perm: 'jobs',
  render(root, ctx) {
    loadCss();
    const [sub] = ctx.params;
    if (sub === 'new') { startNew(ctx); return; }
    if (sub) return detailView(root, ctx, sub);
    return listView(root, ctx);
  },
};

const jobLabel = (j) => (j ? `${j.number || ''}${j.number ? ' · ' : ''}${j.title || 'Job'}`.trim() : '—');
const clientName = (store, id) => (id ? store.get('clients', id)?.name || null : null);

// ---------- list ----------
function listView(root, ctx) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  let jobId = ctx.query.jobId || '';
  const host = h('div', { class: 'stack' });

  const draw = () => {
    ui.clear(host);
    const jobs = new Map(store.list('jobs').map((j) => [j.id, j]));
    const all = store.list('walkthroughs')
      .filter((w) => !jobId || w.jobId === jobId)
      .sort((a, b) => String(b.date || b.createdAt).localeCompare(String(a.date || a.createdAt)));
    const jobPick = h('select', { class: 'input wt-jobpick', 'aria-label': 'Job', onChange: (e) => { jobId = e.target.value; history.replaceState(null, '', `#/walkthroughs${jobId ? `?jobId=${jobId}` : ''}`); draw(); } },
      h('option', { value: '' }, 'All jobs'),
      [...jobs.values()].sort((a, b) => String(b.number).localeCompare(String(a.number))).map((j) => h('option', { value: j.id, selected: j.id === jobId }, jobLabel(j))));
    h(host, null,
      h('div', { class: 'row wt-toolbar' }, jobPick, h('span', { class: 'grow' }),
        ui.button('New walkthrough', { variant: 'primary', icon: 'plus', href: `#/walkthroughs/new${jobId ? `?jobId=${jobId}` : ''}` })),
      all.length ? ui.table({
        columns: [
          { key: 'date', label: 'Date', render: (w) => ui.fmtDate(w.date || w.createdAt), sort: (w) => w.date || w.createdAt },
          { key: 'title', label: 'Walkthrough', render: (w) => w.title || 'Walkthrough' },
          { key: 'job', label: 'Job', render: (w) => jobLabel(jobs.get(w.jobId)) },
          { key: 'media', label: 'Captured', align: 'right', render: (w) => mediaSummary(w) },
          { key: 'state', label: 'Status', render: (w) => (w.status === 'complete' ? ui.badge('complete', 'success') : ui.badge('in progress', 'warning')) },
          { key: 'shared', label: 'Client', render: (w) => (w.sharedWithClient ? ui.badge('shared', 'info') : '') },
        ],
        rows: all, onRowClick: (w) => nav(`walkthroughs/${w.id}`),
      }) : ui.empty({ icon: 'image', title: 'No walkthroughs yet', text: 'Walk a job site talking as you go — it records video and audio, you grab photos along the way, and afterwards you divide them into sections you name. Great for a before/after record, inspections and handing a visual report to the client.', action: ui.button('New walkthrough', { variant: 'primary', icon: 'plus', href: '#/walkthroughs/new' }) }));
  };

  root.append(ui.page({ title: 'Site walkthroughs', subtitle: 'Video + photo walkthroughs of the job site' }, host));
  draw();
  const off = store.on('walkthroughs', () => { if (!document.querySelector('.sheet, .dialog')) draw(); });
  return off;
}

function mediaSummary(w) {
  const n = captureCount(w) + (legacyCaptures(w)?.captures.length || 0);
  const bits = [];
  if (hasVideo(w)) bits.push('video');
  bits.push(`${n} photo${n === 1 ? '' : 's'}`);
  if (hasTranscript(w)) bits.push('transcript');
  return bits.join(' · ');
}

// ---------- start a new one ----------
function startNew(ctx) {
  const { store, ui, nav } = ctx;
  const jobs = store.list('jobs').filter((j) => (j.status || 'active') !== 'archived')
    .sort((a, b) => String(b.number).localeCompare(String(a.number)));
  if (!jobs.length) { ui.toast('Add a job first, then start a walkthrough for it.', 'info', 4000); nav('#/walkthroughs'); return; }
  const preJob = ctx.query.jobId && jobs.some((j) => j.id === ctx.query.jobId) ? ctx.query.jobId : jobs[0].id;

  ui.formSheet({
    title: 'New walkthrough',
    fields: [
      { label: 'Job', name: 'jobId', type: 'select', required: true, value: preJob, options: jobs.map((j) => ({ value: j.id, label: jobLabel(j) })) },
      { label: 'Title', name: 'title', placeholder: 'Site walkthrough', span: true, hint: 'e.g. "Service call — 12 Main St" or "Rough-in walk".' },
    ],
    submitLabel: 'Start',
    onSubmit: (v) => {
      const job = store.get('jobs', v.jobId);
      if (!job) { ui.toast('Pick a job', 'error'); return false; }
      const w = newWalkthrough({ job, title: v.title, by: store.actorId, date: ui.today() });
      store.add('walkthroughs', w);
      nav(`#/walkthroughs/${w.id}`);
    },
    onClose: () => { if (location.hash.includes('/new')) nav('#/walkthroughs'); },
  });
}

// ---------- the walkthrough ----------
function detailView(root, ctx, id) {
  const { store, ui, auth, nav } = ctx;
  const { h } = ui;
  let w = store.get('walkthroughs', id);
  if (!w) { ui.toast('That walkthrough is gone.', 'error'); nav('#/walkthroughs'); return; }
  const office = auth.can('invoices') || auth.isManager();
  const readOnly = w.status === 'complete';

  // One person walks a site; last-writer-wins is fine. Keep the local copy in step with each save.
  const save = (patch) => { w = store.update('walkthroughs', id, patch); };

  // One-time migration of an old room-by-room walkthrough into the free-form model.
  if (!captureCount(w) && !hasVideo(w)) {
    const legacy = legacyCaptures(w);
    if (legacy) save({ groups: legacy.groups, captures: legacy.captures, stops: null });
  }

  const job = store.get('jobs', w.jobId);
  const cName = clientName(store, w.clientId);

  const recHost = h('div', { class: 'wt-rec' });
  const capsHost = h('div', { class: 'wt-caps' });
  const transHost = h('div', { class: 'wt-trans' });
  const actionsHost = h('div', { class: 'row wt-head-actions' });

  // ---- recording ----
  let rec = null; // active recorder controller
  let tick = null; // elapsed-clock interval
  let dictation = null;
  let serverPoll = null;  // interval polling the server while a video transcodes
  let lastMedia = null;   // last media view fetched from the server { id, status, url, posterUrl }
  let transPoll = null;   // interval polling while an AI transcription runs
  let transcribing = false;

  // Keep the record's video status in step with the server, and resolve playback urls.
  async function refreshMedia() {
    const mid = w.recording?.mediaId;
    if (!mid) { lastMedia = null; return null; }
    try {
      const m = await fetchWalkthroughMedia(mid);
      lastMedia = m;
      if (typeof m?.aiTranscription === 'boolean') setAiTranscription(m.aiTranscription);
      if (m?.status && m.status !== w.recording?.status) save(mergeRecording(w, { status: m.status }));
      return m;
    } catch { return lastMedia; }
  }
  function stopMediaPolling() { if (serverPoll) { clearInterval(serverPoll); serverPoll = null; } }
  function startMediaPolling() {
    stopMediaPolling();
    if (!['uploading', 'processing'].includes(videoStatus(w))) return;
    serverPoll = setInterval(async () => {
      const m = await refreshMedia();
      if (!m || ['ready', 'failed'].includes(m.status)) { stopMediaPolling(); drawRec(); drawTrans(); }
    }, 4000);
  }

  // Send the recorded blob to the server store (so it plays fast and syncs across devices).
  async function uploadVideo({ silent = false } = {}) {
    const r = w.recording;
    if (!r || !r.localId) return; // nothing local to send (already server-only)
    save(mergeRecording(w, { status: 'uploading' })); drawRec();
    try {
      const blob = await getBlob(r.localId);
      if (!blob || !blob.size) throw Object.assign(new Error('The recording is no longer on this device.'), { code: 'no_video' });
      if (blob.size > MAX_UPLOAD_BYTES) throw Object.assign(new Error('That recording is too long to upload. Record a shorter walk.'), { code: 'too_large' });
      const resp = await uploadWalkthroughVideo(blob, { walkthroughId: id, durationMs: r.durationMs });
      lastMedia = resp;
      save(mergeRecording(w, { mediaId: resp.id, status: resp.status || 'processing', bytes: blob.size }));
      if (!silent) ui.toast(resp.status === 'ready' ? 'Video uploaded.' : 'Video uploaded — optimising for fast playback.', 'success', 2500);
      startMediaPolling();
    } catch (e) {
      save(mergeRecording(w, { status: w.recording?.mediaId ? 'processing' : 'failed' }));
      if (!silent) {
        const msg = e?.code === 'offline' ? 'Saved on this device. It will upload when you tap Upload with a connection.' : (e?.message || 'Upload failed.');
        ui.toast(msg, 'warning', 5000);
      }
    }
    drawRec();
  }

  function drawRec() {
    ui.clear(recHost);
    if (readOnly) { if (hasVideo(w)) recHost.append(videoCard()); return; }

    if (rec) {
      const clock = h('span', { class: 'wt-rec-clock', role: 'timer' }, '0:00');
      tick = setInterval(() => { clock.textContent = fmtClock(rec.elapsedMs()); }, 500);
      const interim = h('div', { class: 'wt-rec-interim muted' });
      recHost.append(
        h('div', { class: 'wt-rec-live' },
          rec.previewEl,
          h('div', { class: 'wt-rec-badge' }, h('span', { class: 'wt-rec-dot' }), 'REC ', clock),
        ),
        h('div', { class: 'row wt-rec-controls' },
          ui.button('Snap photo', { variant: 'primary', icon: 'image', onClick: snap }),
          ui.button('Stop', { variant: 'ghost danger', icon: 'x', onClick: stopRec }),
        ),
        liveDictationSupported() ? interim : h('div', { class: 'hint' }, 'Audio is recorded with the video; transcript can be added after.'),
      );
      if (liveDictationSupported()) startDictation(interim);
    } else {
      if (hasVideo(w)) recHost.append(videoCard());
      const canRec = recordingSupported();
      recHost.append(h('div', { class: 'row wt-capture-actions' },
        canRec ? ui.button(hasVideo(w) ? 'Record again' : 'Record walk', { variant: 'primary', icon: 'play', onClick: startRec }) : null,
        ui.button('Add photos', { variant: canRec ? 'ghost' : 'primary', icon: 'image', onClick: addPhotos }),
      ));
      if (!canRec) recHost.append(h('div', { class: 'hint' }, 'Video recording needs camera access in the app; you can still add photos from the camera or library.'));
    }
  }

  function videoCard() {
    const r = w.recording || {};
    const status = videoStatus(w);
    const card = h('div', { class: 'wt-video card' });
    const badge = status === 'ready' ? ui.badge('on server', 'success')
      : status === 'processing' ? ui.badge('optimising…', 'warning')
      : status === 'uploading' ? ui.badge('uploading…', 'warning')
      : status === 'failed' ? ui.badge('upload failed', 'danger')
      : ui.badge('on this device', 'info');
    const meta = h('div', { class: 'wt-video-meta muted' }, `Video · ${fmtClock(r.durationMs || 0)}${r.startedAt ? ` · ${ui.fmtDate(r.startedAt)}` : ''}`);
    const header = () => {
      const row = h('div', { class: 'row wt-video-head' }, h('span', { class: 'wt-video-ico' }, ui.icon('play', 20)), meta, badge, h('span', { class: 'grow' }));
      row.append(ui.button('Play video', { size: 'sm', icon: 'play', onClick: () => playInto() }));
      if (!readOnly && r.localId && (status === 'failed' || status === 'local')) {
        row.append(ui.button('Upload to server', { size: 'sm', variant: 'ghost', onClick: () => uploadVideo() }));
      }
      return row;
    };
    const playInto = async () => {
      let src = '';
      let poster;
      const m = r.mediaId ? ((lastMedia && lastMedia.id === r.mediaId) ? lastMedia : await refreshMedia()) : null;
      if (m && m.url) { src = mediaUrl(m.url); if (m.posterUrl) poster = mediaUrl(m.posterUrl); }
      if (!src && r.localId) src = await blobUrl(r.localId);
      ui.clear(card); card.append(header());
      if (!src) {
        card.append(h('div', { class: 'hint' }, status === 'processing'
          ? 'The video is still being optimised on the server — try again in a moment.'
          : 'The video was recorded on another device and isn’t stored here. Photos and the transcript are still available.'));
        return;
      }
      card.append(h('video', { class: 'wt-video-el', controls: true, src, playsInline: true, ...(poster ? { poster } : {}) }));
    };
    card.append(header());
    if (status === 'failed' && r.error) card.append(h('div', { class: 'hint' }, 'The server couldn’t process this video; it still plays from this device. You can try Upload again.'));
    return card;
  }

  async function startRec() {
    try {
      rec = await startRecording();
      drawRec();
    } catch (e) {
      rec = null;
      const msg = /denied|NotAllowed/i.test(String(e)) ? 'Camera/mic permission was blocked. Allow it for the app, or use Add photos.' : 'Couldn’t start the camera. You can still add photos.';
      ui.toast(msg, 'error', 4500);
      drawRec();
    }
  }

  async function snap() {
    if (!rec) return;
    try {
      const atMs = rec.elapsedMs();
      const shot = await rec.grabStill();
      save({ captures: withCapture(w, newCapture({ photo: shot.dataUrl, atMs })) });
      drawCaps();
      ui.toast('Photo grabbed', 'success', 1200);
    } catch { ui.toast('Couldn’t grab that frame', 'error'); }
  }

  async function stopRec() {
    if (!rec) return;
    const controller = rec; rec = null;
    clearInterval(tick); tick = null;
    stopDictation();
    let out;
    try { out = await controller.stop(); } catch { out = null; }
    if (out && out.blob && out.blob.size) {
      const prevMediaId = w.recording?.mediaId;
      try {
        const localId = await putBlob(out.blob);
        const prev = w.recording?.localId;
        save(setRecording({ localId, durationMs: out.durationMs, mimeType: out.mimeType, bytes: out.blob.size, status: 'local' }));
        if (prev && prev !== localId) deleteBlob(prev);
        if (prevMediaId) deleteWalkthroughMedia(prevMediaId).catch(() => {}); // a re-record replaces the old server video
        ui.toast('Walk recorded', 'success');
        drawRec();
        uploadVideo({ silent: true }); // send it up in the background so it plays fast everywhere
        return;
      } catch { ui.toast('Recorded, but this device can’t store the video. Photos and transcript were kept.', 'warning', 5000); }
    }
    drawRec();
  }

  async function addPhotos() {
    const room = MAX_CAPTURES - captureCount(w);
    if (room <= 0) { ui.toast('That’s the most photos one walkthrough can hold.', 'info'); return; }
    const files = await pickImages({ multiple: room > 1 });
    let added = 0;
    for (const f of files.slice(0, room)) {
      try { const p = await downscaleImage(f); save({ captures: withCapture(w, newCapture({ photo: p.dataUrl })) }); added++; }
      catch { ui.toast(`Couldn’t read ${f.name}`, 'error'); }
    }
    if (added) { drawCaps(); ui.toast(`${added} photo${added === 1 ? '' : 's'} added`, 'success', 1500); }
  }

  // ---- transcript ----
  function startDictation(interimEl) {
    stopDictation();
    let t = null;
    dictation = startLiveDictation({
      onText: (phrase) => { save({ transcript: appendPhrase(w.transcript, phrase), transcriptSource: w.transcriptSource || 'ios-speech' }); if (interimEl) interimEl.textContent = ''; drawTrans(); },
      onInterim: (txt) => { if (interimEl) interimEl.textContent = txt; },
      onError: () => { /* unsupported or a transient engine hiccup — manual transcript still works */ },
    });
  }
  function stopDictation() { if (dictation) { dictation.stop(); dictation = null; } }

  function stopTransPoll() { if (transPoll) { clearInterval(transPoll); transPoll = null; } }
  function startTransPoll(mid) {
    stopTransPoll();
    transPoll = setInterval(async () => {
      let m; try { m = await fetchWalkthroughMedia(mid); } catch { return; }
      if (!m || m.transcribeStatus === 'processing') return;
      stopTransPoll(); transcribing = false;
      if (m.transcribeStatus === 'ready') {
        if (m.transcript) save(setTranscript(m.transcript, 'gemini'));
        ui.toast('Transcribed', 'success', 1500);
      } else if (m.transcribeStatus === 'failed') {
        ui.toast(m.transcribeError || 'The transcription failed.', 'error', 5000);
      }
      drawTrans();
    }, 4000);
  }
  async function runAiTranscribe() {
    const mid = w.recording?.mediaId;
    if (!mid || transcribing) return;
    if (w.transcript && !(await ui.confirmDialog('Replace the current transcript with the AI transcription?', { title: 'Transcribe with AI', okLabel: 'Replace', danger: false }))) return;
    transcribing = true; drawTrans();
    try {
      await transcribeWalkthroughVideo(mid);
      startTransPoll(mid);
    } catch (e) {
      transcribing = false; drawTrans();
      ui.toast(e.message || 'Could not start transcription.', 'error', 4000);
    }
  }

  function drawTrans() {
    ui.clear(transHost);
    const canAi = !readOnly && aiTranscriptionAvailable() && w.recording?.mediaId && videoStatus(w) === 'ready';
    const head = h('div', { class: 'row wt-trans-head' },
      h('strong', null, 'Transcript'),
      w.transcriptSource ? ui.badge(w.transcriptSource === 'gemini' ? 'AI' : w.transcriptSource === 'ios-speech' ? 'voice' : 'typed', 'info') : null,
      h('span', { class: 'grow' }),
      canAi ? ui.button(transcribing ? 'Transcribing…' : 'Transcribe with AI', { size: 'sm', variant: 'ghost', icon: 'star', disabled: transcribing, onClick: runAiTranscribe }) : null,
    );
    if (readOnly) {
      transHost.append(head, w.transcript ? h('p', { class: 'wt-trans-ro' }, w.transcript) : h('div', { class: 'hint' }, 'No transcript.'));
      return;
    }
    const ta = h('textarea', { class: 'input wt-trans-ta', rows: 4, placeholder: liveDictationSupported() ? 'Dictated as you record where the phone supports it — edit here, or type your own notes.' : 'Type what you walked through, or dictate on a device that supports it.', value: w.transcript || '' });
    let t = null;
    ta.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => save(setTranscript(ta.value, 'manual')), 600); });
    ta.addEventListener('blur', () => { clearTimeout(t); save(setTranscript(ta.value, w.transcriptSource === 'manual' || !w.transcriptSource ? 'manual' : w.transcriptSource)); });
    transHost.append(head, ta);
  }

  // ---- captures / organise ----
  function drawCaps() {
    ui.clear(capsHost);
    const total = captureCount(w);
    if (!total) {
      capsHost.append(h('div', { class: 'wt-caps-empty hint' }, readOnly ? 'No photos were captured.' : 'Snap photos while you record, or add them from the camera. You can group them after.'));
      return;
    }
    const sections = groupsWithCaptures(w);
    capsHost.append(h('div', { class: 'row wt-caps-head' },
      h('strong', null, `${total} photo${total === 1 ? '' : 's'}`),
      h('span', { class: 'grow' }),
      readOnly ? null : ui.button('New group', { size: 'sm', variant: 'ghost', icon: 'plus', onClick: addGroup })));
    for (const sec of sections) capsHost.append(groupSection(sec));
  }

  function groupSection({ group, captures }) {
    const title = group
      ? h('div', { class: 'row wt-grp-head' },
          h('strong', null, group.name || 'Group'),
          h('span', { class: 'muted' }, `${captures.length}`),
          h('span', { class: 'grow' }),
          readOnly ? null : ui.button('', { size: 'sm', variant: 'ghost', icon: 'pen', title: 'Rename group', onClick: () => renameGrp(group) }),
          readOnly ? null : ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'x', title: 'Remove group', onClick: () => removeGrp(group) }))
      : (captures.length && groupsWithCaptures(w).length > 1 ? h('div', { class: 'row wt-grp-head' }, h('strong', { class: 'muted' }, 'Ungrouped')) : null);
    const grid = h('div', { class: 'wt-grid' }, captures.map((c) => captureTile(c)));
    return h('div', { class: 'wt-grp' }, title, grid);
  }

  function captureTile(c) {
    const img = h('img', { class: 'wt-tile-img', src: c.photo, alt: c.label || 'Photo', loading: 'lazy' });
    const tile = h('figure', { class: 'wt-tile' }, img);
    if (c.atMs != null) tile.append(h('span', { class: 'wt-tile-ts' }, fmtClock(c.atMs)));
    if (!readOnly) {
      const label = h('input', { class: 'input wt-tile-label', placeholder: 'Label', value: c.label || '', 'aria-label': 'Photo label' });
      let t = null;
      label.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => save({ captures: relabelCapture(w, c.id, label.value) }), 500); });
      label.addEventListener('blur', () => { clearTimeout(t); save({ captures: relabelCapture(w, c.id, label.value) }); });
      tile.append(h('figcaption', { class: 'wt-tile-cap' }, label,
        h('div', { class: 'row wt-tile-tools' },
          ui.button('', { size: 'sm', variant: 'ghost', icon: 'layers', title: 'Move to a group', onClick: () => moveCapture(c) }),
          ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'trash', title: 'Delete photo', onClick: () => delCapture(c) }))));
    } else if (c.label) {
      tile.append(h('figcaption', { class: 'wt-tile-cap' }, c.label));
    }
    return tile;
  }

  function addGroup() {
    ui.promptDialog('Name this group (a room, an area, "before", "after"…)', { title: 'New group', okLabel: 'Add' }).then((name) => {
      if (name == null) return;
      const groups = withGroup(w, name);
      if (groups.length === (w.groups || []).length) { ui.toast('Give the group a name.', 'info'); return; }
      save({ groups }); drawCaps();
    });
  }
  function renameGrp(group) {
    ui.promptDialog('Group name', { title: 'Rename group', value: group.name || '', okLabel: 'Save' }).then((name) => {
      if (name == null) return;
      save({ groups: renameGroup(w, group.id, name) }); drawCaps();
    });
  }
  async function removeGrp(group) {
    if (!(await ui.confirmDialog(`Remove the group "${group.name}"? Its photos move back to ungrouped.`, { okLabel: 'Remove' }))) return;
    save(withoutGroup(w, group.id)); drawCaps();
  }
  function moveCapture(c) {
    const groups = w.groups || [];
    const opts = [
      { label: '— Ungrouped —', value: '' },
      ...groups.map((g) => ({ label: g.name || 'Group', value: g.id })),
      { label: '＋ New group…', value: '__new' },
    ];
    ui.openSheet({
      title: 'Move photo',
      body: (close) => h('div', { class: 'stack wt-move' }, opts.map((o) => ui.button(o.label, {
        variant: (c.groupId || '') === o.value ? 'primary' : 'ghost', full: true,
        onClick: () => {
          close();
          if (o.value === '__new') { addThenAssign(c); return; }
          save({ captures: assignCapture(w, c.id, o.value || null) }); drawCaps();
        },
      }))),
    });
  }
  function addThenAssign(c) {
    ui.promptDialog('Name the new group', { title: 'New group', okLabel: 'Add' }).then((name) => {
      if (name == null) return;
      const groups = withGroup(w, name);
      if (groups.length === (w.groups || []).length) return;
      const g = groups[groups.length - 1];
      save({ groups }); save({ captures: assignCapture(w, c.id, g.id) }); drawCaps();
    });
  }
  async function delCapture(c) {
    if (!(await ui.confirmDialog('Delete this photo?', { okLabel: 'Delete' }))) return;
    save({ captures: withoutCapture(w, c.id) }); drawCaps();
  }

  // ---- share / complete / report ----
  function shareRow() {
    const can = canShare(w) || w.sharedWithClient;
    const cb = h('input', { type: 'checkbox', checked: !!w.sharedWithClient, disabled: !office || !w.clientId, onChange: (e) => {
      const on = e.target.checked;
      save(on ? { sharedWithClient: true, sharedAt: new Date().toISOString(), sharedBy: store.actorId } : { sharedWithClient: false });
      ui.toast(on ? 'This walkthrough is now visible to the client.' : 'No longer shared with the client.', on ? 'success' : 'info');
    } });
    const note = !w.clientId ? 'This job has no client, so there is nobody to share with.'
      : !office ? 'The office decides what the client sees.'
      : !can ? 'Capture a photo or the video first, then you can share it.'
      : 'Shared walkthroughs appear in the client’s portal; you can also print or hand over the report.';
    return h('label', { class: 'wt-share check' }, cb, h('span', null, h('strong', null, 'Visible to client'), h('span', { class: 'hint' }, note)));
  }

  function complete() {
    if (w.status === 'complete') { save({ status: 'active', completedAt: null }); ui.toast('Reopened.', 'info'); nav(`#/walkthroughs/${id}`); return; }
    if (!captureCount(w) && !hasVideo(w)) { ui.toast('Record or capture something first.', 'error'); return; }
    save({ status: 'complete', completedAt: new Date().toISOString() });
    ui.toast('Walkthrough complete.', 'success');
    nav(`#/walkthroughs/${id}`);
  }

  function drawActions() {
    ui.clear(actionsHost).append(
      ui.button('Report', { icon: 'printer', variant: 'ghost', onClick: () => printReport(w, ctx) }),
      ui.button(w.status === 'complete' ? 'Reopen' : 'Mark complete', { variant: w.status === 'complete' ? 'ghost' : 'primary', onClick: complete }),
      office ? ui.button('', { variant: 'ghost danger', icon: 'x', title: 'Delete walkthrough', onClick: async () => {
        if (await ui.confirmDialog('Delete this walkthrough and its photos?', { okLabel: 'Delete' })) { if (w.recording?.localId) deleteBlob(w.recording.localId); if (w.recording?.mediaId) deleteWalkthroughMedia(w.recording.mediaId).catch(() => {}); store.remove('walkthroughs', id); nav('#/walkthroughs'); }
      } }) : null);
  }

  root.append(ui.page({
    title: walkthroughLabel(w),
    subtitle: [jobLabel(job), cName].filter(Boolean).join(' · ') || 'Walkthrough',
  },
    actionsHost,
    h('section', { class: 'wt-section' }, h('h3', { class: 'wt-h' }, 'Record the walk'), recHost),
    h('section', { class: 'wt-section' }, transHost),
    h('section', { class: 'wt-section' }, h('h3', { class: 'wt-h' }, 'Photos'), capsHost),
    h('div', { class: 'wt-section' }, shareRow()),
    h('div', { class: 'row wt-foot' }, ui.button('Back to walkthroughs', { variant: 'ghost', href: '#/walkthroughs' }))));

  drawActions();
  drawRec();
  drawTrans();
  drawCaps();
  // If the video is still uploading/processing from a previous visit, resume watching the server.
  startMediaPolling();
  // Fetch the video row once on load (even when ready) so the AI-transcription flag is known and
  // the "Transcribe with AI" button can show.
  if (w.recording?.mediaId) refreshMedia().then(() => drawTrans());

  // stop the camera/dictation/pollers if the user navigates away mid-record
  return () => { if (rec) rec.cancel(); clearInterval(tick); stopDictation(); stopMediaPolling(); stopTransPoll(); };
}

// ---------- printable / shareable report ----------
function printReport(w, ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const job = store.get('jobs', w.jobId);
  const company = store.settings().company || {};
  const cName = clientName(store, w.clientId);
  const sections = groupsWithCaptures(w);
  const n = captureCount(w);

  const node = h('div', { class: 'wt-print' },
    h('header', { class: 'wt-print-head' },
      h('div', null, h('h1', null, w.title || 'Site walkthrough'),
        h('div', { class: 'wt-print-sub' }, [jobLabel(job), cName, ui.fmtDate(w.date || w.createdAt)].filter(Boolean).join(' · '))),
      h('div', { class: 'wt-print-co' }, company.name || '', company.phone ? h('div', null, company.phone) : null)),
    h('div', { class: 'wt-print-meta' }, `${n} photo${n === 1 ? '' : 's'}${hasVideo(w) ? ' · video on file' : ''}${w.status === 'complete' ? ' · complete' : ''}`),
    hasTranscript(w) ? h('section', { class: 'wt-print-trans' }, h('h2', null, 'What was walked'), h('p', null, w.transcript)) : null,
    sections.map((sec) => (sec.captures.length ? h('section', { class: 'wt-print-grp' },
      h('h2', null, sec.group ? (sec.group.name || 'Group') : (sections.length > 1 ? 'Ungrouped' : 'Photos')),
      h('div', { class: 'wt-print-photos' }, sec.captures.map((c) => h('figure', null, h('img', { src: c.photo, alt: c.label || '' }), c.label ? h('figcaption', null, c.label) : null)))) : null)));

  document.body.append(node);
  document.body.classList.add('printing-walkthrough');
  const done = () => {
    node.remove();
    document.body.classList.remove('printing-walkthrough');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 800); }, 50);
}

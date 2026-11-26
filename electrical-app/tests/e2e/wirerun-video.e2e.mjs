// Wire-run video in headless Chrome, on the demo (no server, so uploads stay queued): a real WebM is
// recorded in the page (canvas + MediaRecorder) and kept on the device as an unattached recording
// with markers; the list shows it under the "Working on" job; it is attached to a run from the
// Videos on this device page; the run shows it with its markers; the re-check overlay plays it,
// jumps between markers and opens the frame measure (scale first); then the video is removed and
// its bytes leave IndexedDB. Uncaught page errors fail the run.
//   node electrical-app/tests/e2e/wirerun-video.e2e.mjs [appDir] [port] [profileDir]
// Needs python (static server) and Chrome (CHROME_PATH to override). E2E_SHOTS=<dir> saves screenshots.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const APPDIR = process.argv[2] || fileURLToPath(new URL('../../', import.meta.url));
const PORT = process.argv[3] || '8793';
const PROFILE = process.argv[4] || join(mkdtempSync(join(tmpdir(), 'fishtape-wrvideo-')), 'profile');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = Number(PORT) + 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); };

const py = spawn('python', ['-m', 'http.server', PORT, '--bind', '127.0.0.1'], { cwd: APPDIR, stdio: 'ignore' });
rmSync(PROFILE, { recursive: true, force: true }); mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', `--user-data-dir=${PROFILE}`,
  '--window-size=1280,860', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { py.kill(); } catch {} };
process.on('exit', cleanup);

let ws, seq = 0;
const pending = new Map();
const pageErrors = [];
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch {}
    await sleep(200);
  }
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
  });
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, (msg) => (msg.error ? reject(new Error(method + ': ' + msg.error.message)) : resolve(msg.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(expr, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch {} await sleep(100); }
  throw new Error('timeout waiting for ' + expr);
}
async function shot(name) {
  if (!process.env.E2E_SHOTS) return;
  mkdirSync(process.env.E2E_SHOTS, { recursive: true });
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(process.env.E2E_SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}
const clickText = (sel, re) => ev(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => ${re}.test(x.textContent)); if (!b) return false; b.click(); return true; })()`);

try {
  await connect();
  await send('Runtime.enable');
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok) break; } catch {} await sleep(200); }
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await waitFor(`[...document.querySelectorAll('button')].some((b) => /Try the demo/.test(b.textContent))`);
  await ev(`localStorage.setItem('ft.units', 'metric')`);
  await clickText('button', /Try the demo/);
  await waitFor(`!!globalThis.kelbe?.store && kelbe.store.list('jobs').length > 0`);
  await sleep(500);

  // a job, a run on it, and a run elsewhere; "Working on" that job
  const ids = await ev(`(async () => {
    const { store, auth } = kelbe;
    const open = (j) => !['complete', 'invoiced', 'cancelled'].includes(j.status); // a closed job can't be the focus
    const job = store.list('jobs').find(open);
    const W = await import('/js/lib/wireruns.js');
    const a = store.add('wireRuns', { ...W.newRun({ name: 'Video run', jobId: job.id }), segments: [W.newSegment({ id: 'seg-a', label: 'Panel to box', lengthM: 2, source: 'ar' }), W.newSegment({ id: 'seg-b', label: 'Box to light', lengthM: 3, source: 'ar' })] });
    const other = store.list('jobs').find((j) => j.id !== job.id && open(j));
    const b = store.add('wireRuns', W.newRun({ name: 'Other job run', jobId: other?.id || null }));
    const F = await import('/js/lib/job-focus.js');
    F.setJobFocus(store, auth, job.id);
    return { job: job.id, runA: a.id, runB: b.id, other: other?.id || null };
  })()`);

  // record a real 2 s WebM in the page and keep it as an unattached recording with markers
  const rec = await ev(`(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 240;
    const g = c.getContext('2d');
    const stream = c.captureStream(15);
    const mr = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = []; mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    let f = 0; const t = setInterval(() => { g.fillStyle = 'hsl(' + (f * 20) + ',70%,50%)'; g.fillRect(0, 0, 320, 240); g.fillStyle = '#fff'; g.fillText('frame ' + f++, 20, 120); }, 60);
    mr.start(250); await new Promise((r) => setTimeout(r, 2200)); mr.stop(); await new Promise((r) => (mr.onstop = r)); clearInterval(t);
    const blob = new Blob(chunks, { type: 'video/webm' });
    const R = await import('/js/lib/wirerun-recordings.js');
    const r = await R.saveRecording(kelbe.store, blob, { durationMs: 2200, mimeType: 'video/webm', source: 'ar-webxr', jobId: ${JSON.stringify(ids.job)}, runId: null, label: 'Hallway AR',
      markers: [{ atMs: 200, label: 'Start', segId: 'seg-a' }, { atMs: 1000, label: 'Point 2', segId: 'seg-a', legM: 2 }, { atMs: 1800, label: 'Point 3', segId: 'seg-b', legM: 3 }] });
    return { id: r.id, bytes: r.bytes, localId: r.localId };
  })()`);
  check('a recording made in the page is kept on the device', rec.bytes > 1000, `${rec.bytes} bytes`);

  await ev(`location.hash = '#/wireruns'`);
  await waitFor(`!!document.querySelector('.wr-job-filter')`);
  const filter = await ev(`document.querySelector('.wr-job-filter').value`);
  check('the runs list opens on the "Working on" job', filter === ids.job, filter);
  const names = await ev(`[...document.querySelectorAll('.wr-name')].map((n) => n.textContent)`);
  check('only the focused job runs are listed', names.includes('Video run') && (!ids.other || !names.includes('Other job run')), names.join(', '));
  check('the list links to videos on this device with a count', await ev(`[...document.querySelectorAll('a.btn')].some((a) => /Videos on this device \\(1\\)/.test(a.textContent))`));

  await ev(`location.hash = '#/wireruns/recordings'`);
  await waitFor(`!!document.querySelector('.wr-vid-name')`);
  await sleep(300); await shot('recordings-page');
  check('the recording is listed under Waiting to attach', await ev(`document.querySelector('.wr-vid-name').value === 'Hallway AR'`));
  check('storage use is shown', await ev(`/KB|MB/.test(document.querySelector('.wr-stats').textContent)`));
  await clickText('.wr-actions button', /Attach to a run/);
  await waitFor(`!!document.querySelector('.sheet .wr-dw-row')`);
  await clickText('.sheet .wr-dw-row', /Video run/);
  await sleep(600);
  check('attaching empties the waiting list', await ev(`(async () => (await import('/js/lib/wirerun-recordings.js')).listRecordings(kelbe.store).length === 0)()`));
  const vids = await ev(`kelbe.store.get('wireRuns', ${JSON.stringify(ids.runA)}).videos`);
  check('the run holds the video with its markers', vids.length === 1 && vids[0].markers.length === 3 && vids[0].localId === rec.localId, JSON.stringify(vids.map((v) => [v.status, v.markers.length])));
  check('with no server the upload stays queued, not failed', vids[0].status === 'local' || vids[0].status === 'uploading', vids[0].status);

  await ev(`location.hash = '#/wireruns/${ids.runA}'`);
  await waitFor(`!!document.querySelector('.wr-vid .wr-vid-play:not([disabled])')`);
  check('the run shows the video, playable from this device', await ev(`/on this device/.test(document.querySelector('.wr-vid').textContent) && /3 markers/.test(document.querySelector('.wr-vid').textContent)`));
  await ev(`document.querySelector('.wr-videos').scrollIntoView()`); await shot('run-videos');
  check('the record-while-measuring switch exists (hidden without AR)', await ev(`!!document.querySelector('.wr-rec-toggle')`));

  await ev(`document.querySelector('.wr-vid .wr-vid-play').click()`);
  await waitFor(`!!document.querySelector('.wr-review video')`);
  await waitFor(`document.querySelector('.wr-review video').readyState >= 1`, 8000);
  await sleep(300); await shot('recheck');
  check('the re-check overlay lists every marker', await ev(`document.querySelectorAll('.wr-review-mark').length === 3`));
  check('and the run measurements beside them', await ev(`document.querySelectorAll('.wr-review-segs li').length === 2`));
  await ev(`document.querySelectorAll('.wr-review-mark')[1].click()`);
  await sleep(500);
  const t = await ev(`document.querySelector('.wr-review video').currentTime`);
  check('tapping a marker jumps the video to it', Math.abs(t - 1.0) < 0.15, String(t));
  await waitFor(`!!document.querySelector('.wr-review-mark.on')`, 3000).catch(() => {});
  check('the segment of the marker is highlighted', await ev(`/Panel to box/.test(document.querySelector('.wr-review-segs li.on')?.textContent || '')`));
  await clickText('.wr-review-tools button', /Next point/);
  await sleep(500);
  const t2 = await ev(`document.querySelector('.wr-review video').currentTime`);
  check('Next point steps to the following marker', Math.abs(t2 - 1.8) < 0.15, String(t2));

  await clickText('.wr-review-tools button', /Measure on this frame/);
  await waitFor(`!!document.querySelector('.dialog')`);
  check('measuring a frame explains that AR cannot re-measure a still', await ev(`/no depth or tracking/.test(document.querySelector('.dialog').textContent)`));
  await clickText('.dialog button', /Set the scale/);
  await waitFor(`!!document.querySelector('.wr-trace canvas')`);
  check('the frame opens in the scale-and-trace measure, asking for a scale first', await waitFor(`/Set the scale/.test(document.querySelector('.wr-trace .wr-trace-total')?.textContent || '')`, 4000).catch(() => false));
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(200);
  check('closing the measure returns to the video', await ev(`!document.querySelector('.wr-trace') && !document.querySelector('.wr-review').classList.contains('wr-review-hidden')`));
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(200);
  check('Escape closes the re-check overlay', await ev(`!document.querySelector('.wr-review')`));

  await ev(`[...document.querySelectorAll('.wr-vid .wr-actions button')].find((b) => b.title === 'Remove video').click()`);
  await waitFor(`!!document.querySelector('.dialog')`);
  await clickText('.dialog button', /^Remove$/);
  await sleep(500);
  check('removing the video empties the card', await ev(`kelbe.store.get('wireRuns', ${JSON.stringify(ids.runA)}).videos.length === 0 && !document.querySelector('.wr-vid')`));
  check('and its bytes leave this device', await ev(`(async () => !(await (await import('/js/lib/local-blobs.js')).getBlob(${JSON.stringify(rec.localId)})))()`));

  // ---- the AR tape recording while it measures, through the iOS plugin's contract (stubbed) ----
  await ev(`(async () => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 240;
    const g = c.getContext('2d');
    const mr = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' });
    const chunks = []; mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    let f = 0; const t = setInterval(() => { g.fillStyle = 'hsl(' + (f++ * 25) + ',60%,50%)'; g.fillRect(0, 0, 320, 240); }, 60);
    mr.start(250); await new Promise((r) => setTimeout(r, 1500)); mr.stop(); await new Promise((r) => (mr.onstop = r)); clearInterval(t);
    const blob = new Blob(chunks, { type: 'video/webm' });
    window.__ar = { calls: [], discarded: [] };
    window.Capacitor = {
      convertFileSrc: (p) => p,
      Plugins: { FishtapeMeasure: {
        isAvailable: async () => ({ available: true }),
        measurePath: async (o) => {
          window.__ar.calls.push(o);
          return { totalM: 5, segments: [{ lengthM: 2 }, { lengthM: 3 }], points: [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 2, y: 3, z: 0 }],
            pointTimesMs: [150, 700, 1300], video: { path: URL.createObjectURL(blob), bytes: blob.size, durationMs: 1500, mimeType: 'video/webm' } };
        },
        discardRecording: async ({ path }) => { window.__ar.discarded.push(path); return {}; },
      } },
    };
    await (await import('/js/lib/ar-measure.js')).getArSupport({ refresh: true });
    localStorage.setItem('ft.wireruns.arTipsSeen', '1');
  })()`);
  await ev(`location.hash = '#/wireruns/${ids.runB}'`);
  await waitFor(`/AR ready/.test(document.querySelector('.wr-ar-note')?.textContent || '')`);
  check('with AR, the record switch shows and is on', await ev(`!document.querySelector('.wr-rec-toggle').hidden && document.querySelector('.wr-rec-toggle input').checked`));
  const arTape = () => clickText('.wr-add button', /AR tape/);

  await arTape();
  await waitFor(`!!document.querySelector('.dialog .wr-vid-choice')`);
  check('the plugin was asked to record', await ev(`window.__ar.calls.at(-1)?.record === true`));
  check('the plugin copy is deleted once read in', await ev(`window.__ar.discarded.length === 1`));
  await shot('confirm-ar-video');
  check('online and small: the default is to attach', await ev(`document.querySelector('.dialog .wr-vid-choice input[value="attach"]').checked`));
  await ev(`[...document.querySelectorAll('.dialog .field.check')].find((l) => /each leg/.test(l.textContent)).querySelector('input').click()`);
  await clickText('.dialog .sheet-foot button', /^Add$/);
  await sleep(700);
  const runB = await ev(`kelbe.store.get('wireRuns', ${JSON.stringify(ids.runB)})`);
  check('the legs became segments and the video was attached', runB.segments.length === 2 && runB.videos?.length === 1, `${runB.segments.length} segs, ${runB.videos?.length} videos`);
  const mk = runB.videos?.[0]?.markers || [];
  check('a marker per point, tied to the segment each leg became', mk.length === 3 && mk[1].segId === runB.segments[0].id && mk[2].segId === runB.segments[1].id && mk[2].atMs === 1300, JSON.stringify(mk.map((m) => m.atMs)));

  // offline: kept on the device, then attached later from the run
  await ev(`Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })`);
  await arTape();
  await waitFor(`!!document.querySelector('.dialog .wr-vid-choice')`);
  check('offline: the default is to keep it to attach later, and it says why', await ev(`document.querySelector('.dialog .wr-vid-choice input[value="keep"]').checked && /offline/i.test(document.querySelector('.dialog .wr-vid-choice').textContent)`));
  await clickText('.dialog .sheet-foot button', /^Add$/);
  await sleep(700);
  const waiting = await ev(`(async () => (await import('/js/lib/wirerun-recordings.js')).listRecordings(kelbe.store))()`);
  check('the kept video waits on the device with its markers', waiting.length === 1 && waiting[0].runId === ids.runB && waiting[0].markers.length === 3 && !!waiting[0].markers[0].segId);
  check('the run says a recording of it is waiting', await ev(`/1 recording of this run waiting/.test(document.querySelector('.wr-vid-store').textContent)`));
  await ev(`delete navigator.onLine`);
  await clickText('.wr-add button', /Attach a recording/);
  await waitFor(`!!document.querySelector('.sheet .wr-dw-row')`);
  await ev(`document.querySelector('.sheet .wr-dw-row').click()`);
  await sleep(600);
  check('attached later from the run', (await ev(`kelbe.store.get('wireRuns', ${JSON.stringify(ids.runB)}).videos.length`)) === 2);

  // discarding the measurement asks about its video
  await arTape();
  await waitFor(`!!document.querySelector('.dialog .wr-vid-choice')`);
  await clickText('.dialog .sheet-foot button', /^Discard$/);
  await waitFor(`/Keep the video/.test(document.querySelector('.dialog')?.textContent || '')`);
  await clickText('.dialog button', /Delete the video/);
  await sleep(400);
  const left = await ev(`(async () => (await import('/js/lib/wirerun-recordings.js')).listRecordings(kelbe.store).length)()`);
  const segsNow = await ev(`kelbe.store.get('wireRuns', ${JSON.stringify(ids.runB)}).segments.length`);
  check('a discarded measurement can drop its video too', left === 0 && segsNow === 3, `${left} recordings, ${segsNow} segments`);

  // deleting the run takes its videos' bytes with it
  const localIds = await ev(`kelbe.store.get('wireRuns', ${JSON.stringify(ids.runB)}).videos.map((v) => v.localId)`);
  await clickText('.page-head button', /Delete run/);
  await waitFor(`/2 videos/.test(document.querySelector('.dialog')?.textContent || '')`);
  await clickText('.dialog button', /^Delete$/);
  await sleep(800);
  check('deleting the run deletes its videos on this device', await ev(`(async () => { const B = await import('/js/lib/local-blobs.js'); for (const id of ${JSON.stringify(localIds)}) if (await B.getBlob(id)) return false; return true; })()`));
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
} catch (err) {
  check('run', false, err.stack);
} finally {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  cleanup();
  process.exit(failed ? 1 : 0);
}

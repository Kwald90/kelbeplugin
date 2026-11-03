// Records a site walkthrough: the phone's rear camera + mic to a single video, while letting you
// grab stills from the live frame as you go. Thin wrapper over getUserMedia + MediaRecorder with a
// canvas grab for stills. No import-time side effects — nothing touches the camera until start().
//
// Returns a controller the module drives; the module owns where the blob and stills are stored.
// Everything degrades: when recording isn't available the module falls back to adding photos.

export function recordingSupported() {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof window !== 'undefined'
    && typeof window.MediaRecorder === 'function';
}

/** Pick a mime type the browser can actually record; '' lets MediaRecorder choose its default. */
function pickMime() {
  const want = ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const MR = window.MediaRecorder;
  if (MR?.isTypeSupported) { for (const m of want) if (MR.isTypeSupported(m)) return m; }
  return '';
}

/**
 * Start a recording. Resolves to a controller:
 *   { previewEl, grabStill(maxBytes?) -> Promise<{dataUrl,width,height}>, stop() -> Promise<{blob,durationMs,mimeType}>,
 *     cancel(), elapsedMs() }
 * Rejects if the camera/mic can't be opened (permission denied, no device, unsupported).
 */
export async function startRecording({ facingMode = 'environment' } = {}) {
  if (!recordingSupported()) throw new Error('recording-unsupported');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: true,
  });

  const previewEl = document.createElement('video');
  previewEl.className = 'wt-rec-preview';
  previewEl.muted = true; previewEl.playsInline = true; previewEl.autoplay = true;
  previewEl.srcObject = stream;
  try { await previewEl.play(); } catch { /* autoplay may need a user gesture; the stream still records */ }

  const mimeType = pickMime();
  const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const startedAt = Date.now();
  rec.start(1000); // gather in 1s slices so a crash still leaves most of the clip

  const stopTracks = () => { for (const t of stream.getTracks()) { try { t.stop(); } catch { /* already stopped */ } } previewEl.srcObject = null; };

  async function grabStill(maxBytes = 300_000) {
    const vw = previewEl.videoWidth || 1280, vh = previewEl.videoHeight || 720;
    const scale = Math.min(1, Math.sqrt((1280 * 720) / (vw * vh)) || 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vw * scale));
    canvas.height = Math.max(1, Math.round(vh * scale));
    canvas.getContext('2d').drawImage(previewEl, 0, 0, canvas.width, canvas.height);
    let q = 0.82, dataUrl = canvas.toDataURL('image/jpeg', q);
    while (dataUrl.length * 0.75 > maxBytes && q > 0.3) { q -= 0.12; dataUrl = canvas.toDataURL('image/jpeg', q); }
    return { dataUrl, width: canvas.width, height: canvas.height };
  }

  function stop() {
    return new Promise((resolve) => {
      rec.onstop = () => { stopTracks(); resolve({ blob: new Blob(chunks, { type: rec.mimeType || mimeType || 'video/webm' }), durationMs: Date.now() - startedAt, mimeType: rec.mimeType || mimeType || 'video/webm' }); };
      try { rec.stop(); } catch { stopTracks(); resolve({ blob: new Blob(chunks), durationMs: Date.now() - startedAt, mimeType: mimeType || 'video/webm' }); }
    });
  }

  function cancel() { try { rec.stop(); } catch { /* ignore */ } stopTracks(); }

  return { previewEl, grabStill, stop, cancel, elapsedMs: () => Date.now() - startedAt, startedAt };
}

/** mm:ss from milliseconds, for the elapsed/duration readouts. */
export function fmtClock(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Turning a walkthrough's narration into text. Two paths, both optional:
//   1. Live on-device dictation (Web Speech API) while you record — free, private, no network.
//      Supported on desktop/Android Chrome; NOT in the iOS WebView, so it is offered only where it
//      actually works and the transcript is always editable by hand.
//   2. AI transcription of the recorded audio (Gemini) — needs a server endpoint holding the key
//      (HQ → Platform keys). Off until that endpoint exists; aiTranscriptionAvailable() is the one
//      place to switch it on so the UI and the wiring stay in step.
//
// No import-time side effects: nothing touches the mic or network until a function is called.

export function liveDictationSupported() {
  return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/**
 * Start live dictation. Calls onText(finalChunk) as each phrase settles and onInterim(text) for the
 * in-progress phrase. Returns { stop() }. Resolves nothing; errors are swallowed to onError.
 */
export function startLiveDictation({ lang = 'en-CA', onText, onInterim, onError } = {}) {
  if (!liveDictationSupported()) { onError?.(new Error('dictation-unsupported')); return { stop() {} }; }
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new Rec();
  rec.lang = lang; rec.continuous = true; rec.interimResults = true;
  let stopped = false;
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) onText?.(r[0].transcript.trim()); else interim += r[0].transcript;
    }
    if (interim) onInterim?.(interim.trim());
  };
  rec.onerror = (e) => onError?.(e.error ? new Error(String(e.error)) : new Error('dictation-error'));
  // keep it going through the natural pauses the engine ends on, until the caller stops
  rec.onend = () => { if (!stopped) { try { rec.start(); } catch { /* restart race */ } } };
  try { rec.start(); } catch (e) { onError?.(e); }
  return { stop() { stopped = true; try { rec.stop(); } catch { /* already stopped */ } } };
}

// Whether AI transcription is available is decided by the server (is a Gemini key set in HQ?).
// The walkthrough-media responses carry an `aiTranscription` flag; the walkthroughs module calls
// setAiTranscription() with it, and the UI gates the "Transcribe with AI" button on this.
let aiAvailable = false;

/** Record what the server reported about AI transcription availability. */
export function setAiTranscription(available) { aiAvailable = !!available; }

/** Whether AI transcription of a recorded clip is wired up and configured for this install. */
export function aiTranscriptionAvailable() {
  return aiAvailable;
}

/** Append a settled phrase to a transcript, spacing it sensibly. */
export function appendPhrase(transcript, phrase) {
  const t = String(transcript || '').trimEnd();
  const p = String(phrase || '').trim();
  if (!p) return t;
  const sep = !t ? '' : /[.!?]$/.test(t) ? ' ' : /[a-z0-9,]$/i.test(t) ? '. ' : ' ';
  return (t + sep + p.charAt(0).toUpperCase() + p.slice(1)).slice(0, 60000);
}

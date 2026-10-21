// On-device signatures (docs/releases/r1-get-paid.md 2.10, 4.1, 4.2): the full-screen sheet the
// customer signs on, and the signature record it produces (a money-free snapshot of what was
// signed, its canonical string and SHA-256, who, when and, when the company records it, where).
// No portal: the customer signs on the crew's phone or the office iPad, offline.
//
// buildSignature is pure (tests import it); signatureSheet loads the DOM pieces when it opens.
// The PWA writes the signature first and the document second, in the same tick, so the sync queue
// pushes them in that order (2.10).
import { snapshotOf, signedContent, digestHex, SNAPSHOT_VERSION } from './signing.js';
import { signerOnList } from './tickets.js';

const newId = (p) => `${p}-${globalThis.crypto?.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10)}`;

/** What every signing screen tells the signer before they sign (docs/compliance/privacy.md, PRV-07). */
export const SIGNING_NOTICE = 'Your name, signature, the time and the device\'s location (when recorded) are kept with this record. You can ask for a copy.';

/**
 * A signature record for a document. docType: 'estimate' | 'changeOrder' | 'fieldTicket' | 'ticketBatch'.
 * doc: the estimate, the change order (extra.jobId), the ticket, or { jobId, tickets } for a batch.
 * method 'email-reply' records an acceptance by email with `evidence` (no pad image).
 */
export async function buildSignature({ docType, doc, extra = {}, signerName, signerTitle = null, signerEmail = null, dataUrl = null, method = 'on-device',
  evidence = null, loc = null, locStatus = null, capturedBy = null, device = null, id = null, signedAt = null, jobId = null, clientId = null } = {}) {
  const snapshot = snapshotOf(docType, doc, extra, SNAPSHOT_VERSION);
  const digest = await digestHex(signedContent(snapshot));
  const docIds = docType === 'ticketBatch' ? (doc.tickets || []).map((t) => t.id) : undefined;
  const docId = docType === 'ticketBatch' ? (doc.id || newId('batch')) : docType === 'changeOrder' ? doc.id : doc.id;
  return {
    id: id || newId('sig'), v: SNAPSHOT_VERSION, docType, docId, ...(docIds ? { docIds } : {}),
    jobId: jobId ?? extra.jobId ?? doc.jobId ?? null, clientId: clientId ?? doc.clientId ?? null,
    ...(docType === 'changeOrder' ? { changeOrderId: doc.id } : {}),
    signerName: String(signerName || '').trim().slice(0, 120), signerTitle: signerTitle ? String(signerTitle).slice(0, 120) : null,
    signerEmail: signerEmail ? String(signerEmail).trim().slice(0, 254) : null, method,
    ...(method === 'on-device' ? { dataUrl } : { evidence }),
    signedAt: signedAt || new Date().toISOString(), ...(loc ? { loc } : {}), ...(locStatus ? { locStatus } : {}),
    capturedBy: capturedBy || { name: 'Unknown' }, ...(device ? { device: String(device).slice(0, 120) } : {}),
    snapshot, digest, status: 'valid',
  };
}

/**
 * Make sure the sync queue pushes the signature before the document that points at it (2.10). The
 * queue coalesces a burst of edits into the record's earlier unsent mutation, which keeps its place:
 * a document edited before it was signed would otherwise go first and be refused (signature_invalid).
 * Moves the signature's unsent mutation just ahead of each unsent mutation of the documents.
 * docs: [{ coll, id }]. Works on the live queue (store.queue) and its persisted order (seq).
 */
export function queueSignatureFirst(store, signatureId, docs = []) {
  const q = store?.queue;
  if (!Array.isArray(q)) return false;
  let moved = false;
  for (const { coll, id } of docs) {
    const sigIdx = q.findIndex((e) => e.collection === 'signatures' && e.id === signatureId && !e.sent);
    const docIdx = q.findIndex((e) => e.collection === coll && e.id === id && !e.sent && e.state !== 'rejected');
    if (sigIdx < 0 || docIdx < 0 || sigIdx < docIdx) continue;
    const [s] = q.splice(sigIdx, 1);
    const doc = q[docIdx];
    const prev = q[docIdx - 1];
    s.seq = ((prev?.seq ?? (Number(doc.seq) - 1)) + Number(doc.seq)) / 2;
    q.splice(docIdx, 0, s);
    store.putQueue(s);
    moved = true;
  }
  return moved;
}

/** A location fix for the signature when the company records it (settings.tickets.captureLocation). */
export function locationFix({ timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const geo = globalThis.navigator?.geolocation;
    if (!geo) { resolve({ loc: null, locStatus: 'unavailable' }); return; }
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish({ loc: null, locStatus: 'timeout' }), timeoutMs + 500);
    geo.getCurrentPosition(
      (p) => finish({ loc: { lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy || 0), at: new Date(p.timestamp || Date.now()).toISOString() }, locStatus: 'ok' }),
      (e) => finish({ loc: null, locStatus: e?.code === 1 ? 'denied' : 'unavailable' }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60000 });
  });
}

/**
 * The signing sheet: summary (no money unless the caller puts it there), agreement text, signer name
 * and title, the pad. signers: the job's authorized signers (a warning, never a block, when the name
 * is not on the list). onSigned({ signerName, signerTitle, signerEmail, dataUrl, loc, locStatus })
 * resolves the sheet; returning false keeps it open.
 */
export async function signatureSheet(ui, { title = 'Sign', summary = null, agreementText = '', job = null, captureLocation = false, askEmail = false, onSigned, onRefused = null, refuseLabel = null }) {
  const { signaturePad } = await import('./safety-capture.js');
  const { h } = ui;
  const name = h('input', { class: 'input', name: 'signerName', autocomplete: 'name', placeholder: 'Full name', required: true });
  const role = h('input', { class: 'input', name: 'signerTitle', placeholder: 'e.g. Site superintendent' });
  const email = askEmail ? h('input', { class: 'input', name: 'signerEmail', type: 'email', placeholder: 'For a copy (optional)' }) : null;
  const warn = h('div', { class: 'es-warn', role: 'status' });
  const checkName = () => {
    ui.clear(warn);
    const on = signerOnList(job, name.value);
    if (on === false && name.value.trim()) warn.append(ui.icon('alert', 16), ' Not on the general contractor\'s list of signers. You can still take the signature.');
  };
  name.addEventListener('input', checkName);
  const pad = signaturePad({ label: 'Sign here', onChange: () => {} });
  let busy = false;
  const body = h('div', { class: 'es-sheet stack' },
    summary ? h('div', { class: 'es-summary' }, summary) : null,
    agreementText ? h('p', { class: 'es-agree' }, agreementText) : null,
    h('div', { class: 'form-grid' },
      h('label', { class: 'field' }, h('span', null, 'Name *'), name),
      h('label', { class: 'field' }, h('span', null, 'Title'), role),
      email ? h('label', { class: 'field span-2' }, h('span', null, 'Email for a copy'), email) : null),
    warn, pad.el,
    h('p', { class: 'muted es-notice' }, SIGNING_NOTICE, captureLocation ? ' Location recorded with the signature.' : ''));
  const submit = async () => {
    if (busy) return;
    if (!name.value.trim()) { ui.toast('Enter the signer\'s name', 'error'); name.focus(); return; }
    const dataUrl = pad.toDataUrl();
    if (!dataUrl) { ui.toast('Sign in the box first', 'error'); return; }
    busy = true;
    try {
      const fix = captureLocation ? await locationFix() : { loc: null, locStatus: null };
      const r = await onSigned({ signerName: name.value.trim(), signerTitle: role.value.trim() || null, signerEmail: email?.value.trim() || null, dataUrl, ...fix });
      if (r !== false) sheet.close();
    } finally { busy = false; }
  };
  const sheet = ui.openSheet({
    title, wide: true, body,
    actions: [
      onRefused ? ui.button(refuseLabel || 'Customer won\'t sign', { variant: 'ghost danger', onClick: async () => { if ((await onRefused({ by: name.value.trim() || null })) !== false) sheet.close(); } }) : null,
      h('span', { class: 'grow' }),
      ui.button('Cancel', { variant: 'ghost', onClick: () => sheet.close() }),
      ui.button('Sign', { variant: 'primary', icon: 'pen', onClick: submit }),
    ].filter(Boolean),
  });
  sheet.el.classList.add('es-full');
  return sheet;
}

/**
 * "Customer accepted by email" (office): a photo or screenshot of the reply as evidence. Resolves to
 * { signerName, signerEmail, evidence } or null.
 */
export async function emailAcceptanceSheet(ui, { title = 'Customer accepted by email' } = {}) {
  const { pickImages, downscaleImage } = await import('./safety-capture.js');
  const { h } = ui;
  return new Promise((resolve) => {
    let evidence = null;
    let answered = false;
    const preview = h('div', { class: 'es-evidence' }, h('span', { class: 'muted' }, 'No picture of the reply yet.'));
    const name = h('input', { class: 'input', name: 'signerName', placeholder: 'Who replied' });
    const from = h('input', { class: 'input', name: 'from', type: 'email', placeholder: 'Their email address' });
    const received = h('input', { class: 'input', name: 'receivedAt', type: 'date', value: new Date().toISOString().slice(0, 10) });
    const pick = async () => {
      const [f] = await pickImages({ multiple: false });
      if (!f) return;
      try {
        const p = await downscaleImage(f, 300 * 1024);
        evidence = p.dataUrl;
        ui.clear(preview).append(h('img', { src: evidence, alt: 'The reply' }));
      } catch { ui.toast('Could not read that picture', 'error'); }
    };
    const sheet = ui.openSheet({
      title, body: h('div', { class: 'stack' },
        h('p', { class: 'muted' }, 'Take a photo or screenshot of the customer\'s reply. It is kept as the acceptance.'),
        h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', null, 'Name'), name), h('label', { class: 'field' }, h('span', null, 'Email'), from),
          h('label', { class: 'field' }, h('span', null, 'Received on'), received)),
        ui.button('Add the picture of the reply', { icon: 'camera', onClick: pick }), preview),
      actions: [h('span', { class: 'grow' }), ui.button('Cancel', { variant: 'ghost', onClick: () => sheet.close() }), ui.button('Record acceptance', { variant: 'primary', onClick: () => {
        if (!evidence) { ui.toast('Add the picture of the reply first', 'error'); return; }
        if (!name.value.trim()) { ui.toast('Enter who replied', 'error'); return; }
        answered = true;
        resolve({ signerName: name.value.trim(), signerEmail: from.value.trim() || null, evidence: { dataUrl: evidence, receivedAt: received.value || null, from: from.value.trim() || null } });
        sheet.close();
      } })],
      onClose: () => { if (!answered) resolve(null); },
    });
  });
}

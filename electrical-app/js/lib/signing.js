// Signatures and their digests (docs/releases/r1-get-paid.md 2.10). A signature record keeps a
// small snapshot of what the customer saw (no photos, no data URLs), a canonical string of it and
// its SHA-256, so a later edit of the document can be told apart from what was signed.
//
// Snapshots are versioned: every snapshot carries `v`, and the server keeps the builder of every
// shipped version, so a signature taken by an old service worker still verifies after a newer
// version ships. A mismatch never rejects a signature: the server stores it 'unverified' and tells
// the office. Pure (no DOM); digestHex uses crypto.subtle (the server uses node:crypto).
import { docTotals } from './money.js';

export const SNAPSHOT_VERSION = 1;

export const SIGNATURE_DOC_TYPES = ['estimate', 'changeOrder', 'fieldTicket', 'ticketBatch'];

/**
 * Keys of a document frozen once it carries a valid signature. Every key snapshotOf reads is here
 * (the test builds a snapshot from these keys only and compares it with the full one).
 */
export const SIGNED_KEYS = {
  estimates: ['number', 'issueDate', 'lines', 'taxes', 'taxTreatment', 'taxProvince', 'taxNoneReason', 'markupPct', 'title', 'notes', 'validUntil', 'clientId', 'jobId', 'taxPct'],
  changeOrder: ['title', 'lines', 'amountCents'],
  fieldTickets: ['jobId', 'clientId', 'kind', 'date', 'title', 'description', 'requestedBy', 'pricingBasis', 'rateSheetRef', 'labour', 'materials', 'equipment', 'photos', 'agreementText'],
};

const s = (v, max) => (v == null ? null : String(v).normalize('NFC').slice(0, max ?? 4000));
const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const arr = (v) => (Array.isArray(v) ? v : []);

function ticketV1(t) {
  return {
    v: 1, docType: 'fieldTicket', id: s(t.id, 128), jobId: s(t.jobId, 128), kind: s(t.kind, 20), date: s(t.date, 10),
    title: s(t.title, 200), description: s(t.description, 4000), requestedBy: s(t.requestedBy, 120),
    pricingBasis: s(t.pricingBasis, 40), rateSheetRef: s(t.rateSheetRef, 120),
    labour: arr(t.labour).slice(0, 50).map((l) => ({ name: s(l?.name, 120), hours: n(l?.hours) })),
    materials: arr(t.materials).slice(0, 100).map((m) => ({ description: s(m?.description, 300), qty: n(m?.qty), unit: s(m?.unit, 30) })),
    equipment: arr(t.equipment).slice(0, 20).map((e) => ({ description: s(e?.description, 300), qty: n(e?.qty), unit: s(e?.unit, 10) })),
    photoIds: arr(t.photos).slice(0, 4).map((p) => s(p?.id, 128)),
    agreementText: s(t.agreementText, 2000),
  };
}

/** Builders per snapshot version. Never change a shipped version: add the next one. */
export const SNAPSHOT_BUILDERS = {
  1: {
    estimate(doc, extra = {}) {
      const totals = extra.totalCents != null && extra.taxCents != null ? extra : docTotals(doc);
      return {
        v: 1, docType: 'estimate', id: s(doc.id, 128), number: s(doc.number, 40), clientId: s(doc.clientId, 128), jobId: s(doc.jobId, 128),
        title: s(doc.title, 300), issueDate: s(doc.issueDate, 10), validUntil: s(doc.validUntil, 10),
        totalCents: n(totals.totalCents), taxCents: n(totals.taxCents),
        lines: arr(doc.lines).slice(0, 200).map((l) => ({ description: s(l?.description, 1000), qty: n(l?.qty) })),
        notes: s(doc.notes, 2000),
      };
    },
    changeOrder(co, extra = {}) {
      return {
        v: 1, docType: 'changeOrder', jobId: s(extra.jobId ?? co.jobId, 128), changeOrderId: s(co.id, 128), title: s(co.title, 300),
        amountCents: n(co.amountCents), lines: arr(co.lines).slice(0, 200).map((l) => ({ description: s(l?.description, 1000), qty: n(l?.qty) })),
      };
    },
    fieldTicket: (t) => ticketV1(t),
    ticketBatch(batch) {
      return { v: 1, docType: 'ticketBatch', jobId: s(batch.jobId, 128), tickets: arr(batch.tickets).slice(0, 30).map(ticketV1) };
    },
  },
};

/**
 * What the customer saw, as a small object in the given version's shape.
 * estimate: the estimate (totals from money.js unless extra gives totalCents and taxCents);
 * changeOrder: the change order, extra.jobId; fieldTicket: the ticket; ticketBatch: { jobId, tickets }.
 */
export function snapshotOf(docType, doc, extra = {}, v = SNAPSHOT_VERSION) {
  const b = SNAPSHOT_BUILDERS[v]?.[docType];
  if (!b) throw new Error(`No snapshot version ${v} for ${docType}`);
  return b(doc || {}, extra);
}

/** Numbers in the canonical string: integers as they are, others to 6 decimals without trailing zeros. */
function num(x) {
  if (Number.isInteger(x)) return String(x);
  const r = Math.round(x * 1e6) / 1e6;
  return Number.isInteger(r) ? String(r) : String(r);
}

/** Canonical string: keys sorted, strings NFC, numbers normalised, no whitespace, undefined dropped. */
export function signedContent(snapshot) {
  const c = (v) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return Number.isFinite(v) ? num(v) : 'null';
    if (typeof v === 'string') return JSON.stringify(v.normalize('NFC'));
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) return `[${v.map(c).join(',')}]`;
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k.normalize('NFC'))}:${c(v[k])}`).join(',')}}`;
  };
  return c(snapshot);
}

/** Hex SHA-256 of a string (crypto.subtle, in the browser and in Node 22). */
export async function digestHex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Rebuild a snapshot in the version a signature used (null when that version or type is unknown). */
export function snapshotLike(signature, doc, extra = {}) {
  const v = Number(signature?.snapshot?.v ?? signature?.v);
  const type = signature?.docType;
  if (!SNAPSHOT_BUILDERS[v]?.[type]) return null;
  return snapshotOf(type, doc, extra, v);
}

/** Do two snapshots say the same thing? */
export const sameSnapshot = (a, b) => signedContent(a) === signedContent(b);

/** Does the signature cover this document id (a batch covers each of its tickets)? */
export function signatureCovers(signature, docId) {
  if (!signature || !docId) return false;
  if (signature.docType === 'ticketBatch') return Array.isArray(signature.docIds) && signature.docIds.includes(docId);
  return signature.docId === docId;
}

/** A signature's money-free copy for readers without money: every *Cents key in the snapshot goes. */
export function snapshotWithoutMoney(snapshot) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !/Cents$/.test(k)).map(([k, x]) => [k, strip(x)]));
    return v;
  };
  return strip(snapshot);
}

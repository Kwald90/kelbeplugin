// Online booking (resi service-shop front door): the pure, DOM-free config shape + helpers shared
// by the "Booking setup" screen (modules/servicerequests.js). A service request itself is a lead
// tagged kind:'service' (lib/service-requests.js); this module is only about the shop's embeddable
// booking FORM: which service types it offers, which intake fields it asks for, the confirmation
// message, its contact, and the hosted link + iframe snippet it hands to its own website.
// The shape here mirrors server/src/services/booking.js publicBookingConfig. Unit-tested; no imports
// beyond the shared service-type/urgency lists.
import { SERVICE_TYPES, URGENCY } from './service-requests.js';

/** Optional intake fields the shop can switch off (name/phone/service type are always asked). */
export const OPTIONAL_FIELDS = [
  { id: 'email', label: 'Email' },
  { id: 'urgency', label: 'How soon?' },
  { id: 'address', label: 'Service address' },
  { id: 'preferredTimes', label: 'Preferred times' },
];

/** The booking config kept in settings.booking. A new shop offers every type and every field. */
export const DEFAULT_BOOKING = {
  businessName: '',
  intro: '',
  serviceTypes: SERVICE_TYPES.map((t) => t.id),
  fields: { email: true, urgency: true, address: true, preferredTimes: true },
  confirmation: 'Thanks — we have your request and will be in touch shortly.',
  contactPhone: '',
  contactEmail: '',
};

const clean = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));

/** A settings.booking value cleaned to the known shape: capped strings, bounded id lists. */
export function normalizeBooking(raw = {}) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const ids = new Set(SERVICE_TYPES.map((t) => t.id));
  const picked = Array.isArray(b.serviceTypes) ? b.serviceTypes.filter((id) => ids.has(id)) : null;
  const fieldsRaw = b.fields && typeof b.fields === 'object' ? b.fields : {};
  const fields = {};
  for (const f of OPTIONAL_FIELDS) fields[f.id] = fieldsRaw[f.id] !== false; // on unless explicitly off
  return {
    businessName: clean(b.businessName, 120),
    intro: clean(b.intro, 600),
    serviceTypes: picked && picked.length ? picked : SERVICE_TYPES.map((t) => t.id),
    fields,
    confirmation: clean(b.confirmation, 600) || DEFAULT_BOOKING.confirmation,
    contactPhone: clean(b.contactPhone, 40),
    contactEmail: clean(b.contactEmail, 254),
  };
}

/** The service types the shop offers, in canonical order, as {id,label}. */
export function offeredServiceTypes(booking) {
  const picked = new Set(normalizeBooking(booking).serviceTypes);
  return SERVICE_TYPES.filter((t) => picked.has(t.id));
}

/** All urgency options, as {id,label} (for the setup preview). */
export const urgencyOptions = () => URGENCY.map((u) => ({ id: u.id, label: u.label }));

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
/** null when ok, else a human reason. Mirrors the server (2-63 chars, lower-case, dashes). */
export function slugProblem(slug) {
  if (!slug) return 'Choose a web address for your booking page.';
  if (!SLUG_RE.test(slug)) return 'Use 2–63 characters: lower-case letters, numbers and dashes.';
  return null;
}
export const validSlug = (slug) => slugProblem(slug) === null;

/** Suggest a slug from a company name: lower-case, dashes, trimmed to the allowed shape. */
export function suggestSlug(name) {
  const s = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  return validSlug(s) ? s : '';
}

const origin = (o) => String(o || '').replace(/\/+$/, '');

/** The hosted booking page URL a shop can share directly. */
export function hostedLink(appOrigin, slug) {
  return `${origin(appOrigin)}/api/v1/public/book/${encodeURIComponent(slug)}/embed`;
}

/** The iframe snippet a shop pastes on its own website. */
export function embedSnippet(appOrigin, slug) {
  const src = hostedLink(appOrigin, slug);
  // The iframe markup is copy-paste text for the SHOP's own website (shown in a readonly textarea
  // as text, never inserted into this app's DOM), so the app CSP's style-src-attr never applies.
  return `<iframe src="${src}" title="Book a service call" width="100%" height="760" style="border:0;max-width:600px" loading="lazy"></iframe>`; // csp-ok: copy-paste text for the shop's own site, not app DOM
}

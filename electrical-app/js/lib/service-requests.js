// Inbound service requests (resi service-shop front door). A service request is NOT a new collection:
// it is a `leads` record tagged `kind: 'service'` so it rides the existing sales pipeline (one inbox,
// one board, the Won→create-job path already built in modules/leads.js). This module is the pure,
// DOM-free shape + helpers shared by the public booking page (which builds the payload) and the
// office "Service requests" inbox (which filters and sorts leads). Unit-tested; no imports.

/** What the customer needs done. Keep ids stable — they tag the lead and drive the inbox filter. */
export const SERVICE_TYPES = [
  { id: 'repair', label: 'Repair / troubleshooting' },
  { id: 'panel', label: 'Panel or service upgrade' },
  { id: 'outlets', label: 'Outlets, switches & devices' },
  { id: 'lighting', label: 'Lighting' },
  { id: 'ev', label: 'EV charger' },
  { id: 'generator', label: 'Generator / backup power' },
  { id: 'inspection', label: 'Inspection / safety check' },
  { id: 'reno', label: 'Renovation / new wiring' },
  { id: 'other', label: 'Something else' },
];

/** How soon, most urgent first. `rank` sorts the inbox; `sla` is a hint for the office, not a promise. */
export const URGENCY = [
  { id: 'emergency', label: 'Emergency — no power / unsafe', rank: 0 },
  { id: 'urgent', label: 'Urgent — within a day or two', rank: 1 },
  { id: 'soon', label: 'Soon — this week', rank: 2 },
  { id: 'flexible', label: 'Flexible — whenever works', rank: 3 },
];

const byId = (list, id, fallback) => list.find((x) => x.id === id) || fallback || null;

export const serviceTypeLabel = (id) => byId(SERVICE_TYPES, id)?.label || 'Service';
export const urgencyLabel = (id) => byId(URGENCY, id)?.label || '';
export const urgencyRank = (id) => (byId(URGENCY, id)?.rank ?? URGENCY.length);

/** True when a lead came in as a service request (so the inbox and the board can tell them apart). */
export const isServiceLead = (lead) => lead?.kind === 'service';

const clean = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));

/**
 * Build a pipeline-ready lead from a booking/intake form. Returns a plain object (no id/createdAt —
 * store.add() assigns those) tagged kind:'service' and entering at the first stage ('new'). Unknown
 * service types fall back to 'other'; a blank urgency becomes 'flexible'. The title is human-readable
 * so it reads well on the Leads board without any service-aware rendering.
 * @param {{contactName?,phone?,email?,address?,serviceType?,description?,urgency?,preferredTimes?,source?}} input
 */
export function newServiceRequest(input = {}) {
  const serviceType = byId(SERVICE_TYPES, input.serviceType) ? input.serviceType : 'other';
  const urgency = byId(URGENCY, input.urgency) ? input.urgency : 'flexible';
  const contactName = clean(input.contactName, 200);
  return {
    kind: 'service',
    stage: 'new',
    source: clean(input.source, 100) || 'booking',
    title: `${serviceTypeLabel(serviceType)}${contactName ? ` — ${contactName}` : ''}`,
    contactName,
    phone: clean(input.phone, 40),
    email: clean(input.email, 254),
    serviceType,
    urgency,
    serviceAddress: clean(input.address, 300),
    preferredTimes: clean(input.preferredTimes, 300),
    notes: clean(input.description, 20000),
  };
}

/** Open service-request leads, most urgent first, then newest — what the office inbox shows. */
export function serviceInbox(leads = []) {
  return leads
    .filter((l) => isServiceLead(l) && l.stage !== 'won' && l.stage !== 'lost')
    .sort((a, b) => urgencyRank(a.urgency) - urgencyRank(b.urgency)
      || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/** A one-line summary for a request row/notification. */
export function summarizeRequest(lead) {
  const parts = [serviceTypeLabel(lead?.serviceType)];
  if (lead?.urgency && lead.urgency !== 'flexible') parts.push(urgencyLabel(lead.urgency).split(' — ')[0]);
  if (lead?.serviceAddress) parts.push(lead.serviceAddress);
  return parts.filter(Boolean).join(' · ');
}

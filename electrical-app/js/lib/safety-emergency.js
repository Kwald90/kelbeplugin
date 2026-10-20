// The emergency card for a job: nearest hospital, muster point, first aiders, contacts and
// site hazards. Shown at the top of the job (modules/jobs.js), on the Safety "Today" view,
// and meant for My Day (work plans) too:
//
//   import { emergencyCard } from '../lib/safety-emergency.js';
//   const card = emergencyCard({ store, ui }, jobId);   // null when the job has no info
//   if (card) root.prepend(card);
import { hasEmergencyInfo, jobSafetyId } from './safety.js';

const ICON_CROSS = '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/>';

/** The jobSafety record of a job, or null. */
export const jobSafetyOf = (store, jobId) => (jobId ? store.get('jobSafety', jobSafetyId(jobId)) : null);

/**
 * emergencyCard({ store, ui }, jobId, { compact }) -> element | null
 * Phone numbers are tel: links and the hospital address opens maps.
 */
export function emergencyCard({ store, ui }, jobId, { compact = false, editHref = null } = {}) {
  const js = jobSafetyOf(store, jobId);
  if (!hasEmergencyInfo(js)) return null;
  const { h } = ui;
  const job = store.get('jobs', jobId);
  const tel = (n) => (n ? h('a', { href: 'tel:' + String(n).replace(/[^0-9+]/g, '') }, n) : null);
  const firstAiders = (js.firstAiders || []).map((id) => store.get('employees', id)).filter(Boolean);
  const hosp = js.hospital || {};
  const line = (label, ...value) => (value.flat(Infinity).some((v) => v) ? h('div', { class: 'sf-em-line' }, h('span', { class: 'sf-em-label' }, label), h('span', null, ...value)) : null);
  return h('section', { class: ['sf-emergency', compact ? 'compact' : null], 'aria-label': 'Emergency information' },
    h('div', { class: 'sf-em-head' }, ui.icon(ICON_CROSS, 18), h('strong', null, 'Emergency'), job && compact ? h('span', { class: 'muted' }, ` · ${job.number || ''} ${job.title || ''}`) : null,
      h('span', { class: 'grow' }), h('a', { class: 'sf-em-911', href: 'tel:911' }, 'Call 911'),
      editHref ? h('a', { class: 'sf-em-edit', href: editHref }, 'Edit') : null),
    h('div', { class: 'sf-em-grid' },
      line('Hospital', hosp.name || '', hosp.address ? [' · ', h('a', { href: 'https://maps.apple.com/?q=' + encodeURIComponent(hosp.address), target: '_blank', rel: 'noopener' }, hosp.address)] : null, hosp.phone ? [' · ', tel(hosp.phone)] : null),
      line('Muster point', js.musterPoint || ''),
      line('First aiders', firstAiders.map((e, i) => [i ? ', ' : '', e.name, e.phone ? [' ', tel(e.phone)] : null])),
      line('First aid / AED', [js.firstAidKit, js.aed && `AED: ${js.aed}`].filter(Boolean).join(' · ')),
      line('Extinguisher', js.extinguisher || ''),
      (js.emergencyContacts || []).length ? line('Contacts', js.emergencyContacts.map((c, i) => [i ? ' · ' : '', `${c.name}${c.role ? ` (${c.role})` : ''} `, tel(c.phone)])) : null,
      !compact && (js.siteHazards || []).length ? line('Site hazards', js.siteHazards.join(' · ')) : null));
}

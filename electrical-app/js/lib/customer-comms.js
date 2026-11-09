// Customer-facing emails for the residential-service lane: an "on the way" (ETA) note when a tech
// enters the time-clock TRAVEL state for a job with a customer, and a short "how did we do?" review
// ask when a job is closed (status complete/invoiced). Both are OFF by default and configured under
// settings.notifications (see store.js DEFAULT_SETTINGS). This module is pure (no DOM, no network, no
// store): the Settings screen uses it to render the preferences, and the server
// (services/customer-comms.js) uses the same code to decide when to fire and to build the message, so
// the two can never drift. The outbox sender escapes everything into HTML, so bodies are plain text.

/** Job statuses that count as "closed" for the review ask. */
export const DONE_STATUSES = new Set(['complete', 'invoiced']);
const isDone = (status) => DONE_STATUSES.has(String(status || '').toLowerCase());

/** A trimmed http(s) URL, or '' (nothing else is a link; guards against javascript: and the like). */
export function cleanUrl(url) {
  const s = String(url || '').trim();
  if (!s || !/^https?:\/\//i.test(s)) return '';
  return s.slice(0, 500);
}

/** Normalise settings.notifications into a predictable shape with safe defaults. */
export function commsSettings(settings) {
  const n = (settings && settings.notifications) || {};
  const eta = n.eta || {};
  const review = n.review || {};
  return {
    eta: { on: eta.on === true, message: String(eta.message || '').slice(0, 2000) },
    review: { on: review.on === true, url: cleanUrl(review.url), message: String(review.message || '').slice(0, 2000) },
    replyTo: String(n.replyTo || '').trim().slice(0, 254),
  };
}

/**
 * Should an ETA email fire for this time-entry write? True only on the transition INTO the TRAVEL
 * state (a fresh travel entry, or a work entry switched to travel) for a known destination job, so a
 * later location-fix update on the same entry never re-sends.
 * @param {object|null} before @param {object|null} after
 */
export function shouldSendEta(before, after) {
  if (!after || after.kind !== 'travel' || !after.jobId) return false;
  return !before || before.kind !== 'travel';
}

/**
 * Should a review email fire for this job write? True only on the transition INTO a closed status
 * (complete/invoiced), so re-saving a closed job never re-sends.
 * @param {object|null} before @param {object|null} after
 */
export function shouldSendReview(before, after) {
  if (!after || !isDone(after.status)) return false;
  return !before || !isDone(before.status);
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const jobLabel = (job) => [job && job.number, job && job.title].filter(Boolean).join(' - ') || 'your job';
const signOff = (company) => `- ${String(company && company.name ? company.name : 'your electrician')}${company && company.phone ? ` | ${company.phone}` : ''}`;

/**
 * The "on the way" email. A custom message, when set, replaces the default body.
 * @returns {{ subject: string, body: string }}
 */
export function etaEmail({ company = {}, tech = {}, job = {}, customerName = '', message = '' } = {}) {
  const co = String(company.name || 'your electrician');
  const who = firstName(tech.name) || 'Your technician';
  const subject = `On the way${job.number ? ` for ${job.number}` : ''} - ${co}`.slice(0, 200);
  const hi = customerName ? `Hi ${firstName(customerName)},` : 'Hi,';
  const custom = String(message || '').trim();
  const lines = custom
    ? [hi, '', custom, '', signOff(company)]
    : [hi, '', `${who} from ${co} is on the way${job.title ? ` for ${jobLabel(job)}` : ''}.`, '', 'See you soon.', '', signOff(company)];
  return { subject, body: lines.join('\n') };
}

/**
 * The "how did we do?" review ask. The review URL is appended when it is a valid http(s) link.
 * @returns {{ subject: string, body: string }}
 */
export function reviewEmail({ company = {}, job = {}, customerName = '', reviewUrl = '', message = '' } = {}) {
  const co = String(company.name || 'your electrician');
  const subject = `How did we do? - ${co}`.slice(0, 200);
  const hi = customerName ? `Hi ${firstName(customerName)},` : 'Hi,';
  const url = cleanUrl(reviewUrl);
  const custom = String(message || '').trim();
  const lines = custom
    ? [hi, '', custom, ...(url ? ['', `Leave a review: ${url}`] : []), '', signOff(company)]
    : [hi, '', `Thanks for choosing ${co}${job.title ? ` for ${jobLabel(job)}` : ''}. We hope everything went well.`, '',
      ...(url ? ["If you have a minute, we'd really appreciate a quick review:", url, ''] : []),
      'Thanks again,', signOff(company)];
  return { subject, body: lines.join('\n') };
}

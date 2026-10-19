// Leads arriving from Facebook: create the leads record and, when the company picked a
// sequence, enrol the lead and queue the steps due right away (speed to lead matters).
// Later steps are queued by the PWA's processSequences (modules/sequences.js) as before.
// Because the enrolment is created with those first steps already counted, no device can
// queue them a second time.
import { ID_RE } from '../services/records.js';
import { companySettings } from './payments.js';

const DAY = 86400000;

/** Same merge fields as the PWA (modules/sequences.js mergeFields). */
export function mergeFields(text, lead, client, companyName) {
  const name = (lead.contactName || client?.name || 'there').split(/\s+/)[0];
  return String(text || '').replace(/\{\{\s*name\s*\}\}/gi, name).replace(/\{\{\s*fullname\s*\}\}/gi, lead.contactName || client?.name || '')
    .replace(/\{\{\s*company\s*\}\}/gi, companyName || '').replace(/\{\{\s*job\s*\}\}/gi, lead.title || '');
}

/**
 * Outbox messages for every step of a new enrolment that is due at `now`, and the step
 * index to store. Mirrors processSequences for one enrolment.
 */
export function dueSteps(enrolment, sequence, lead, client, companyName, now) {
  const out = [];
  const steps = sequence?.steps || [];
  if (!sequence?.active) return { messages: out, stepIndex: enrolment.stepIndex || 0, status: 'active' };
  let i = enrolment.stepIndex || 0;
  const start = new Date(enrolment.startedAt).getTime();
  while (i < steps.length && start + (Number(steps[i]?.dayOffset) || 0) * DAY <= now.getTime()) {
    const step = steps[i];
    const to = step.channel === 'email' ? (lead.email || client?.email || '') : step.channel === 'sms' ? (lead.phone || client?.phone || '') : '';
    out.push({
      channel: step.channel, to, subject: mergeFields(step.subject, lead, client, companyName), body: mergeFields(step.body, lead, client, companyName),
      relatedId: lead.id, status: 'queued', dueAt: new Date(start + (Number(step.dayOffset) || 0) * DAY).toISOString(),
    });
    i++;
  }
  return { messages: out, stepIndex: i, status: i >= steps.length ? 'done' : 'active' };
}

/**
 * Create a lead from Facebook (id fb-<leadgen id>, so a second delivery is a no-op) and enrol it.
 * @returns {Promise<{ created: boolean, leadId: string, enrolled: boolean, queued: number }>}
 */
export async function createFacebookLead(tx, records, p, who, mapped, { sequenceId = null, now = new Date() } = {}) {
  const leadId = `fb-${mapped.facebook.leadId}`;
  if (!ID_RE.test(leadId)) throw new Error('bad facebook lead id');
  const exists = await tx.query('SELECT 1 FROM leads WHERE tenant_id = $1 AND id = $2', [tx.tenantId, leadId]);
  if (exists.rows.length) return { created: false, leadId, enrolled: false, queued: 0 };
  const today = now.toISOString().slice(0, 10);
  const lead = await records.createRecord(tx, p, 'leads', {
    id: leadId, ...mapped, source: 'facebook', stage: 'new', valueCents: 0, clientId: null, nextActionAt: today,
  }, who);

  let enrolled = false;
  let queued = 0;
  if (sequenceId && ID_RE.test(sequenceId)) {
    const seq = await tx.query('SELECT data FROM sequences WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [tx.tenantId, sequenceId]);
    if (seq.rows[0]) {
      const sequence = { ...seq.rows[0].data, id: sequenceId };
      const enrolment = { sequenceId, leadId, startedAt: now.toISOString(), stepIndex: 0, status: 'active' };
      const company = (await companySettings(tx)).company?.name || '';
      const due = dueSteps(enrolment, sequence, lead, null, company, now);
      for (const m of due.messages) await records.createRecord(tx, p, 'outbox', m, who);
      await records.createRecord(tx, p, 'enrolments', { ...enrolment, stepIndex: due.stepIndex, status: due.status }, who);
      enrolled = true;
      queued = due.messages.length;
    }
  }
  return { created: true, leadId, enrolled, queued };
}

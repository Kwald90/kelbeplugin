// /api/hq/compliance/*: SOC 2-aligned controls (compliance/controls.yaml), the access
// review (HQ staff and every company's owners/admins with MFA status), incidents with a
// timeline, vendors, and HQ staff policy acknowledgements. Changes are audited in the
// platform chain.
import { ApiError, badRequest, notFound } from '../errors.js';
import { accessReview, loadControls } from '../services/hq-compliance.js';
import { hqAudit, hqSettings, iso, requireHqAdmin, uuidParams } from '../services/hq-common.js';

const SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4'];
const INCIDENT_STATUSES = ['open', 'monitoring', 'resolved', 'closed'];

const incidentView = (i) => ({
  id: i.id, number: i.number, title: i.title, severity: i.severity, status: i.status, summary: i.summary, customerImpact: i.customer_impact,
  openedBy: i.opened_by_name || null, openedAt: iso(i.opened_at), resolvedAt: iso(i.resolved_at), closedAt: iso(i.closed_at), updatedAt: iso(i.updated_at),
});

const vendorView = (v) => ({
  id: v.id, name: v.name, purpose: v.purpose, dataShared: v.data_shared, risk: v.risk, assurance: v.assurance, dpaSigned: v.dpa_signed,
  status: v.status, reviewDue: v.review_due ? new Date(v.review_due).toISOString().slice(0, 10) : null, lastReviewedAt: iso(v.last_reviewed_at),
  notes: v.notes, updatedAt: iso(v.updated_at),
});

const vendorProps = {
  name: { type: 'string', minLength: 1, maxLength: 120 },
  purpose: { type: 'string', maxLength: 500 },
  dataShared: { type: 'string', maxLength: 500 },
  risk: { type: 'string', enum: ['low', 'medium', 'high'] },
  assurance: { type: 'string', maxLength: 200 },
  dpaSigned: { type: 'boolean' },
  status: { type: 'string', enum: ['evaluating', 'active', 'retired'] },
  reviewDue: { type: ['string', 'null'], format: 'date' },
  notes: { type: 'string', maxLength: 2000 },
};
const VENDOR_COLS = { name: 'name', purpose: 'purpose', dataShared: 'data_shared', risk: 'risk', assurance: 'assurance', dpaSigned: 'dpa_signed', status: 'status', reviewDue: 'review_due', notes: 'notes' };

/** @param {import('fastify').FastifyInstance} app */
export default async function hqComplianceRoutes(app, { config, db }) {
  const settings = hqSettings(config);
  const hq = { auth: 'hq' };
  const tags = ['hq'];

  // ---- controls -------------------------------------------------------------------

  app.get('/api/hq/compliance/controls', { config: hq, schema: { tags, summary: 'Controls from compliance/controls.yaml (found: false when the file is missing)' } }, async () => loadControls(settings.controlsFile));

  // ---- access review --------------------------------------------------------------

  app.get('/api/hq/compliance/access-review', { config: hq, schema: { tags, summary: 'HQ staff and every company\'s owners/admins with MFA status and last sign-in' } }, async (req) => {
    return db.withHq(async (c) => {
      const review = await accessReview(c);
      const last = (await c.query(
        "SELECT at, actor_label, summary FROM audit_events WHERE tenant_id IS NULL AND action = 'hq.access_review_completed' ORDER BY seq DESC LIMIT 1")).rows[0];
      await hqAudit(c, req, null, { action: 'hq.access_review_view', collection: 'memberships', summary: `Viewed the access review (${review.summary.staff + review.summary.tenantAdmins} people)` });
      return { ...review, lastCompleted: last ? { at: iso(last.at), by: last.actor_label, summary: last.summary } : null };
    });
  });

  app.post('/api/hq/compliance/access-review/complete', {
    config: hq,
    schema: { tags, summary: 'Record that the access review was done (evidence)', body: { type: 'object', additionalProperties: false, properties: { notes: { type: 'string', maxLength: 400 } } } },
  }, async (req) => {
    return db.withHq(async (c) => {
      const r = await accessReview(c);
      const notes = (req.body?.notes || '').trim();
      await hqAudit(c, req, null, {
        action: 'hq.access_review_completed', collection: 'memberships',
        summary: `Access review completed: ${r.summary.staff} HQ staff, ${r.summary.tenantAdmins} company admins, ${r.summary.flagged} flagged${notes ? `. ${notes}` : ''}`.slice(0, 500),
        meta: r.summary,
      });
      return { ok: true, summary: r.summary };
    });
  });

  // ---- incidents ------------------------------------------------------------------

  const INCIDENT_SQL = `SELECT i.*, u.display_name AS opened_by_name FROM hq_incidents i LEFT JOIN users u ON u.id = i.opened_by`;

  app.get('/api/hq/compliance/incidents', {
    config: hq,
    schema: { tags, summary: 'Incidents, newest first', querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: INCIDENT_STATUSES } } } },
  }, async (req) => {
    const rows = await db.withHq(async (c) => (await c.query(
      `${INCIDENT_SQL} WHERE ($1::text IS NULL OR i.status = $1) ORDER BY i.opened_at DESC LIMIT 200`, [req.query.status || null])).rows);
    return { data: rows.map(incidentView) };
  });

  app.get('/api/hq/compliance/incidents/:id', { config: hq, schema: { tags, summary: 'One incident with its timeline', params: uuidParams('id') } }, async (req) => {
    return db.withHq(async (c) => {
      const i = (await c.query(`${INCIDENT_SQL} WHERE i.id = $1`, [req.params.id])).rows[0];
      if (!i) throw notFound('No such incident.');
      const events = (await c.query('SELECT id, at, author_label, kind, body FROM hq_incident_events WHERE incident_id = $1 ORDER BY id', [i.id])).rows;
      return { ...incidentView(i), timeline: events.map((e) => ({ id: e.id, at: iso(e.at), author: e.author_label, kind: e.kind, body: e.body })) };
    });
  });

  app.post('/api/hq/compliance/incidents', {
    config: hq,
    schema: {
      tags, summary: 'Open an incident',
      body: {
        type: 'object', required: ['title', 'severity'], additionalProperties: false,
        properties: { title: { type: 'string', minLength: 3, maxLength: 200 }, severity: { type: 'string', enum: SEVERITIES }, summary: { type: 'string', maxLength: 4000 }, customerImpact: { type: 'boolean' } },
      },
    },
  }, async (req, reply) => {
    const b = req.body;
    const out = await db.withHq(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO hq_incidents (title, severity, summary, customer_impact, opened_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, number`,
        [b.title.trim(), b.severity, (b.summary || '').trim(), Boolean(b.customerImpact), req.principal.userId]);
      await c.query("INSERT INTO hq_incident_events (incident_id, author_id, author_label, kind, body) VALUES ($1, $2, $3, 'opened', $4)",
        [rows[0].id, req.principal.userId, req.principal.actor.label, `Opened as ${b.severity}${b.summary ? `: ${b.summary.trim().slice(0, 3900)}` : ''}`]);
      await hqAudit(c, req, null, { action: 'hq.incident_open', collection: 'hq_incidents', recordId: rows[0].id, summary: `INC-${rows[0].number} opened (${b.severity})` });
      return rows[0];
    });
    reply.code(201);
    return out;
  });

  app.post('/api/hq/compliance/incidents/:id/events', {
    config: hq,
    schema: {
      tags, summary: 'Add to the timeline, and optionally change status or severity', params: uuidParams('id'),
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: { body: { type: 'string', maxLength: 4000 }, status: { type: 'string', enum: INCIDENT_STATUSES }, severity: { type: 'string', enum: SEVERITIES } },
      },
    },
  }, async (req) => {
    const b = req.body;
    const note = (b.body || '').trim();
    if (!note && !b.status && !b.severity) throw badRequest('Add a note, a status or a severity.');
    return db.withHq(async (c) => {
      const i = (await c.query('SELECT * FROM hq_incidents WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!i) throw notFound('No such incident.');
      if (i.status === 'closed' && b.status !== 'open') throw new ApiError(409, 'conflict', 'This incident is closed. Reopen it to add more.');
      const add = (kind, body) => c.query('INSERT INTO hq_incident_events (incident_id, author_id, author_label, kind, body) VALUES ($1, $2, $3, $4, $5)',
        [i.id, req.principal.userId, req.principal.actor.label, kind, body]);
      if (b.status && b.status !== i.status) {
        await c.query(
          `UPDATE hq_incidents SET status = $2, resolved_at = CASE WHEN $2 IN ('resolved', 'closed') THEN COALESCE(resolved_at, now()) WHEN $2 = 'open' THEN NULL ELSE resolved_at END,
                  closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END, updated_at = now() WHERE id = $1`, [i.id, b.status]);
        await add('status', `Status ${i.status} -> ${b.status}${note ? `: ${note}` : ''}`.slice(0, 4000));
      }
      if (b.severity && b.severity !== i.severity) {
        await c.query('UPDATE hq_incidents SET severity = $2, updated_at = now() WHERE id = $1', [i.id, b.severity]);
        await add('severity', `Severity ${i.severity} -> ${b.severity}`);
      }
      if (note && !(b.status && b.status !== i.status)) {
        await add('note', note);
        await c.query('UPDATE hq_incidents SET updated_at = now() WHERE id = $1', [i.id]);
      }
      await hqAudit(c, req, null, {
        action: 'hq.incident_update', collection: 'hq_incidents', recordId: i.id,
        summary: `INC-${i.number}${b.status ? ` ${b.status}` : ''}${b.severity ? ` ${b.severity}` : ''}${note ? ' (note)' : ''}`,
      });
      return { ok: true };
    });
  });

  // ---- vendors --------------------------------------------------------------------

  app.get('/api/hq/compliance/vendors', { config: hq, schema: { tags, summary: 'Vendors (subprocessors) and their review state' } }, async () => {
    const rows = await db.withHq(async (c) => (await c.query('SELECT * FROM hq_vendors ORDER BY status = \'retired\', name')).rows);
    return { data: rows.map(vendorView) };
  });

  app.post('/api/hq/compliance/vendors', {
    config: hq,
    schema: { tags, summary: 'Add a vendor (HQ admin)', body: { type: 'object', required: ['name'], additionalProperties: false, properties: vendorProps } },
  }, async (req, reply) => {
    requireHqAdmin(req);
    const b = req.body;
    const v = await db.withHq(async (c) => {
      const dup = await c.query('SELECT 1 FROM hq_vendors WHERE lower(name) = lower($1)', [b.name.trim()]);
      if (dup.rows.length) throw new ApiError(409, 'conflict', 'A vendor with this name exists.');
      const { rows } = await c.query(
        `INSERT INTO hq_vendors (name, purpose, data_shared, risk, assurance, dpa_signed, status, review_due, notes)
         VALUES ($1, $2, $3, COALESCE($4, 'medium'), $5, $6, COALESCE($7, 'evaluating'), $8, $9) RETURNING *`,
        [b.name.trim(), b.purpose || '', b.dataShared || '', b.risk || null, b.assurance || '', Boolean(b.dpaSigned), b.status || null, b.reviewDue || null, b.notes || '']);
      await hqAudit(c, req, null, { action: 'hq.vendor_add', collection: 'hq_vendors', recordId: rows[0].id, summary: `Vendor ${rows[0].name} added` });
      return rows[0];
    });
    reply.code(201);
    return vendorView(v);
  });

  app.patch('/api/hq/compliance/vendors/:id', {
    config: hq,
    schema: {
      tags, summary: 'Change a vendor; reviewed: true records a review today and sets the next one a year out (HQ admin)', params: uuidParams('id'),
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { ...vendorProps, reviewed: { type: 'boolean' } } },
    },
  }, async (req) => {
    requireHqAdmin(req);
    const b = req.body;
    return db.withHq(async (c) => {
      const cur = (await c.query('SELECT * FROM hq_vendors WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!cur) throw notFound('No such vendor.');
      const sets = [];
      const params = [cur.id];
      for (const [k, col] of Object.entries(VENDOR_COLS)) {
        if (!(k in b) || (k === 'reviewDue' && b.reviewed)) continue;
        params.push(typeof b[k] === 'string' && k !== 'reviewDue' ? b[k].trim() : b[k]);
        sets.push(`${col} = $${params.length}`);
      }
      if (b.reviewed) {
        params.push(b.reviewDue || null);
        sets.push('last_reviewed_at = now()', `review_due = COALESCE($${params.length}::date, (now() + interval '1 year')::date)`);
      }
      sets.push('updated_at = now()');
      const { rows } = await c.query(`UPDATE hq_vendors SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
      await hqAudit(c, req, null, {
        action: b.reviewed ? 'hq.vendor_review' : 'hq.vendor_update', collection: 'hq_vendors', recordId: cur.id,
        summary: `Vendor ${rows[0].name} ${b.reviewed ? 'reviewed' : 'updated'}`, meta: { fields: Object.keys(b) },
      });
      return vendorView(rows[0]);
    });
  });

  // ---- policies and acknowledgements -------------------------------------------------

  app.get('/api/hq/compliance/policies', { config: hq, schema: { tags, summary: 'Policies and which HQ staff acknowledged the current version' } }, async (req) => {
    return db.withHq(async (c) => {
      const policies = (await c.query('SELECT * FROM hq_policies ORDER BY title')).rows;
      const staff = (await c.query('SELECT id, display_name, platform_role, status FROM users WHERE platform_role IS NOT NULL ORDER BY display_name')).rows;
      const acks = (await c.query('SELECT policy_id, version, user_id, acked_at FROM hq_policy_acks')).rows;
      const ackOf = (p, u) => acks.find((a) => a.policy_id === p.id && a.version === p.version && a.user_id === u.id);
      return {
        policies: policies.map((p) => ({
          id: p.id, title: p.title, version: p.version, docPath: p.doc_path, required: p.required, updatedAt: iso(p.updated_at),
          acks: staff.map((u) => ({ userId: u.id, ackedAt: iso(ackOf(p, u)?.acked_at) })),
          mine: iso(ackOf(p, { id: req.principal.userId })?.acked_at),
        })),
        staff: staff.map((u) => ({ id: u.id, name: u.display_name, role: u.platform_role, status: u.status })),
      };
    });
  });

  app.post('/api/hq/compliance/policies/:id/ack', {
    config: hq,
    schema: { tags, summary: 'Acknowledge the current version of a policy (yourself)', params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[a-z0-9-]{2,64}$' } } } },
  }, async (req) => {
    return db.withHq(async (c) => {
      const p = (await c.query('SELECT id, title, version FROM hq_policies WHERE id = $1', [req.params.id])).rows[0];
      if (!p) throw notFound('No such policy.');
      const { rowCount } = await c.query('INSERT INTO hq_policy_acks (policy_id, version, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [p.id, p.version, req.principal.userId]);
      if (rowCount) await hqAudit(c, req, null, { action: 'hq.policy_ack', collection: 'hq_policies', recordId: p.id, summary: `Acknowledged ${p.title} v${p.version}` });
      return { ok: true, policyId: p.id, version: p.version };
    });
  });

  app.put('/api/hq/compliance/policies/:id', {
    config: hq,
    schema: {
      tags, summary: 'Add or change a policy; a new version asks everyone to acknowledge again (HQ admin)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[a-z0-9-]{2,64}$' } } },
      body: {
        type: 'object', required: ['title', 'version'], additionalProperties: false,
        properties: { title: { type: 'string', minLength: 2, maxLength: 200 }, version: { type: 'string', pattern: '^[0-9A-Za-z.-]{1,20}$' }, docPath: { type: ['string', 'null'], maxLength: 300 }, required: { type: 'boolean' } },
      },
    },
  }, async (req) => {
    requireHqAdmin(req);
    const b = req.body;
    return db.withHq(async (c) => {
      const before = (await c.query('SELECT version FROM hq_policies WHERE id = $1', [req.params.id])).rows[0];
      await c.query(
        `INSERT INTO hq_policies (id, title, version, doc_path, required) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, version = EXCLUDED.version, doc_path = EXCLUDED.doc_path, required = EXCLUDED.required, updated_at = now()`,
        [req.params.id, b.title.trim(), b.version, b.docPath || null, b.required ?? true]);
      await hqAudit(c, req, null, {
        action: before ? 'hq.policy_update' : 'hq.policy_add', collection: 'hq_policies', recordId: req.params.id,
        summary: `${b.title.trim()} v${b.version}${before && before.version !== b.version ? ` (was v${before.version}; acknowledgements reset)` : ''}`.slice(0, 500),
      });
      return { ok: true };
    });
  });
}

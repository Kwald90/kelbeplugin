// /api/v1/closing: the period lock and payroll runs (docs/releases/r1-get-paid.md 2.6, 8.1, 8.2;
// docs/office/period-lock.md). Office tools that change shared state need a connection: moving the
// books lock and reopening payroll need an owner or admin in a full session that passed two-step
// sign-in (never a crew PIN). Every write is audited; responses carry no money.
import { ApiError, forbidden, notFound, validationFailed } from '../../errors.js';
import { appendAudit } from '../../services/audit.js';
import { notify } from '../../services/notify.js';
import { loadLocks, lockHistory, preflight, setLock } from '../../services/period-lock.js';
import { systemPrincipal, systemWho } from '../../integrations/state.js';
import { POSTED_COLLECTIONS, addDay, documentDay } from '../../../../electrical-app/js/lib/closing.js';
import { entryMinutes } from '../../../../electrical-app/js/lib/timesheet.js';
import { collectionDef } from '../../collections.js';
import { errorResponses, tenantCtx, who } from '../util.js';

const tags = ['closing'];
const DAY = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const ID = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' };
const OFFICE_ROLES = ['owner', 'admin', 'office'];
const ADMIN_ROLES = ['owner', 'admin'];
const MAX_ENTRIES = 5000;

const session = (p) => p?.kind === 'session' && !p.crew;
/** Owner or admin in a full session that passed two-step sign-in (the QuickBooks write-route check). */
function requireAdminMfa(req) {
  const p = req.principal;
  if (!session(p) || !ADMIN_ROLES.includes(p.role)) throw forbidden('Only an owner or admin can do this, signed in (not with a crew PIN).');
  if (!req.auth?.session?.mfa_verified_at) throw new ApiError(403, 'mfa_required', 'Turn on two-step sign-in to close the books or reopen payroll.', { mfa: 'enrol', link: '#/account' });
}
const requireOffice = (p) => { if (!session(p) || !OFFICE_ROLES.includes(p.role)) throw forbidden('Only the office can see refused writes.'); };
const actorLabel = (req) => ({ ...req.principal.actor });

/** @param {import('fastify').FastifyInstance} app */
export default async function closingRoutes(app, { db, records }) {
  const inTenant = (req, fn, opts) => db.withTenant(tenantCtx(req.principal), fn, opts);

  // ---- status --------------------------------------------------------------------------------
  app.get('/api/v1/closing', {
    config: { auth: 'tenant', apiKey: false },
    schema: { tags, summary: 'The period locks', description: 'Books lock and payroll exported-through date, the last 50 lock changes, late postings this period, open refused writes, and QuickBooks\' own dates when connected. invoices or employees permission.', response: { ...errorResponses } },
  }, async (req) => {
    const p = req.principal;
    if (!p.perms.has('invoices') && !p.perms.has('employees')) throw forbidden('The period lock is for the office.');
    return inTenant(req, async (tx) => {
      const locks = await loadLocks(tx);
      const history = await lockHistory(tx, 50);
      const newest = (kind) => history.find((h) => h.kind === kind) || null;
      const late = [];
      if (locks.booksThrough || locks.payrollThrough) {
        for (const coll of POSTED_COLLECTIONS) {
          const def = collectionDef(coll);
          const { rows } = await tx.query(
            `SELECT id, data->>'postedOn' AS posted FROM ${def.table} WHERE tenant_id = $1 AND deleted_at IS NULL AND data->>'late' = 'true' AND data->>'postedOn' > $2
              ORDER BY data->>'postedOn' DESC LIMIT 100`, [tx.tenantId, locks.booksThrough || '0000-00-00']);
          for (const r of rows) late.push({ collection: coll, id: r.id, postedOn: r.posted });
        }
      }
      const { rows: rej } = await tx.query(
        "SELECT count(*)::int AS n, count(*) FILTER (WHERE at > now() - interval '7 days')::int AS week FROM sync_rejections WHERE tenant_id = $1 AND resolved_at IS NULL", [tx.tenantId]);
      const { rows: q } = await tx.query(
        `SELECT c.state, c.features->>'bookCloseDate' AS close, c.features->>'taxFiledThrough' AS filed,
                (SELECT value #>> '{}' FROM qbo_mappings m WHERE m.tenant_id = c.tenant_id AND m.kind = 'option' AND m.key = 'timeLockedThrough' AND m.realm_hash = c.realm_hash) AS time_locked,
                (SELECT value #>> '{}' FROM qbo_mappings m WHERE m.tenant_id = c.tenant_id AND m.kind = 'option' AND m.key = 'taxFiledThrough' AND m.realm_hash = c.realm_hash) AS filed_option
           FROM qbo_connections c WHERE c.tenant_id = $1 AND c.state <> 'disconnected'`, [tx.tenantId]);
      const later = (a, b) => (a && b ? (a > b ? a : b) : a || b || null);
      const qb = q[0] ? {
        connected: true, bookCloseDate: q[0].close || null, taxFiledThrough: later(q[0].filed, q[0].filed_option),
        timeLockedThrough: later(q[0].time_locked, locks.payrollThrough),
      } : { connected: false };
      return {
        zone: locks.zone, today: locks.today,
        books: { through: locks.booksThrough, at: newest('books')?.at || null, by: newest('books')?.actor || null },
        payroll: { through: locks.payrollThrough, at: newest('payroll')?.at || null, by: newest('payroll')?.actor || null },
        history: history.map((h) => ({ ...h, preflight: h.preflight?.counts || null })),
        latePostings: { count: late.length, items: late.slice(0, 200) },
        rejections: { open: rej[0].n, thisWeek: rej[0].week },
        quickbooks: qb,
        booksBehindQuickBooks: Boolean(qb.bookCloseDate && (!locks.booksThrough || locks.booksThrough < qb.bookCloseDate)),
      };
    });
  });

  app.get('/api/v1/closing/preflight', {
    config: { auth: 'tenant', apiKey: false },
    schema: { tags, summary: 'The pre-close checklist', querystring: { type: 'object', additionalProperties: false, required: ['through'], properties: { through: DAY } }, response: { ...errorResponses } },
  }, async (req) => {
    const p = req.principal;
    if (!session(p) || !ADMIN_ROLES.includes(p.role)) throw forbidden('Only an owner or admin closes the books.');
    return inTenant(req, (tx) => preflight(tx, { through: req.query.through }));
  });

  app.put('/api/v1/closing/books', {
    config: { auth: 'tenant', apiKey: false },
    schema: {
      tags, summary: 'Move the books lock',
      description: 'Records on or before `through` become read-only (changed by reversal). Moving it back or clearing it (through: null) needs a reason of at least 10 characters, and so does closing while the pre-close checklist has anything open. Owner or admin, full session with two-step sign-in.',
      body: { type: 'object', additionalProperties: false, required: ['through'], properties: { through: { anyOf: [DAY, { type: 'null' }] }, reason: { type: 'string', maxLength: 500 } } },
      response: { ...errorResponses },
    },
  }, async (req) => {
    requireAdminMfa(req);
    if (!req.principal.perms.has('settings')) throw forbidden('Closing the books needs the settings permission.');
    const { through, reason = null } = req.body;
    return inTenant(req, async (tx) => {
      let pre = null;
      if (through) {
        pre = await preflight(tx, { through });
        if (pre.open > 0 && String(reason || '').trim().length < 10) {
          throw new ApiError(409, 'preflight_open', 'Some things are still open for this period. Finish them, or say why you are closing anyway (at least 10 characters).', { counts: pre.counts });
        }
      }
      const r = await setLock(tx, { kind: 'books', through, reason, preflight: pre ? { counts: pre.counts } : null, actor: actorLabel(req), request: who(req).request, records });
      return { books: { through: r.through, previous: r.previous } };
    }, { write: true });
  });

  // ---- refused writes ------------------------------------------------------------------------
  app.get('/api/v1/closing/rejections', {
    config: { auth: 'tenant', apiKey: false },
    schema: { tags, summary: 'Writes the server refused', description: 'Open ones first, then the last week\'s resolved ones. Who, what and why; never the data.', response: { ...errorResponses } },
  }, async (req) => {
    requireOffice(req.principal);
    return inTenant(req, async (tx) => {
      const { rows } = await tx.query(
        `SELECT id, at, actor, device_id, collection, record_id, code, message, resolved_at, resolved_by FROM sync_rejections
          WHERE tenant_id = $1 AND (resolved_at IS NULL OR resolved_at > now() - interval '7 days') ORDER BY (resolved_at IS NULL) DESC, at DESC LIMIT 200`, [tx.tenantId]);
      return {
        data: rows.map((r) => ({
          id: String(r.id), at: r.at.toISOString(), actor: r.actor, deviceId: r.device_id, collection: r.collection, recordId: r.record_id, code: r.code, message: r.message,
          resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null, resolvedBy: r.resolved_by,
        })),
      };
    });
  });

  app.post('/api/v1/closing/rejections/:id/resolve', {
    config: { auth: 'tenant', apiKey: false },
    schema: { tags, summary: 'Mark a refused write resolved', params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^\\d{1,18}$' } } }, response: { ...errorResponses } },
  }, async (req) => {
    requireOffice(req.principal);
    return inTenant(req, async (tx) => {
      const by = String(req.principal.actor?.label || req.principal.userId || 'office').slice(0, 200);
      const { rowCount } = await tx.query('UPDATE sync_rejections SET resolved_at = now(), resolved_by = $3 WHERE tenant_id = $1 AND id = $2 AND resolved_at IS NULL', [tx.tenantId, req.params.id, by]);
      if (!rowCount) throw notFound();
      await appendAudit(tx, tx.tenantId, { actor: req.principal.actor, action: 'closing.rejection_resolved', collection: 'sync_rejections', recordId: req.params.id, request: who(req).request });
      return { ok: true };
    });
  });

  // ---- payroll runs --------------------------------------------------------------------------
  app.post('/api/v1/closing/payroll-runs', {
    config: { auth: 'tenant', apiKey: false },
    schema: {
      tags, summary: 'Record a payroll export (and lock its entries)',
      description: 'Every entry must exist, be approved and closed, fall in from..to (late entries: before from) and be in no other exported run (409 already_exported). With lockThrough, entries in the period that are open, unapproved or in no run are listed (409 unexported_entries) unless leftOutAck, then stored in leftOut; payrollThrough moves to `to`. employees permission.',
      body: {
        type: 'object', additionalProperties: false, required: ['from', 'to', 'format', 'entryIds'],
        properties: {
          id: ID, from: DAY, to: DAY, format: { type: 'string', enum: ['wagepoint', 'qbo', 'generic'] },
          entryIds: { type: 'array', maxItems: MAX_ENTRIES, items: ID }, lateEntryIds: { type: 'array', maxItems: MAX_ENTRIES, items: ID },
          employeeIds: { type: 'array', maxItems: 2000, items: ID },
          totals: { type: 'object', additionalProperties: false, properties: { minutes: { type: 'integer' }, otMinutes: { type: 'integer' }, entries: { type: 'integer' } } },
          lockThrough: { type: 'boolean' }, leftOutAck: { type: 'boolean' },
        },
      },
      response: { ...errorResponses },
    },
  }, async (req, reply) => {
    const p = req.principal;
    if (!p.perms.has('employees')) throw forbidden('Recording a payroll run needs the employees permission.');
    const b = req.body;
    if (b.to < b.from) throw validationFailed('The period ends before it starts.');
    return inTenant(req, async (tx) => {
      const locks = await loadLocks(tx);
      const zone = locks.zone;
      const ids = [...new Set(b.entryIds)];
      const lateIds = [...new Set(b.lateEntryIds || [])].filter((x) => !ids.includes(x));
      const all = [...ids, ...lateIds];
      const { rows } = await tx.query('SELECT id, data FROM time_entries WHERE tenant_id = $1 AND deleted_at IS NULL AND id = ANY($2)', [tx.tenantId, all]);
      const byId = new Map(rows.map((r) => [r.id, { ...r.data, id: r.id }]));
      const bad = [];
      for (const id of all) {
        const e = byId.get(id);
        const late = lateIds.includes(id);
        if (!e) { bad.push({ entryId: id, reason: 'missing' }); continue; }
        const closed = e.kind === 'correction' || Boolean(e.clockOut);
        if (!closed) bad.push({ entryId: id, reason: 'open' });
        else if (!e.approved) bad.push({ entryId: id, reason: 'unapproved' });
        const day = documentDay('timeEntries', e, { zone });
        if (!late && (!day || day < b.from || day > b.to)) bad.push({ entryId: id, reason: 'outside_period' });
        if (late && (!day || day >= b.from)) bad.push({ entryId: id, reason: 'not_earlier' });
      }
      if (bad.length) throw new ApiError(422, 'invalid_entries', 'Some entries cannot go in this run.', { entries: bad.slice(0, 200) });
      const taken = all.filter((id) => locks.payrollEntryIds.has(id));
      if (taken.length) throw new ApiError(409, 'already_exported', 'Some of these hours are already in an exported payroll run.', { entryIds: taken.slice(0, 200) });

      // Entries in the period (any employee) that this run and earlier runs leave out.
      let leftOut = [];
      if (b.lockThrough) {
        const { rows: period } = await tx.query(
          `SELECT id, data FROM time_entries WHERE tenant_id = $1 AND deleted_at IS NULL
            AND coalesce(data->>'clockIn', data->>'workDay') >= $2 AND coalesce(data->>'clockIn', data->>'workDay') < $3`,
          [tx.tenantId, addDay(b.from, -1), addDay(b.to, 2)]);
        const inRun = new Set(all);
        for (const r of period) {
          const e = { ...r.data, id: r.id };
          const day = documentDay('timeEntries', e, { zone });
          if (!day || day < b.from || day > b.to || inRun.has(e.id) || locks.payrollEntryIds.has(e.id)) continue;
          const closed = e.kind === 'correction' || Boolean(e.clockOut);
          leftOut.push({ entryId: e.id, employeeId: e.employeeId || null, reason: !closed ? 'open' : !e.approved ? 'unapproved' : 'not_in_run' });
        }
        if (leftOut.length && !b.leftOutAck) {
          throw new ApiError(409, 'unexported_entries', `${leftOut.length} entr${leftOut.length === 1 ? 'y is' : 'ies are'} in this period but not in this run. They will wait in Late hours for the next run.`, { entries: leftOut.slice(0, 500) });
        }
        leftOut = leftOut.slice(0, MAX_ENTRIES);
      }

      const minutes = all.reduce((s, id) => s + (entryMinutes(byId.get(id)) || 0), 0);
      const sys = systemPrincipal(tx.tenantId, 'closing', 'Payroll export');
      const sysWho = { ...systemWho(sys, who(req).request), actor: { type: 'system', id: 'closing', label: `Payroll export by ${req.principal.actor?.label || 'the office'}` } };
      const employeeIds = [...new Set([...(b.employeeIds || []), ...all.map((id) => byId.get(id)?.employeeId).filter(Boolean)])];
      const run = await records.createRecord(tx, sys, 'payrollRuns', {
        ...(b.id ? { id: b.id } : {}),
        from: b.from, to: b.to, format: b.format, employeeIds, entryIds: ids, lateEntryIds: lateIds,
        totals: { minutes, otMinutes: Number.isInteger(b.totals?.otMinutes) ? b.totals.otMinutes : 0, entries: all.length },
        exportedAt: new Date().toISOString(), exportedBy: { id: req.principal.userId, name: req.principal.actor?.label || null },
        status: 'exported', ...(b.lockThrough ? { lockThrough: b.to } : {}), ...(leftOut.length ? { leftOut } : {}),
      }, sysWho);
      await appendAudit(tx, tx.tenantId, { actor: req.principal.actor, action: 'closing.payroll_run', collection: 'payrollRuns', recordId: run.id, summary: `${b.from} to ${b.to}: ${all.length} entries`, request: who(req).request });
      let payrollThrough = locks.payrollThrough;
      if (b.lockThrough && (!payrollThrough || b.to > payrollThrough)) {
        payrollThrough = (await setLock(tx, { kind: 'payroll', through: b.to, actor: req.principal.actor, request: who(req).request, records })).through;
      }
      reply.code(201);
      return { run, payrollThrough };
    }, { write: true });
  });

  app.post('/api/v1/closing/payroll-runs/:id/reopen', {
    config: { auth: 'tenant', apiKey: false },
    schema: {
      tags, summary: 'Reopen a payroll run', description: 'Its entries unlock. Correct the payroll provider by hand. Owner or admin, full session with two-step sign-in.',
      params: { type: 'object', required: ['id'], properties: { id: ID } },
      body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', minLength: 10, maxLength: 500 } } },
      response: { ...errorResponses },
    },
  }, async (req) => {
    requireAdminMfa(req);
    return inTenant(req, async (tx) => {
      const { rows } = await tx.query('SELECT data FROM payroll_runs WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [tx.tenantId, req.params.id]);
      const run = rows[0]?.data;
      if (!run) throw notFound();
      if (run.status !== 'exported') throw new ApiError(409, 'not_exported', 'This payroll run is already reopened.');
      const sys = systemPrincipal(tx.tenantId, 'closing', 'Payroll export');
      const sysWho = { ...systemWho(sys, who(req).request), actor: { type: 'system', id: 'closing', label: `Payroll reopened by ${req.principal.actor?.label || 'an admin'}` } };
      const updated = await records.patchRecord(tx, sys, 'payrollRuns', req.params.id, {
        status: 'reopened', reopenedAt: new Date().toISOString(), reopenedBy: { id: req.principal.userId, name: req.principal.actor?.label || null }, reopenReason: req.body.reason.trim(),
      }, null, sysWho);
      const locks = await loadLocks(tx);
      let payrollThrough = locks.payrollThrough;
      if (payrollThrough && run.from && payrollThrough >= run.from) {
        payrollThrough = (await setLock(tx, { kind: 'payroll', through: addDay(run.from, -1), reason: req.body.reason, actor: req.principal.actor, request: who(req).request, records })).through;
      }
      await appendAudit(tx, tx.tenantId, { actor: req.principal.actor, action: 'closing.payroll_reopen', collection: 'payrollRuns', recordId: req.params.id, summary: req.body.reason.slice(0, 200), request: who(req).request });
      await notify(tx, {
        role: ['owner', 'admin', 'office'], kind: 'payroll_reopened', title: `Payroll ${run.from} to ${run.to} was reopened`,
        body: 'Its hours can be edited again. Correct the payroll provider by hand.', link: '#/books/payroll', ref: `payroll_reopened:${req.params.id}:${Date.now()}`,
      });
      return { run: updated, payrollThrough };
    }, { write: true });
  });
}

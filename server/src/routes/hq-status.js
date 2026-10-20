// Public service status (status.fishtapehq.com) and the HQ side of it. services/status-page.js
// has the rules; docs/runbooks/status-page.md the operations.
//   GET    /api/v1/public/status                    public: components, 90-day uptime, notices (cached 30 s)
//   POST   /api/v1/public/status/subscribe          public: { email, website } -> 202 (404 while subscriptions are off)
//   POST   /api/v1/public/status/confirm            public: { token } from the emailed #confirm= link
//   POST   /api/v1/public/status/unsubscribe        public: { token } from a notice email's #unsubscribe= link
//   GET    /api/hq/status-notices                   HQ staff: notices (drafts too), components, subscribers, setting
//   POST   /api/hq/status-notices                   HQ admin: create (optional first update, publish, notify)
//   PATCH  /api/hq/status-notices/:id               HQ admin: edit, publish / unpublish, change status
//   POST   /api/hq/status-notices/:id/updates       HQ admin: add a timeline entry (sets the notice status)
//   DELETE /api/hq/status-notices/:id               HQ admin
//   PUT    /api/hq/status-settings                  HQ admin: { subscribeEnabled }
// The public routes are part of the status site, not the developer API: hidden from openapi.json.
// They read only the *_public views through the app role. HQ writes run in hq-api, so the
// public copy is not invalidated from there; it simply expires after 30 seconds.
import { createHash } from 'node:crypto';
import { ApiError, notFound, validationFailed } from '../errors.js';
import { BRAND } from '../brand.js';
import { EMAIL_RE, normaliseEmail } from '../services/tenants.js';
import { hqAudit, iso, requireHqAdmin, uuidParams } from '../services/hq-common.js';
import { readPlatformSettings } from '../services/hq-settings.js';
import { createLiveCache } from '../services/promotions.js';
import { nudgePlatformEmail } from '../services/platform-email.js';
import {
  ALL_NOTICE_STATUSES, COMPONENT_IDS, IMPACTS, LIMITS, NOTICE_KINDS, NOTICE_STATUSES, NOTIFY_CAP, STATUS_LABEL, TOKEN_RE,
  buildUptime, cleanText, componentStatuses, confirmEmail, defaultImpact, defaultStatus, hashToken, isClosed, loadPublicStatus,
  newToken, noticeEmail, noticeProblems, readStatusSetting, statusSettings,
} from '../services/status-page.js';
import { createLeadLimiter } from './hq-leads.js';

/** Field problems as a 400 that names fields, never values. */
const invalid = (errors) => validationFailed('Check the highlighted fields.', { errors });

const noticeFields = {
  title: { type: 'string', minLength: 1, maxLength: 400 },
  impact: { type: 'string', enum: IMPACTS },
  components: { type: 'array', uniqueItems: true, maxItems: COMPONENT_IDS.length, items: { type: 'string', enum: COMPONENT_IDS } },
  status: { type: 'string', enum: ALL_NOTICE_STATUSES },
  published: { type: 'boolean' },
  startsAt: { type: ['string', 'null'], format: 'date-time' },
  endsAt: { type: ['string', 'null'], format: 'date-time' },
  notify: { type: 'boolean' },
};

/** HQ view: everything, drafts and authors included. */
const hqNotice = (n, updates) => ({
  id: n.id, kind: n.kind, title: n.title, impact: n.impact, components: n.components, status: n.status, published: n.published,
  startsAt: iso(n.starts_at), endsAt: iso(n.ends_at), resolvedAt: iso(n.resolved_at), createdAt: iso(n.created_at), updatedAt: iso(n.updated_at),
  createdByName: n.created_by_name || null, updatedByName: n.updated_by_name || null,
  updates: updates.filter((u) => u.notice_id === n.id).map((u) => ({ id: u.id, status: u.status, body: u.body, at: iso(u.created_at), byName: u.by_name || null })),
});

/** @param {import('fastify').FastifyInstance} app */
export default async function hqStatusRoutes(app, { config, db, email }) {
  const settings = statusSettings(config);
  const tags = ['hq'];
  const live = createLiveCache({ ttlMs: settings.cacheSeconds * 1000, load: () => loadPublicStatus(db) });
  const allowSubscribe = createLeadLimiter({ perKey: settings.subscribePerHour ?? 5, global: settings.subscribeGlobalPerHour ?? 200 });
  const allowToken = createLeadLimiter({ perKey: settings.tokenPerHour ?? 30, global: 2000 });

  // ---- public ------------------------------------------------------------------------------

  app.get('/api/v1/public/status', {
    config: { auth: 'public' },
    schema: { hide: true },
  }, async (req, reply) => {
    let body;
    try {
      body = await live.get();
    } catch (err) {
      req.log.warn({ err: { message: err.message, code: err.code } }, 'status unavailable');
      throw new ApiError(503, 'unavailable', 'Status is unavailable right now. Try again shortly.');
    }
    const etag = `W/"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 27)}"`;
    // Fishtape's own service status, the same for everyone: fine to cache briefly.
    reply.header('cache-control', `public, max-age=${Math.min(settings.cacheSeconds, 60)}`);
    reply.header('etag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return body;
  });

  const tokenBody = { type: 'object', additionalProperties: false, required: ['token'], properties: { token: { type: 'string', minLength: 1, maxLength: 200 } } };
  const limitTokens = async (req) => { if (!allowToken(`ip:${req.ip}`)) throw new ApiError(429, 'rate_limited', 'Too many requests. Try again later.'); };

  app.post('/api/v1/public/status/subscribe', {
    config: { auth: 'public' },
    onRequest: async (req) => {
      // Counted before validation, so malformed floods are limited too.
      if (!allowSubscribe(`ip:${req.ip}`)) throw new ApiError(429, 'rate_limited', 'Too many requests. Try again later.');
    },
    schema: {
      hide: true,
      body: {
        type: 'object', additionalProperties: false, required: ['email'],
        properties: { email: { type: 'string', minLength: 3, maxLength: 254 }, website: { type: 'string', maxLength: 500 } },
      },
    },
  }, async (req, reply) => {
    const setting = await readStatusSetting(db);
    if (!setting.subscribeEnabled) throw new ApiError(404, 'subscriptions_off', 'Email updates are not offered right now.');
    const b = req.body;
    if (typeof b.website === 'string' && b.website.trim()) { reply.code(202); return { ok: true }; } // honeypot: looks accepted
    const addr = normaliseEmail(b.email);
    if (!EMAIL_RE.test(addr) || /[<>"'\s]/.test(addr)) throw invalid([{ path: '/email', message: 'must be a valid email address' }]);
    await db.tx(async (c) => {
      const cur = (await c.query('SELECT id, confirmed_at, confirm_sent_at FROM status_subscribers WHERE email = $1 FOR UPDATE', [addr])).rows[0];
      // Same answer whether or not the address is known. A confirmed address gets nothing; a
      // pending one gets a fresh link at most every 10 minutes.
      if (cur?.confirmed_at) return;
      if (cur?.confirm_sent_at && Date.now() - new Date(cur.confirm_sent_at).getTime() < 10 * 60_000) return;
      const token = newToken();
      if (cur) {
        await c.query('UPDATE status_subscribers SET confirm_token_hash = $2, confirm_sent_at = now() WHERE id = $1', [cur.id, hashToken(token)]);
      } else {
        await c.query(
          'INSERT INTO status_subscribers (email, confirm_token_hash, confirm_sent_at, unsubscribe_token) VALUES ($1, $2, now(), $3)',
          [addr, hashToken(token), newToken()]);
      }
      const support = (await readPlatformSettings(c)).support.email;
      await email.send(c, confirmEmail({ brand: BRAND.name, publicUrl: settings.publicUrl, supportEmail: support, to: addr, token }));
      await nudgePlatformEmail(c);
    });
    reply.code(202);
    return { ok: true };
  });

  app.post('/api/v1/public/status/confirm', {
    config: { auth: 'public' }, onRequest: limitTokens, schema: { hide: true, body: tokenBody },
  }, async (req) => {
    const token = req.body.token;
    const bad = () => new ApiError(400, 'invalid_token', 'This link is not valid or has expired. Subscribe again to get a new one.');
    if (!TOKEN_RE.test(token)) throw bad();
    const { rowCount } = await db.query(
      `UPDATE status_subscribers SET confirmed_at = now(), confirm_token_hash = NULL
        WHERE confirm_token_hash = $1 AND confirmed_at IS NULL AND confirm_sent_at > now() - interval '7 days'`, [hashToken(token)]);
    if (!rowCount) throw bad();
    return { ok: true };
  });

  app.post('/api/v1/public/status/unsubscribe', {
    config: { auth: 'public' }, onRequest: limitTokens, schema: { hide: true, body: tokenBody },
  }, async (req) => {
    // Always 200: the answer says nothing about whether the token (or an address) exists.
    if (TOKEN_RE.test(req.body.token)) await db.query('DELETE FROM status_subscribers WHERE unsubscribe_token = $1', [req.body.token]);
    return { ok: true };
  });

  // ---- HQ ----------------------------------------------------------------------------------

  const hq = { auth: 'hq' };
  const SELECT = `SELECT n.*, cu.display_name AS created_by_name, uu.display_name AS updated_by_name
                    FROM status_notices n LEFT JOIN users cu ON cu.id = n.created_by LEFT JOIN users uu ON uu.id = n.updated_by`;
  const UPDATES = `SELECT u.*, us.display_name AS by_name FROM status_notice_updates u LEFT JOIN users us ON us.id = u.created_by`;

  async function oneNotice(c, id) {
    const n = (await c.query(`${SELECT} WHERE n.id = $1`, [id])).rows[0];
    if (!n) return null;
    const ups = (await c.query(`${UPDATES} WHERE u.notice_id = $1 ORDER BY u.created_at DESC`, [id])).rows;
    return hqNotice(n, ups);
  }

  /** Queue one email per confirmed subscriber (capped) in this transaction. Returns how many. */
  async function notifySubscribers(c, notice, update) {
    const setting = await readStatusSetting(c);
    if (!setting.subscribeEnabled) return { sent: 0, skipped: 'subscriptions_off' };
    if (!notice.published) return { sent: 0, skipped: 'draft' };
    const subs = (await c.query(
      'SELECT email, unsubscribe_token FROM status_subscribers WHERE confirmed_at IS NOT NULL ORDER BY confirmed_at LIMIT $1', [NOTIFY_CAP])).rows;
    const support = (await readPlatformSettings(c)).support.email;
    for (const s of subs) {
      await email.send(c, noticeEmail({ brand: BRAND.name, publicUrl: settings.publicUrl, supportEmail: support, notice, update, to: s.email, unsubscribeToken: s.unsubscribe_token }));
    }
    if (subs.length) await nudgePlatformEmail(c);
    return { sent: subs.length, ...(subs.length >= NOTIFY_CAP ? { capped: true } : {}) };
  }

  function cleanNoticeInput(b) {
    const out = { ...b };
    if ('title' in b) out.title = cleanText(b.title);
    if ('components' in b) out.components = COMPONENT_IDS.filter((id) => b.components.includes(id));
    return out;
  }
  const check = (n) => {
    const p = noticeProblems(n);
    if (p.length) throw invalid(p);
  };

  app.get('/api/hq/status-notices', { config: hq, schema: { tags, summary: 'Public status page: notices (drafts too), components, subscribers' } }, async () => {
    return db.withHq(async (c) => {
      const notices = (await c.query(`${SELECT} ORDER BY (n.status NOT IN ('resolved', 'completed')) DESC, n.created_at DESC LIMIT 200`)).rows;
      const ups = notices.length ? (await c.query(`${UPDATES} WHERE u.notice_id = ANY($1::uuid[]) ORDER BY u.created_at DESC`, [notices.map((n) => n.id)])).rows : [];
      const latest = (await c.query('SELECT component, status, checked_at, changed_at FROM status_latest')).rows;
      const daily = (await c.query(
        "SELECT to_char(day, 'YYYY-MM-DD') AS day, component, checks, outages, degraded FROM status_daily WHERE day > (now() AT TIME ZONE 'UTC')::date - 90")).rows;
      const subs = (await c.query(
        'SELECT count(*) FILTER (WHERE confirmed_at IS NOT NULL)::int AS confirmed, count(*) FILTER (WHERE confirmed_at IS NULL)::int AS pending FROM status_subscribers')).rows[0];
      const setting = await readStatusSetting(c);
      const now = new Date();
      const changed = Object.fromEntries(latest.map((r) => [r.component, iso(r.changed_at)]));
      return {
        data: notices.map((n) => hqNotice(n, ups)),
        components: componentStatuses(latest, now).map((x) => ({ ...x, changedAt: changed[x.id] || null })),
        uptime: buildUptime(daily, now).pct,
        subscribers: subs,
        settings: { subscribeEnabled: setting.subscribeEnabled },
        publicUrl: settings.publicUrl,
        probes: settings.probes ? 'on' : 'off',
        kinds: NOTICE_KINDS, statuses: NOTICE_STATUSES, impacts: IMPACTS, statusLabels: STATUS_LABEL,
      };
    });
  });

  app.post('/api/hq/status-notices', {
    config: hq,
    schema: {
      tags, summary: 'Post a public status notice (HQ admin; audited)',
      body: {
        type: 'object', additionalProperties: false, required: ['kind', 'title'],
        properties: { kind: { type: 'string', enum: NOTICE_KINDS }, ...noticeFields, update: { type: 'string', maxLength: 4000 } },
      },
    },
  }, async (req, reply) => {
    requireHqAdmin(req);
    const b = cleanNoticeInput(req.body);
    const n = {
      kind: b.kind, title: b.title, impact: b.impact || defaultImpact(b.kind), components: b.components || [],
      status: b.status || defaultStatus(b.kind), startsAt: b.startsAt || null, endsAt: b.endsAt || null, published: b.published === true,
    };
    check(n);
    const first = b.update !== undefined ? cleanText(b.update, { multiline: true }) : '';
    if (first.length > LIMITS.bodyMax) throw invalid([{ path: '/update', message: `must be at most ${LIMITS.bodyMax} characters` }]);
    const out = await db.withHq(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO status_notices (kind, title, impact, components, status, published, starts_at, ends_at, resolved_at, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING *`,
        [n.kind, n.title, n.impact, n.components, n.status, n.published, n.startsAt, n.endsAt, isClosed(n.status) ? new Date() : null, req.principal.userId]);
      const row = rows[0];
      if (first) {
        await c.query('INSERT INTO status_notice_updates (notice_id, status, body, created_by) VALUES ($1, $2, $3, $4)', [row.id, n.status, first, req.principal.userId]);
      }
      const notified = b.notify && n.published ? await notifySubscribers(c, row, first ? { status: n.status, body: first } : null) : null;
      await hqAudit(c, req, null, {
        action: 'hq.status_notice_create', collection: 'status_notices', recordId: row.id,
        summary: `Status ${n.kind} created (${n.status}, ${n.published ? 'published' : 'draft'})`,
        meta: { kind: n.kind, impact: n.impact, components: n.components, published: n.published, ...(notified ? { notified: notified.sent } : {}) },
      });
      return { ...(await oneNotice(c, row.id)), notified };
    });
    reply.code(201);
    return out;
  });

  app.patch('/api/hq/status-notices/:id', {
    config: hq,
    schema: { tags, summary: 'Edit, publish or change the status of a notice (HQ admin; audited)', params: uuidParams('id'), body: { type: 'object', additionalProperties: false, minProperties: 1, properties: noticeFields } },
  }, async (req) => {
    requireHqAdmin(req);
    const b = cleanNoticeInput(req.body);
    return db.withHq(async (c) => {
      const cur = (await c.query('SELECT * FROM status_notices WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!cur) throw notFound('No such notice.');
      const next = {
        kind: cur.kind, title: b.title ?? cur.title, impact: b.impact ?? cur.impact, components: b.components ?? cur.components,
        status: b.status ?? cur.status, published: b.published ?? cur.published,
        startsAt: 'startsAt' in b ? b.startsAt : iso(cur.starts_at), endsAt: 'endsAt' in b ? b.endsAt : iso(cur.ends_at),
      };
      check(next);
      const resolvedAt = isClosed(next.status) ? (cur.resolved_at || new Date()) : null;
      const { rows } = await c.query(
        `UPDATE status_notices SET title = $2, impact = $3, components = $4, status = $5, published = $6, starts_at = $7, ends_at = $8,
                resolved_at = $9, updated_by = $10, updated_at = now() WHERE id = $1 RETURNING *`,
        [cur.id, next.title, next.impact, next.components, next.status, next.published, next.startsAt, next.endsAt, resolvedAt, req.principal.userId]);
      const publishing = next.published && !cur.published;
      const notified = b.notify && publishing ? await notifySubscribers(c, rows[0], null) : null;
      const what = [
        next.status !== cur.status ? `${cur.status} -> ${next.status}` : null,
        next.published !== cur.published ? (next.published ? 'published' : 'unpublished') : null,
      ].filter(Boolean).join(', ') || 'edited';
      await hqAudit(c, req, null, {
        action: 'hq.status_notice_update', collection: 'status_notices', recordId: cur.id, summary: `Status ${cur.kind} ${what}`,
        meta: { fields: Object.keys(req.body).filter((k) => k !== 'notify'), ...(notified ? { notified: notified.sent } : {}) },
      });
      return { ...(await oneNotice(c, cur.id)), notified };
    });
  });

  app.post('/api/hq/status-notices/:id/updates', {
    config: hq,
    schema: {
      tags, summary: 'Add a timeline entry to a notice; sets its status (HQ admin; audited)', params: uuidParams('id'),
      body: {
        type: 'object', additionalProperties: false, required: ['status', 'body'],
        properties: { status: { type: 'string', enum: ALL_NOTICE_STATUSES }, body: { type: 'string', minLength: 1, maxLength: 4000 }, notify: { type: 'boolean' } },
      },
    },
  }, async (req, reply) => {
    requireHqAdmin(req);
    const text = cleanText(req.body.body, { multiline: true });
    if (!text || text.length > LIMITS.bodyMax) throw invalid([{ path: '/body', message: `must be 1-${LIMITS.bodyMax} characters of plain text` }]);
    const out = await db.withHq(async (c) => {
      const cur = (await c.query('SELECT * FROM status_notices WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!cur) throw notFound('No such notice.');
      const status = req.body.status;
      if (!NOTICE_STATUSES[cur.kind].includes(status)) throw invalid([{ path: '/status', message: `a ${cur.kind} is ${NOTICE_STATUSES[cur.kind].join(', ')}` }]);
      await c.query('INSERT INTO status_notice_updates (notice_id, status, body, created_by) VALUES ($1, $2, $3, $4)', [cur.id, status, text, req.principal.userId]);
      const { rows } = await c.query(
        'UPDATE status_notices SET status = $2, resolved_at = $3, updated_by = $4, updated_at = now() WHERE id = $1 RETURNING *',
        [cur.id, status, isClosed(status) ? (cur.resolved_at || new Date()) : null, req.principal.userId]);
      const notified = req.body.notify ? await notifySubscribers(c, rows[0], { status, body: text }) : null;
      await hqAudit(c, req, null, {
        action: 'hq.status_notice_post', collection: 'status_notices', recordId: cur.id,
        summary: `Status ${cur.kind} update posted (${cur.status}${status !== cur.status ? ` -> ${status}` : ''})`,
        meta: { status, published: cur.published, ...(notified ? { notified: notified.sent } : {}) },
      });
      return { ...(await oneNotice(c, cur.id)), notified };
    });
    reply.code(201);
    return out;
  });

  app.delete('/api/hq/status-notices/:id', { config: hq, schema: { tags, summary: 'Delete a notice and its timeline (HQ admin; audited)', params: uuidParams('id') } }, async (req, reply) => {
    requireHqAdmin(req);
    await db.withHq(async (c) => {
      const { rows } = await c.query('DELETE FROM status_notices WHERE id = $1 RETURNING id, kind, published', [req.params.id]);
      if (!rows[0]) throw notFound('No such notice.');
      await hqAudit(c, req, null, { action: 'hq.status_notice_delete', collection: 'status_notices', recordId: rows[0].id, summary: `Status ${rows[0].kind} deleted${rows[0].published ? ' (was public)' : ''}` });
    });
    return reply.code(204).send();
  });

  app.put('/api/hq/status-settings', {
    config: hq,
    schema: { tags, summary: 'Turn email subscriptions on the public status page on or off (HQ admin; audited)', body: { type: 'object', additionalProperties: false, required: ['subscribeEnabled'], properties: { subscribeEnabled: { type: 'boolean' } } } },
  }, async (req) => {
    requireHqAdmin(req);
    return db.withHq(async (c) => {
      const before = await readStatusSetting(c);
      await c.query(
        `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES ('status', $1, now(), $2)
         ON CONFLICT (key) DO UPDATE SET value = platform_settings.value || EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [JSON.stringify({ subscribeEnabled: req.body.subscribeEnabled }), req.principal.userId]);
      await hqAudit(c, req, null, {
        action: 'hq.status_settings', collection: 'platform_settings', recordId: 'status',
        summary: `Status email subscriptions ${req.body.subscribeEnabled ? 'on' : 'off'}${before.subscribeEnabled === req.body.subscribeEnabled ? ' (unchanged)' : ''}`,
      });
      return { subscribeEnabled: req.body.subscribeEnabled };
    });
  });
}

// /api/v1/integrations: each company connects its own Stripe, Resend or SendGrid, Twilio, Facebook and
// Anthropic accounts (owner/admin), tests them, and disconnects them. Keys go in once and are
// never returned: responses carry hints (…abcd) only. Plus the actions built on them:
// "Pay online" links for invoices, emailing an invoice or estimate, and the public pay page.
// Both sending routes run the exemption check (docs/releases/r1-get-paid.md 2.9): a Manitoba
// invoice that leaves RST off without the customer's exemption evidence is refused (422).
import { ApiError, badRequest, forbidden, notFound } from '../../errors.js';
import { canRead, canWrite } from '../../auth/access.js';
import { isUuid } from '../../db.js';
import { appendAudit, requestFacts } from '../../services/audit.js';
import { assertFeature, effectivePlan, loadTenantPlan, requireFeature, tenantHas } from '../../services/entitlements.js';
import { deleteSecret, listSecrets, setSecret, SECRETS } from '../../services/secrets.js';
import { docTotals, formatMoney } from '../../../../electrical-app/js/lib/money.js';
import { exemptionProblem } from '../../../../electrical-app/js/lib/exemption.js';
import { PLANS, planFor } from '../../../../electrical-app/js/plans.js';
import { ProviderError } from '../../integrations/http.js';
import { EMAIL_RE, PROVIDERS, PROVIDER_IDS, providerFor, webhookUrl } from '../../integrations/providers.js';
import { createCheckoutSession, testStripe } from '../../integrations/stripe.js';
import { testResend } from '../../integrations/resend.js';
import { testSendgrid } from '../../integrations/sendgrid.js';
import { testTwilio, toE164 } from '../../integrations/twilio.js';
import { subscribePage, testFacebook } from '../../integrations/facebook.js';
import { testAnthropic } from '../../integrations/anthropic.js';
import { companySettings, invoiceBalance } from '../../integrations/payments.js';
import { enqueueSend } from '../../integrations/jobs.js';
import {
  allSettings, clearSettings, findPayLink, getSettings, hasRequired, isLivePayLink, newPayLink, payUrl, providerSecrets,
  saveConfig, setStatus,
} from '../../integrations/state.js';
import { tenantCtx, who } from '../util.js';

const providerParam = { type: 'object', required: ['provider'], properties: { provider: { type: 'string', enum: PROVIDER_IDS } } };

const TESTS = {
  stripe: (s) => testStripe({ secretKey: s['stripe.secret_key'] }),
  resend: (s) => testResend({ apiKey: s['resend.api_key'], from: s['resend.from'] }),
  sendgrid: (s) => testSendgrid({ apiKey: s['sendgrid.api_key'], from: s['sendgrid.from'] }),
  twilio: (s) => testTwilio({ accountSid: s['twilio.account_sid'], authToken: s['twilio.auth_token'], from: s['twilio.from'] }),
  facebook: (s, cfg) => testFacebook({ pageToken: s['facebook.page_token'], appSecret: s['facebook.app_secret'], pageId: cfg.pageId || null }),
  anthropic: (s) => testAnthropic({ apiKey: s['anthropic.api_key'] }),
};

/** Values typed by people get small clean-ups before they are stored. */
function normalise(name, value) {
  const v = String(value ?? '').trim();
  if (name === 'twilio.from') return toE164(v) || v;
  return v;
}

/** One card on the Integrations screen. Never contains a secret value. */
function card(provider, { secrets, settings, tenant, publicOrigin, tenantId }) {
  const def = PROVIDERS[provider];
  const plan = planFor(def.feature);
  const fields = def.secrets.map((f) => {
    const s = secrets.find((x) => x.name === f.name);
    return { name: f.name, label: SECRETS[f.name].label, required: f.required, placeholder: f.placeholder, plain: Boolean(SECRETS[f.name].plain), set: Boolean(s), valid: s ? s.valid : null, hint: s?.hint ?? null, updatedAt: s?.updatedAt ?? null };
  });
  const anySet = fields.some((f) => f.set);
  const missing = fields.filter((f) => f.required && !f.set);
  let status = 'connected';
  let message = settings?.status_message || null;
  if (!anySet) { status = 'not_connected'; message = null; }
  else if (fields.some((f) => f.set && !f.valid)) { status = 'error'; message = 'A saved key can no longer be read. Enter it again.'; }
  else if (missing.length) { status = 'incomplete'; message = `Still needed: ${missing.map((f) => f.label).join(', ')}.`; }
  else if (settings?.status === 'error') status = 'error';
  return {
    provider, label: def.label, blurb: def.blurb, feature: def.feature,
    plan, planName: plan ? PLANS[plan]?.name || plan : null,
    entitled: tenant ? tenantHas(tenant, def.feature) : false,
    status, message,
    check: { status: settings?.status || 'unknown', message: settings?.status_message || null, testedAt: settings?.tested_at || null },
    lastEventAt: settings?.last_event_at || null,
    fields,
    config: settings?.config || {},
    webhookUrl: webhookUrl(publicOrigin, provider, tenantId),
    guide: `guides/${provider}.md`,
  };
}

const notConnected = (label) => new ApiError(409, 'integration_not_connected', `${label} is not connected. An owner or admin can connect it under Integrations.`);

/** The same check the PWA runs before sending (lib/doc-view.js sendCheck): refuse on 'block' only. */
function assertExemption(doc, collection) {
  const p = exemptionProblem(doc, { collection });
  if (p?.level === 'block') throw new ApiError(422, 'exemption_required', p.message, { missing: p.missing || [] });
}

/** Minimal HTML pages for customers paying an invoice. Everything interpolated is escaped. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function payPage(reply, status, title, text, link = null) {
  reply.code(status)
    .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
    .header('referrer-policy', 'no-referrer')
    .type('text/html; charset=utf-8');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f1efea;color:#1c1b19;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}main{max-width:420px;margin:16px;padding:32px;background:#fbfaf7;border:1px solid #e2ded5;border-radius:12px}h1{font-size:22px;margin:0 0 8px}a{color:#8a5a00;font-weight:600}@media (prefers-color-scheme:dark){body{background:#16171a;color:#ecebe7}main{background:#202226;border-color:#33363c}a{color:#ffc53d}}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p>${link ? `<p><a href="${esc(link.href)}">${esc(link.label)}</a></p>` : ''}</main></body></html>`;
}

/** @param {import('fastify').FastifyInstance} app */
export default async function integrationRoutes(app, { config, db, records }) {
  const sealer = app.sealer;

  const audit = (tx, req, e) => appendAudit(tx, tx.tenantId, { actor: req.principal.actor, request: requestFacts(req), ...e });

  async function cards(tx, tenantId) {
    const [secrets, settings, tenant] = [await listSecrets(tx, sealer), await allSettings(tx), await loadTenantPlan(db, tenantId)];
    return PROVIDER_IDS.map((id) => card(id, { secrets: secrets.filter((s) => s.provider === id), settings: settings.get(id), tenant, publicOrigin: config.publicOrigin, tenantId }));
  }

  // ---- the Integrations screen (owner/admin) ---------------------------------

  app.get('/api/v1/integrations', {
    config: { auth: 'admin' },
    schema: { tags: ['integrations'], summary: 'Connection status of every integration (key hints only, never values)' },
  }, async (req) => {
    const data = await db.withTenant(tenantCtx(req.principal), (tx) => cards(tx, tx.tenantId));
    const tenant = await loadTenantPlan(db, req.principal.tenantId);
    return { data, plan: tenant ? effectivePlan(tenant) : null };
  });

  app.put('/api/v1/integrations/:provider', {
    config: { auth: 'admin' },
    schema: {
      tags: ['integrations'], summary: 'Save keys and settings for an integration. Keys are write-only.', params: providerParam,
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          secrets: { type: 'object', additionalProperties: { type: 'string', maxLength: 4096 } },
          config: { type: 'object', additionalProperties: { type: ['string', 'null'], maxLength: 200 } },
        },
      },
    },
  }, async (req) => {
    const provider = req.params.provider;
    const def = providerFor(provider);
    await assertFeature(db, req.principal.tenantId, def.feature);
    const incoming = Object.entries(req.body?.secrets || {}).filter(([, v]) => String(v).trim() !== '');
    const problems = [];
    for (const [name, value] of incoming) {
      const f = def.secrets.find((s) => s.name === name);
      if (!f) { problems.push({ path: `/secrets/${name}`, message: `${def.label} has no field called ${name}.` }); continue; }
      const p = f.check(normalise(name, value));
      if (p) problems.push({ path: `/secrets/${name}`, message: p });
    }
    const cfgIn = req.body?.config || {};
    for (const [k, v] of Object.entries(cfgIn)) {
      const check = def.config[k];
      if (!check) problems.push({ path: `/config/${k}`, message: `Unknown setting ${k}.` });
      else { const p = check(v); if (p) problems.push({ path: `/config/${k}`, message: p }); }
    }
    if (problems.length) throw new ApiError(400, 'validation_failed', problems[0].message, { errors: problems });
    if (!incoming.length && !Object.keys(cfgIn).length) throw badRequest('Nothing to save.');

    const data = await db.withTenant(tenantCtx(req.principal), async (tx) => {
      for (const [name, value] of incoming) await setSecret(tx, sealer, name, normalise(name, value), `user:${req.principal.userId}`);
      if (Object.keys(cfgIn).length) {
        const cur = (await getSettings(tx, provider)).config || {};
        const next = { ...cur };
        for (const [k, v] of Object.entries(cfgIn)) { if (v === '' || v == null) delete next[k]; else next[k] = String(v).trim(); }
        await saveConfig(tx, provider, next);
      }
      if (incoming.length) await setStatus(tx, provider, 'unknown', null);
      await audit(tx, req, {
        action: 'integration.save', collection: 'integrations', recordId: provider,
        summary: `${def.label}: saved ${[...incoming.map(([n]) => SECRETS[n].label), ...Object.keys(cfgIn)].join(', ')}`.slice(0, 300),
      });
      return (await cards(tx, tx.tenantId)).find((c) => c.provider === provider);
    }, { write: true });
    return data;
  });

  app.post('/api/v1/integrations/:provider/test', {
    config: { auth: 'admin' },
    schema: { tags: ['integrations'], summary: 'Check the saved keys with a cheap read-only call to the provider', params: providerParam },
  }, async (req) => {
    const provider = req.params.provider;
    const def = providerFor(provider);
    await assertFeature(db, req.principal.tenantId, def.feature);
    const ctx = tenantCtx(req.principal);
    const { secrets, cfg } = await db.withTenant(ctx, async (tx) => ({ secrets: await providerSecrets(tx, sealer, provider), cfg: (await getSettings(tx, provider)).config || {} }));
    if (!hasRequired(provider, secrets)) throw new ApiError(409, 'integration_incomplete', `Enter every ${def.label} key before testing.`);
    let result;
    try {
      result = await TESTS[provider](secrets, cfg);
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      result = { status: 'error', message: e.message };
    }
    await db.withTenant(ctx, async (tx) => {
      await setStatus(tx, provider, result.status, result.message, { tested: true });
      if (provider === 'facebook' && result.pageId && !cfg.pageId) await saveConfig(tx, provider, { ...cfg, pageId: result.pageId });
      await audit(tx, req, { action: 'integration.test', collection: 'integrations', recordId: provider, summary: `${def.label} test: ${result.status}` });
    }, { write: true });
    return { ok: result.status !== 'error', status: result.status, message: result.message };
  });

  app.delete('/api/v1/integrations/:provider', {
    config: { auth: 'admin' },
    schema: { tags: ['integrations'], summary: 'Disconnect: delete the keys and settings (allowed on any plan)', params: providerParam },
  }, async (req, reply) => {
    const provider = req.params.provider;
    const def = providerFor(provider);
    await db.withTenant(tenantCtx(req.principal), async (tx) => {
      for (const s of def.secrets) await deleteSecret(tx, s.name);
      await clearSettings(tx, provider);
      await audit(tx, req, { action: 'integration.disconnect', collection: 'integrations', recordId: provider, summary: `${def.label} disconnected` });
    }, { write: true });
    reply.code(204);
  });

  app.post('/api/v1/integrations/facebook/subscribe', {
    config: { auth: 'admin' },
    preHandler: requireFeature(db, 'integrations.facebook'),
    schema: { tags: ['integrations'], summary: 'Send the Page\'s new leads to your app (subscribes the Page to leadgen)' },
  }, async (req) => {
    const ctx = tenantCtx(req.principal);
    const { secrets, cfg } = await db.withTenant(ctx, async (tx) => ({ secrets: await providerSecrets(tx, sealer, 'facebook'), cfg: (await getSettings(tx, 'facebook')).config || {} }));
    if (!hasRequired('facebook', secrets)) throw notConnected('Facebook');
    if (!cfg.pageId) throw new ApiError(409, 'page_id_missing', 'Enter the Page ID or press Test connection first.');
    let ok = false;
    let message;
    try {
      ok = (await subscribePage({ pageToken: secrets['facebook.page_token'], appSecret: secrets['facebook.app_secret'], pageId: cfg.pageId })).ok;
      message = ok ? 'Page subscribed. New leads will arrive here.' : 'Facebook did not confirm the subscription.';
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      message = e.message;
    }
    await db.withTenant(ctx, async (tx) => {
      await setStatus(tx, 'facebook', ok ? 'ok' : 'error', message, { tested: true });
      await audit(tx, req, { action: 'integration.facebook_subscribe', collection: 'integrations', recordId: 'facebook', summary: `Facebook Page subscription: ${ok ? 'ok' : 'failed'}` });
    }, { write: true });
    return { ok, message };
  });

  // ---- what other screens may offer (any member) -----------------------------

  app.get('/api/v1/integrations/available', {
    config: { auth: 'tenant', apiKey: false },
    schema: { tags: ['integrations'], summary: 'Which integration actions this company can use right now (no key details)' },
  }, async (req) => {
    const tenant = await loadTenantPlan(db, req.principal.tenantId);
    return db.withTenant(tenantCtx(req.principal), async (tx) => {
      const ready = async (provider, feature) => Boolean(tenant && tenantHas(tenant, feature)) && hasRequired(provider, await providerSecrets(tx, sealer, provider));
      return {
        payments: await ready('stripe', 'payments.online'),
        email: (await ready('sendgrid', 'integrations.email')) || (await ready('resend', 'integrations.email')),
        sms: await ready('twilio', 'integrations.sms'),
      };
    });
  });

  // ---- "Pay online" ---------------------------------------------------------

  app.post('/api/v1/integrations/stripe/pay-link', {
    config: { auth: 'tenant', apiKey: false },
    preHandler: requireFeature(db, 'payments.online'),
    schema: {
      tags: ['integrations'], summary: 'A lasting pay link for an invoice (printed and emailed) plus a Checkout page for its balance now',
      body: { type: 'object', required: ['invoiceId'], additionalProperties: false, properties: { invoiceId: { type: 'string', minLength: 1, maxLength: 128 }, rotate: { type: 'boolean' } } },
    },
  }, async (req, reply) => {
    const p = req.principal;
    if (!canWrite(p, 'invoices')) throw forbidden('You cannot change invoices.');
    const ctx = tenantCtx(p);
    const pre = await db.withTenant(ctx, async (tx) => ({
      secrets: await providerSecrets(tx, sealer, 'stripe'), bal: await invoiceBalance(tx, req.body.invoiceId), settings: await companySettings(tx),
    }));
    if (!hasRequired('stripe', pre.secrets)) throw notConnected('Stripe');
    if (!pre.bal) throw notFound('No such invoice. If it was just created, wait for it to sync and try again.');
    if (pre.bal.invoice.status === 'void') throw new ApiError(409, 'invoice_void', 'This invoice is void.');
    if (pre.bal.balanceCents <= 0) throw new ApiError(409, 'invoice_paid', 'Nothing is owing on this invoice.');
    assertExemption(pre.bal.invoice, 'invoices');
    const currency = (pre.settings.currency || 'CAD').toLowerCase();

    // Reuse the invoice's link unless asked for a new one, so printed copies keep working.
    const out = await db.withTenant(ctx, async (tx) => {
      let url = pre.bal.invoice.payLink?.url || null;
      if (req.body.rotate || !url || !(await isLivePayLink(tx, req.body.invoiceId, url))) {
        const token = await newPayLink(tx, req.body.invoiceId, `user:${p.userId}`);
        url = payUrl(config.publicOrigin, tx.tenantId, token);
        await records.patchRecord(tx, p, 'invoices', req.body.invoiceId, { payLink: { url, createdAt: new Date().toISOString() } }, {}, who(req));
      }
      await appendAudit(tx, tx.tenantId, { actor: p.actor, request: requestFacts(req), action: 'integration.pay_link', collection: 'invoices', recordId: req.body.invoiceId, summary: `Pay link for ${pre.bal.invoice.number || 'invoice'}` });
      return { url };
    }, { write: true });

    let checkout;
    try {
      const token = out.url.split('/').pop();
      checkout = await createCheckoutSession({
        secretKey: pre.secrets['stripe.secret_key'], tenantId: p.tenantId, invoiceId: req.body.invoiceId, invoiceNumber: pre.bal.invoice.number,
        companyName: pre.settings.company?.name, amountCents: pre.bal.balanceCents, currency,
        successUrl: `${config.publicOrigin}/api/v1/pay/${p.tenantId}/${token}/done`, cancelUrl: `${config.publicOrigin}/api/v1/pay/${p.tenantId}/${token}/cancelled`,
      });
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      if (e.kind === 'auth') await db.withTenant(ctx, (tx) => setStatus(tx, 'stripe', 'error', e.message), { write: true });
      throw new ApiError(502, 'provider_error', e.message);
    }
    reply.code(201);
    return { payUrl: out.url, checkoutUrl: checkout.url, checkoutExpiresAt: checkout.expiresAt, amountCents: pre.bal.balanceCents, currency: currency.toUpperCase() };
  });

  // ---- email an invoice or estimate -------------------------------------------

  app.post('/api/v1/integrations/email/document', {
    config: { auth: 'tenant', apiKey: false },
    preHandler: requireFeature(db, 'integrations.email'),
    schema: {
      tags: ['integrations'], summary: 'Email an invoice or estimate to the client from the company\'s own address (sent by the worker within seconds)',
      body: {
        type: 'object', required: ['collection', 'id'], additionalProperties: false,
        properties: {
          collection: { type: 'string', enum: ['invoices', 'estimates'] }, id: { type: 'string', minLength: 1, maxLength: 128 },
          to: { type: 'string', maxLength: 254 }, message: { type: 'string', maxLength: 5000 },
        },
      },
    },
  }, async (req, reply) => {
    const p = req.principal;
    const { collection, id } = req.body;
    if (!canRead(p, collection) || !canWrite(p, 'outbox')) throw forbidden(`You cannot send ${collection}.`);
    const ctx = tenantCtx(p);
    const result = await db.withTenant(ctx, async (tx) => {
      if (!hasRequired('sendgrid', await providerSecrets(tx, sealer, 'sendgrid')) && !hasRequired('resend', await providerSecrets(tx, sealer, 'resend'))) {
        throw notConnected('Email (SendGrid or Resend)');
      }
      const doc = await records.getRecord(tx, p, collection, id);
      assertExemption(doc, collection);
      const settings = await companySettings(tx);
      const company = settings.company || {};
      const client = doc.clientId ? (await tx.query('SELECT data FROM clients WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [tx.tenantId, doc.clientId])).rows[0]?.data : null;
      const to = String(req.body.to || client?.email || '').trim();
      if (!EMAIL_RE.test(to)) throw badRequest('Enter the email address to send it to.');
      const money = (c) => formatMoney(c, { currency: settings.currency || 'CAD' });
      const first = String(client?.name || '').split(/\s+/)[0];
      const what = collection === 'invoices' ? 'Invoice' : 'Estimate';
      const lines = [`Hi${first ? ` ${first}` : ''},`, '', req.body.message?.trim() || `Here is ${what.toLowerCase()} ${doc.number || ''}${doc.title ? ` for ${doc.title}` : ''} from ${company.name || 'us'}.`, ''];
      if (collection === 'invoices') {
        const bal = await invoiceBalance(tx, id);
        lines.push(`Amount due: ${money(bal.balanceCents)}${doc.dueDate ? ` (due ${doc.dueDate})` : ''}`);
        const tenant = await loadTenantPlan(db, tx.tenantId);
        const payable = bal.balanceCents > 0 && doc.payLink?.url && tenantHas(tenant, 'payments.online') && hasRequired('stripe', await providerSecrets(tx, sealer, 'stripe'));
        if (payable) lines.push(`Pay online: ${doc.payLink.url}`);
      } else {
        lines.push(`Total: ${money(docTotals(doc).totalCents)}${doc.validUntil ? ` (valid until ${doc.validUntil})` : ''}`, 'Reply to this email to accept it or to ask a question.');
      }
      lines.push('', company.phone ? `Questions? Reply to this email or call ${company.phone}.` : 'Questions? Reply to this email.', '', company.name || '', company.address || '',
        company.gstHstNo ? `GST/HST No. ${company.gstHstNo}` : '');
      const outbox = await records.createRecord(tx, p, 'outbox', {
        channel: 'email', kind: collection === 'invoices' ? 'invoice' : 'estimate', to,
        subject: `${what} ${doc.number || ''} from ${company.name || 'your contractor'}`.replace(/\s+/g, ' ').trim().slice(0, 300),
        body: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), relatedId: id, status: 'queued', dueAt: new Date().toISOString(),
      }, who(req));
      if (doc.status === 'draft' && canWrite(p, collection)) await records.patchRecord(tx, p, collection, id, { status: 'sent' }, {}, who(req));
      await enqueueSend(tx, tx.tenantId, outbox.id);
      return outbox;
    }, { write: true });
    reply.code(201);
    return { outbox: result, queued: true };
  });

  // ---- the customer's pay page (public) ------------------------------------------

  const payLimit = config.rateLimit.enabled ? { max: 30, timeWindow: '1 minute', keyGenerator: (req) => `pay:${req.ip}` } : false;
  const payOpts = { logLevel: 'warn', config: { auth: 'public', rateLimit: payLimit }, schema: { hide: true } };
  const notValid = (reply) => payPage(reply, 404, 'Payment link not found', 'This payment link is not valid. It may have been replaced by a newer one; check your latest invoice or contact your contractor.');

  async function loadPay(tenantId, token) {
    if (!isUuid(tenantId)) return null;
    return db.withTenant({ tenantId }, async (tx) => {
      const invoiceId = await findPayLink(tx, token);
      if (!invoiceId) return null;
      return { invoiceId, bal: await invoiceBalance(tx, invoiceId), settings: await companySettings(tx), secrets: await providerSecrets(tx, sealer, 'stripe') };
    }, { write: true });
  }

  app.get('/api/v1/pay/:tenantId/:token', payOpts, async (req, reply) => {
    const { tenantId, token } = req.params;
    const d = await loadPay(tenantId, token);
    if (!d) return notValid(reply);
    const company = d.settings.company?.name || 'your contractor';
    if (!d.bal) return payPage(reply, 404, 'Invoice not found', `This invoice is no longer available. Please contact ${company}.`);
    if (d.bal.invoice.status === 'void') return payPage(reply, 410, 'Invoice cancelled', `This invoice was cancelled. Please contact ${company} if you have questions.`);
    if (d.bal.balanceCents <= 0) return payPage(reply, 200, 'Paid in full', `Invoice ${d.bal.invoice.number || ''} is paid. Thank you!`);
    const tenant = await loadTenantPlan(db, tenantId);
    if (!tenant || !tenantHas(tenant, 'payments.online') || !hasRequired('stripe', d.secrets)) {
      return payPage(reply, 503, 'Online payment unavailable', `Online payment is not available for this invoice right now. Please contact ${company} to pay another way.`);
    }
    try {
      const s = await createCheckoutSession({
        secretKey: d.secrets['stripe.secret_key'], tenantId, invoiceId: d.invoiceId, invoiceNumber: d.bal.invoice.number, companyName: company,
        amountCents: d.bal.balanceCents, currency: (d.settings.currency || 'CAD').toLowerCase(),
        successUrl: `${config.publicOrigin}/api/v1/pay/${tenantId}/${token}/done`, cancelUrl: `${config.publicOrigin}/api/v1/pay/${tenantId}/${token}/cancelled`,
      });
      return reply.code(303).header('location', s.url).send();
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      if (e.kind === 'auth') await db.withTenant({ tenantId }, (tx) => setStatus(tx, 'stripe', 'error', e.message), { write: true });
      return payPage(reply, 503, 'Online payment unavailable', `We could not open the payment page. Please try again later or contact ${company}.`);
    }
  });

  app.get('/api/v1/pay/:tenantId/:token/done', payOpts, async (req, reply) => {
    const d = await loadPay(req.params.tenantId, req.params.token);
    if (!d) return notValid(reply);
    return payPage(reply, 200, 'Thank you', `Your payment to ${d.settings.company?.name || 'your contractor'} is being processed. Stripe will email you a receipt.`);
  });

  app.get('/api/v1/pay/:tenantId/:token/cancelled', payOpts, async (req, reply) => {
    const d = await loadPay(req.params.tenantId, req.params.token);
    if (!d) return notValid(reply);
    return payPage(reply, 200, 'Payment cancelled', 'No payment was taken.', { href: `${config.publicOrigin}/api/v1/pay/${req.params.tenantId}/${req.params.token}`, label: 'Try again' });
  });
}

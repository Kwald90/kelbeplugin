// Online booking front door (resi service-shop). Two sides share this module:
//   - the PUBLIC resolver + intake (routes/public-booking.js): resolve a tenant from a slug with
//     NO tenant context (the slug IS the tenant key, exactly like resolveCampaign in marketing.js),
//     read the shop's booking config from its settings doc, and create ONE kind:'service' lead.
//   - the signed-in owner's claim (routes/v1/booking.js): claim/rename/enable THIS tenant's slug.
//
// A "service request" is NOT a new collection: it is a `leads` record tagged kind:'service', so it
// rides the existing pipeline and the office "Service requests" inbox. The pure shape + helpers the
// PWA uses are in electrical-app/js/lib/service-requests.js and electrical-app/js/lib/booking.js;
// the two id lists below MUST match service-requests.js SERVICE_TYPES / URGENCY (a test asserts it).
import { randomUUID } from 'node:crypto';
import { appendAudit } from './audit.js';

/** Service types a homeowner can pick. Ids mirror electrical-app/js/lib/service-requests.js. */
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
export const SERVICE_TYPE_IDS = SERVICE_TYPES.map((t) => t.id);

/** How soon. Ids mirror electrical-app/js/lib/service-requests.js URGENCY. */
export const URGENCY = [
  { id: 'emergency', label: 'Emergency — no power / unsafe' },
  { id: 'urgent', label: 'Urgent — within a day or two' },
  { id: 'soon', label: 'Soon — this week' },
  { id: 'flexible', label: 'Flexible — whenever works' },
];
export const URGENCY_IDS = URGENCY.map((u) => u.id);

/** Optional intake fields the shop can switch off. Name/phone/service type are always collected. */
export const OPTIONAL_FIELDS = ['email', 'address', 'preferredTimes', 'urgency'];

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
/** null when ok, else a human reason. 2-63 chars: lower-case letters, numbers and dashes. */
export function slugProblem(slug) {
  if (typeof slug !== 'string' || !slug) return 'Choose a web address for your booking page.';
  if (!SLUG_RE.test(slug)) return 'Use 2–63 characters: lower-case letters, numbers and dashes.';
  return null;
}
export const validSlug = (slug) => slugProblem(slug) === null;

const str = (v, max) => (typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, max) : '');
const labelOf = (list, id) => list.find((x) => x.id === id)?.label || '';

/**
 * The public, safe view of a shop's booking config, read from its settings doc under `booking`.
 * Unknown fields are dropped; every list is bounded to the known ids; strings are capped. Returns
 * what the booking form needs to render, and never anything internal.
 */
export function publicBookingConfig(settings, { tenantName = '' } = {}) {
  const b = settings && typeof settings.booking === 'object' && settings.booking ? settings.booking : {};
  const co = settings && typeof settings.company === 'object' && settings.company ? settings.company : {};
  const wanted = Array.isArray(b.serviceTypes) ? b.serviceTypes : null;
  const types = SERVICE_TYPES.filter((t) => !wanted || wanted.includes(t.id));
  const offered = types.length ? types : SERVICE_TYPES;
  const fieldsRaw = b.fields && typeof b.fields === 'object' ? b.fields : {};
  const fields = {};
  // A field shows unless the shop explicitly turned it off (default on).
  for (const f of OPTIONAL_FIELDS) fields[f] = fieldsRaw[f] !== false;
  return {
    businessName: str(b.businessName, 120) || str(co.name, 120) || str(tenantName, 120) || 'Book a service call',
    intro: str(b.intro, 600),
    serviceTypes: offered.map((t) => ({ id: t.id, label: t.label })),
    urgency: URGENCY.map((u) => ({ id: u.id, label: u.label })),
    fields,
    confirmation: str(b.confirmation, 600) || 'Thanks — we have your request and will be in touch shortly.',
    contactPhone: str(b.contactPhone, 40) || str(co.phone, 40),
    contactEmail: str(b.contactEmail, 254) || str(co.email, 254),
  };
}

/**
 * Build the stored body of a kind:'service' lead from validated intake. Mirrors newServiceRequest
 * in electrical-app/js/lib/service-requests.js: the title reads well on the Leads board without any
 * service-aware rendering; an unknown type becomes 'other' and a blank urgency 'flexible'.
 */
export function buildServiceLead(input = {}, { source = 'booking' } = {}) {
  const serviceType = SERVICE_TYPE_IDS.includes(input.serviceType) ? input.serviceType : 'other';
  const urgency = URGENCY_IDS.includes(input.urgency) ? input.urgency : 'flexible';
  const contactName = str(input.contactName, 200);
  return {
    kind: 'service',
    stage: 'new',
    source: str(source, 100) || 'booking',
    title: `${labelOf(SERVICE_TYPES, serviceType) || 'Service'}${contactName ? ` — ${contactName}` : ''}`,
    contactName,
    phone: str(input.phone, 40),
    email: str(input.email, 254),
    serviceType,
    urgency,
    serviceAddress: str(input.address, 300),
    preferredTimes: str(input.preferredTimes, 300),
    notes: str(input.description, 20000),
  };
}

// ---- resolver (public, app pool: no tenant context) -----------------------------------------

/**
 * Resolve a public slug to its tenant, or null when the slug is unknown or the page is disabled.
 * Runs on the app pool (db.query) with no tenant context: this is what establishes the tenant for
 * the public intake. Never reveals whether a tenant exists beyond the slug the caller already has.
 * @returns {Promise<{ tenantId: string } | null>}
 */
export async function resolveBookingTenant(db, slug) {
  if (!validSlug(slug)) return null;
  const { rows } = await db.query('SELECT tenant_id, enabled FROM booking_pages WHERE slug = $1', [slug]);
  const r = rows[0];
  if (!r || !r.enabled) return null;
  return { tenantId: r.tenant_id };
}

/**
 * Create the service-request lead in the resolved tenant. Uses a system/public actor; writes ONLY
 * a kind:'service' lead and nothing else. Within withTenant the app role's RLS backstops the write.
 * @returns {Promise<{ id: string }>}
 */
export async function createServiceLead(db, tenantId, input, { request = {}, source = 'booking' } = {}) {
  const id = randomUUID();
  const nowIso = new Date().toISOString();
  const data = { ...buildServiceLead(input, { source }), createdAt: nowIso, updatedAt: nowIso };
  return db.withTenant({ tenantId, userId: null }, async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO leads (tenant_id, id, data, created_by, updated_by)
       VALUES ($1, $2, $3, 'system:booking', 'system:booking') RETURNING id`,
      [tenantId, id, data]);
    await appendAudit(tx, tenantId, {
      actor: { type: 'system', id: 'booking', label: 'Online booking' },
      action: 'record.create', collection: 'leads', recordId: id,
      summary: data.title, meta: { via: 'booking', serviceType: data.serviceType, urgency: data.urgency }, request,
    });
    return { id: rows[0].id };
  }, { write: true });
}

// ---- owner's page (signed in, app pool scoped to the caller's tenant) ------------------------

export const pageView = (row) => (row
  ? { slug: row.slug, enabled: row.enabled, updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null }
  : null);

/** This tenant's booking page row, or null if it has never claimed a slug. */
export async function getBookingPage(db, tenantId) {
  const { rows } = await db.query('SELECT slug, enabled, updated_at FROM booking_pages WHERE tenant_id = $1', [tenantId]);
  return pageView(rows[0] || null);
}

/**
 * Claim or update THIS tenant's slug + enabled flag. Global uniqueness is enforced by the UNIQUE
 * constraint; a taken slug surfaces as a unique-violation (23505) for the route to turn into 409.
 */
export async function saveBookingPage(db, tenantId, { slug, enabled }) {
  const { rows } = await db.query(
    `INSERT INTO booking_pages (tenant_id, slug, enabled) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id) DO UPDATE SET slug = EXCLUDED.slug, enabled = EXCLUDED.enabled, updated_at = now()
     RETURNING slug, enabled, updated_at`,
    [tenantId, slug, enabled]);
  return pageView(rows[0]);
}

// ---- the embeddable page (served by routes/public-booking.js) -------------------------------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The self-contained booking page HTML, frameable on the shop's own website. Its whole CSP is set
 * on the response (frame-ancestors *; style/script allowed only by this response's nonce), so it
 * carries no inline event handlers and references no cross-origin resource. It fetches its config
 * from /config and POSTs the request back to the same origin.
 */
export function renderBookingPage({ slug, nonce }) {
  const s = esc(slug);
  const n = esc(nonce);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Book a service call</title>
<style nonce="${n}">
:root{--fg:#111827;--muted:#6b7280;--line:#e5e7eb;--bg:#ffffff;--accent:#1d4ed8;--accent-fg:#ffffff;--err:#b91c1c;--ok:#047857}
@media (prefers-color-scheme:dark){:root{--fg:#f3f4f6;--muted:#9ca3af;--line:#374151;--bg:#0b0f17;--accent:#3b82f6;--accent-fg:#06101f}}
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg);padding:16px}
.wrap{max-width:560px;margin:0 auto}
h1{font-size:1.35rem;margin:0 0 .25rem}
.intro{color:var(--muted);margin:0 0 1rem}
.field{margin:0 0 .85rem}
label{display:block;font-weight:600;margin:0 0 .25rem;font-size:.95rem}
.req{color:var(--err)}
input,select,textarea{width:100%;padding:.6rem .7rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
textarea{min-height:90px;resize:vertical}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
button{width:100%;padding:.75rem 1rem;border:0;border-radius:8px;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:700;cursor:pointer}
button[disabled]{opacity:.6;cursor:default}
.msg{padding:.75rem;border-radius:8px;margin:0 0 1rem}
.msg.err{background:rgba(185,28,28,.1);color:var(--err)}
.msg.ok{background:rgba(4,120,87,.1);color:var(--ok)}
.foot{color:var(--muted);font-size:.85rem;margin:1rem 0 0;text-align:center}
.hidden{display:none}
</style>
</head>
<body>
<div class="wrap">
  <div id="loading" class="intro">Loading…</div>
  <div id="app" class="hidden">
    <h1 id="title">Book a service call</h1>
    <p id="intro" class="intro"></p>
    <div id="result" class="msg hidden" role="status" aria-live="polite"></div>
    <form id="form" novalidate>
      <div class="field"><label for="contactName">Your name <span class="req">*</span></label><input id="contactName" name="contactName" maxlength="200" autocomplete="name" required></div>
      <div class="field"><label for="phone">Phone <span class="req">*</span></label><input id="phone" name="phone" type="tel" maxlength="40" autocomplete="tel" required></div>
      <div class="field" data-field="email"><label for="email">Email</label><input id="email" name="email" type="email" maxlength="254" autocomplete="email"></div>
      <div class="field"><label for="serviceType">What do you need? <span class="req">*</span></label><select id="serviceType" name="serviceType" required></select></div>
      <div class="field" data-field="urgency"><label for="urgency">How soon?</label><select id="urgency" name="urgency"></select></div>
      <div class="field" data-field="address"><label for="address">Service address</label><input id="address" name="address" maxlength="300" autocomplete="street-address"></div>
      <div class="field" data-field="preferredTimes"><label for="preferredTimes">Preferred times</label><input id="preferredTimes" name="preferredTimes" maxlength="300"></div>
      <div class="field"><label for="description">Tell us about the job</label><textarea id="description" name="description" maxlength="20000"></textarea></div>
      <div class="hp" aria-hidden="true"><label>Leave this field empty<input id="website" name="website" tabindex="-1" autocomplete="off"></label></div>
      <button id="submit" type="submit">Request a visit</button>
    </form>
    <p class="foot">Powered by Fishtape</p>
  </div>
</div>
<script nonce="${n}">
(function(){
  var slug=${JSON.stringify(s)};
  var base='/api/v1/public/book/'+encodeURIComponent(slug);
  var loading=document.getElementById('loading'),app=document.getElementById('app');
  function show(el,on){el.classList.toggle('hidden',!on);}
  function result(kind,text){var r=document.getElementById('result');r.className='msg '+kind;r.textContent=text;show(r,true);}
  function opt(sel,id,label){var o=document.createElement('option');o.value=id;o.textContent=label;sel.appendChild(o);}
  fetch(base+'/config',{headers:{'accept':'application/json'}}).then(function(res){
    if(!res.ok)throw new Error(String(res.status));return res.json();
  }).then(function(c){
    document.getElementById('title').textContent=c.businessName||'Book a service call';
    if(c.intro)document.getElementById('intro').textContent=c.intro;
    var st=document.getElementById('serviceType');
    (c.serviceTypes||[]).forEach(function(t){opt(st,t.id,t.label);});
    var ug=document.getElementById('urgency');
    (c.urgency||[]).forEach(function(u){opt(ug,u.id,u.label);});
    var f=c.fields||{};
    ['email','urgency','address','preferredTimes'].forEach(function(name){
      if(f[name]===false){var el=document.querySelector('[data-field="'+name+'"]');if(el)el.remove();}
    });
    show(loading,false);show(app,true);
    var okMsg=c.confirmation||'Thanks — we have your request and will be in touch shortly.';
    var form=document.getElementById('form'),btn=document.getElementById('submit');
    form.addEventListener('submit',function(e){
      e.preventDefault();
      var body={};['contactName','phone','email','serviceType','urgency','address','preferredTimes','description','website'].forEach(function(k){
        var el=form.elements[k];if(el)body[k]=el.value;
      });
      if(!body.contactName||!body.phone){result('err','Please add your name and phone number.');return;}
      btn.disabled=true;result('ok','Sending…');
      fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(res){
        return res.json().then(function(j){return{ok:res.ok,status:res.status,j:j};});
      }).then(function(r){
        if(r.ok){form.classList.add('hidden');result('ok',okMsg);}
        else{btn.disabled=false;result('err',(r.j&&r.j.error&&r.j.error.message)||'Sorry, that did not go through. Please try again.');}
      }).catch(function(){btn.disabled=false;result('err','Could not reach the server. Please try again.');});
    });
  }).catch(function(){loading.textContent='This booking page is not available.';});
})();
</script>
</body>
</html>`;
}

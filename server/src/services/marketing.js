// Marketing hub: the editable sell-side pieces (the catalog and anything co-branded for a
// wholesaler) and the tracked trial links. Two platform tables (0169_marketing.sql), no tenant.
//
//  - Pieces hold a block model: an ordered list of sections, each a cover, a grid of feature
//    cards, or a call-to-action. HQ edits and reorders them (drag-and-drop in hq/js/pages/
//    marketing.js); a published piece renders at /site/piece.html?slug=... co-branded.
//  - Campaigns are the tracked links. Each carries a trial length (75 days by default) and an
//    optional plan. /api/v1/public/campaign/:code resolves a link and counts a visit; the code
//    rides the sign-up body into signups.campaign_code, so HQ shows which link drove which
//    sign-up (starts and completions are COUNTs over signups, not a counter that can drift).
//
// HQ reads/writes through db.withHq (BYPASSRLS); the public side uses the app pool (db.query),
// which has SELECT on both tables and UPDATE (visits) on campaigns and full DML on signups.
import { randomUUID } from 'node:crypto';

const SECTION_KINDS = ['cover', 'features', 'cta'];
const MAX_SECTIONS = 40;
const MAX_CARDS = 16;
const PIECE_KINDS = ['catalog', 'flyer', 'onepager', 'email'];

const str = (v, max) => (typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, max) : '');
const id = (v) => (typeof v === 'string' && /^[a-z0-9]{1,24}$/.test(v) ? v : `b${randomUUID().slice(0, 8)}`);

/** One section cleaned to its kind's shape; unknown fields dropped, strings capped, id kept/made. */
function normalizeSection(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = SECTION_KINDS.includes(raw.kind) ? raw.kind : 'features';
  const base = { id: id(raw.id), kind };
  if (kind === 'cover') {
    return { ...base, title: str(raw.title, 160), subtitle: str(raw.subtitle, 600), footnote: str(raw.footnote, 300) };
  }
  if (kind === 'cta') {
    return { ...base, heading: str(raw.heading, 160), body: str(raw.body, 600), footnote: str(raw.footnote, 300) };
  }
  const cards = Array.isArray(raw.cards) ? raw.cards.slice(0, MAX_CARDS).map((c) => ({
    id: id(c?.id), title: str(c?.title, 80), body: str(c?.body, 400),
  })).filter((c) => c.title || c.body) : [];
  return { ...base, heading: str(raw.heading, 160), intro: str(raw.intro, 600), cards };
}

/** The whole block model normalized: an object with a bounded, well-formed sections array. */
export function normalizeContent(raw) {
  const sections = Array.isArray(raw?.sections)
    ? raw.sections.slice(0, MAX_SECTIONS).map(normalizeSection).filter(Boolean)
    : [];
  return { sections };
}

/** Co-brand overlay for a piece: a partner name, a tagline and an accent colour (all optional). */
export function normalizeCobrand(raw) {
  const accent = str(raw?.accent, 9);
  return {
    enabled: Boolean(raw?.enabled),
    partner: str(raw?.partner, 80),
    tagline: str(raw?.tagline, 160),
    accent: /^#[0-9a-fA-F]{6}$/.test(accent) ? accent.toLowerCase() : '',
  };
}

const feat = (title, body) => ({ id: id(), title, body });

/** The default catalog, the same content as site/catalog.html, as an editable block model. */
export function defaultCatalog() {
  return normalizeContent({
    sections: [
      { kind: 'cover', title: 'The whole electrical business in one app.', subtitle: 'Code calculators, bending, take-off, estimating, the crew, the paperwork and the customer — built for Canadian electrical contractors, works offline on site.', footnote: 'Fishtape · made for Canadian electrical contractors' },
      { kind: 'features', heading: 'Stop running your shop out of five apps and a notepad.', intro: 'Fishtape puts the code book, the drawings, the quote, the crew and the customer in one place — on the iPad in the truck and in the office, kept in step.', cards: [] },
      { kind: 'features', heading: 'The code-book maths, with the rule beside every answer.', cards: [
        feat('CEC calculators', 'Conductor ampacity, voltage drop, conduit fill, box fill, dwelling and apartment demand loads, motors and bonding — each answer shows the rule it came from.'),
        feat('Place the boxes', 'Draw a room and Fishtape proposes receptacles, switches, lights and alarms, then checks the layout against CEC 2024 rules like 26-722 spacing, GFCI and AFCI.'),
        feat('No guessing on inspection', 'Every calculation cites the article, so you can show your work to the inspector and the apprentice both.'),
        feat('Metric or imperial', 'Work the way your drawings do; Fishtape keeps the units straight.'),
      ] },
      { kind: 'features', heading: 'Every mark for every bend, drawn to scale.', cards: [
        feat('Pipe bending', 'Offsets, kicks, 3- and 4-point saddles, 90s, back-to-backs, box offsets, rolling offsets and segment bends — with a to-scale diagram and every mark. Metric or imperial.'),
        feat('Wire runs by AR', 'Measure runs with an AR tape on iPhone and iPad, trace them on a plan, or type them in. Drops, box make-up and waste included, rolls suggested, pushed to the estimate.'),
        feat('Marks, not math', 'Hold the phone level, read the marks off the screen, mark the pipe. The saddle, the shrink and the shift are already worked out.'),
        feat('Straight to the quote', 'The wire you measured becomes a line on the estimate, so the take-off and the quote never drift apart.'),
      ] },
      { kind: 'features', heading: 'The whole plan set, marked up and counted.', cards: [
        feat('Any plan set', 'Drop in a multi-page PDF, set the scale once and work sheet by sheet.'),
        feat('Mark & count', 'Stamp electrical symbols on the plan; the device count rolls into the take-off.'),
        feat('Apple Pencil', "Trace and annotate on the iPad the way you'd red-line on paper."),
        feat('Works offline', 'Mark up the plans in the basement or the field and sync later.'),
      ] },
      { kind: 'features', heading: 'From the quote to getting paid, with Canadian tax done right.', cards: [
        feat('Your price book', 'Build quotes from your own prices and reusable assemblies — a kit of material plus labour hours you drop onto an estimate.'),
        feat('Canadian tax, automatically', 'GST, HST, PST and RST applied by province, so the invoice is right the first time.'),
        feat('Estimate → job → invoice', 'Approve the quote and it becomes the job and the invoice; nothing is typed twice.'),
        feat('Paid online', 'Customers pay by card from the invoice; the money and the status come back to you.'),
      ] },
      { kind: 'features', heading: 'Schedule the crew and track the hours without chasing timesheets.', cards: [
        feat('Work plans', "Plan a job by phase and day and publish tomorrow's tasks to each worker's “My day”; collect progress and photos from site."),
        feat('Crew time', 'Clock in and out against a job on a shared iPad with a PIN, breaks tracked, weekly timesheets approved.'),
        feat('Hours by job & person', 'See where the hours went, on-time vs blocked, and export to CSV for payroll.'),
        feat('Photos from site', 'Progress comes back with pictures, so the office sees the job without a drive-out.'),
      ] },
      { kind: 'features', heading: 'Every lead followed up, every client in one place.', cards: [
        feat('One client list', 'Every client, job, quote and invoice in one place — not scattered across a phone and an inbox.'),
        feat('Leads pipeline', 'Track leads through a funnel and see your conversion, so nothing slips.'),
        feat('Follow-up sequences', "Automatic email and text follow-ups so a quote doesn't go cold."),
        feat('Lead-capture website', 'A simple site that sends enquiries — and Facebook Lead Ads — straight into your leads.'),
      ] },
      { kind: 'features', heading: 'Video site walkthroughs, service agreements, test reports.', cards: [
        feat('Video walkthroughs', 'Walk the site talking; it records video and audio, grabs photos as you go, transcribes the audio and lets you group the shots into a visual report for the client.'),
        feat('Service agreements & assets', 'Recurring maintenance with a due list and a per-site equipment registry — make, model, serial, warranty and nameplate photos.'),
        feat('Test & commissioning', 'Megger, bonding, GFCI-trip and torque readings with an automatic pass/fail against the limit, plus the instrument and its cal date.'),
        feat('Supplier price-list import', "Upload a distributor's price file and update your costs by part number, so your quotes use today's prices."),
      ] },
      { kind: 'features', heading: 'The safety binder, filled in from the field.', cards: [
        feat('FLHAs', 'Field level hazard assessments filled in on the phone before the work starts.'),
        feat('Toolbox talks', 'Run the talk and collect signatures from the crew on the spot.'),
        feat('Incidents & near misses', 'Report and investigate, with the record kept for you.'),
        feat('Inspections & training', 'Equipment and site inspections, training and orientations, all logged.'),
      ] },
      { kind: 'features', heading: 'Connects to what you use. Keeps your data yours.', cards: [
        feat('Integrations', 'Export to QuickBooks Online; connect your own Stripe, SendGrid or Resend, Twilio and Facebook Lead Ads.'),
        feat('Bring your data', 'Import clients and price books from Jobber, QuickBooks and Housecall Pro.'),
        feat('Made for iPad & iPhone', 'Works offline on site and syncs when you’re back in range; Apple Pencil on drawings; a native App Store app with an AR tape measure.'),
        feat('Your data stays yours', "Each company's data kept separate with database row-level security, two-step sign-in, encrypted keys, an audit trail and backups."),
      ] },
      { kind: 'cta', heading: 'Try the whole app free for 75 days.', body: 'Scan the code or go to the link on this page to start your trial. No long contract — see what the crew thinks on a real job first.', footnote: 'Fishtape · fishtapehq.com' },
    ],
  });
}

// ---- API view -------------------------------------------------------------------------------

export function pieceView(row) {
  return {
    id: row.id, slug: row.slug, title: row.title, kind: row.kind, status: row.status,
    content: row.content || { sections: [] }, cobrand: normalizeCobrand(row.cobrand || {}),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

// ---- HQ side (db.withHq) --------------------------------------------------------------------

/** Every piece, newest first. Seeds the default catalog the first time the table is empty. */
export async function listPieces(c, { seederId = null } = {}) {
  let { rows } = await c.query('SELECT * FROM marketing_pieces ORDER BY created_at');
  if (!rows.length) {
    await c.query(
      `INSERT INTO marketing_pieces (id, slug, title, kind, status, content, updated_by)
       VALUES ($1, 'catalog', 'Fishtape sales catalog', 'catalog', 'published', $2, $3)
       ON CONFLICT (slug) DO NOTHING`,
      [randomUUID(), JSON.stringify(defaultCatalog()), seederId]);
    ({ rows } = await c.query('SELECT * FROM marketing_pieces ORDER BY created_at'));
  }
  return rows.map(pieceView);
}

export async function getPiece(c, pieceId) {
  const { rows } = await c.query('SELECT * FROM marketing_pieces WHERE id = $1', [pieceId]);
  return rows[0] ? pieceView(rows[0]) : null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const slugProblem = (slug) => (SLUG_RE.test(slug) ? null : 'A slug is 1–63 characters: lower-case letters, numbers and dashes.');

export async function createPiece(c, { slug, title, kind = 'catalog' }, userId) {
  const pieceId = randomUUID();
  await c.query(
    `INSERT INTO marketing_pieces (id, slug, title, kind, status, content, updated_by)
     VALUES ($1, $2, $3, $4, 'draft', $5, $6)`,
    [pieceId, slug, title, PIECE_KINDS.includes(kind) ? kind : 'catalog', JSON.stringify({ sections: [] }), userId]);
  return getPiece(c, pieceId);
}

/** Save editable fields of a piece. Only the keys present are changed. */
export async function savePiece(c, pieceId, patch, userId) {
  const sets = ['updated_by = $2', 'updated_at = now()'];
  const vals = [pieceId, userId];
  const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
  if (patch.title !== undefined) add('title', str(patch.title, 160) || 'Untitled');
  if (patch.status !== undefined) add('status', patch.status === 'published' ? 'published' : 'draft');
  if (patch.content !== undefined) add('content', JSON.stringify(normalizeContent(patch.content)));
  if (patch.cobrand !== undefined) add('cobrand', JSON.stringify(normalizeCobrand(patch.cobrand)));
  if (patch.slug !== undefined) add('slug', patch.slug);
  await c.query(`UPDATE marketing_pieces SET ${sets.join(', ')} WHERE id = $1`, vals);
  return getPiece(c, pieceId);
}

export async function deletePiece(c, pieceId) {
  const { rowCount } = await c.query('DELETE FROM marketing_pieces WHERE id = $1', [pieceId]);
  return { removed: rowCount > 0 };
}

/** Campaigns with their live funnel: visits (landed), starts (any sign-up) and completed. */
export async function listCampaigns(c) {
  const { rows } = await c.query('SELECT * FROM marketing_campaigns ORDER BY created_at DESC');
  const { rows: stats } = await c.query(
    `SELECT campaign_code, count(*)::int AS starts, count(*) FILTER (WHERE status = 'completed')::int AS completed
       FROM signups WHERE campaign_code IS NOT NULL GROUP BY campaign_code`);
  const byCode = Object.fromEntries(stats.map((s) => [s.campaign_code, s]));
  const { rows: slugs } = await c.query('SELECT id, slug FROM marketing_pieces');
  const slugOf = Object.fromEntries(slugs.map((p) => [p.id, p.slug]));
  return rows.map((r) => ({
    code: r.code, label: r.label, pieceId: r.piece_id, pieceSlug: r.piece_id ? slugOf[r.piece_id] || null : null,
    trialDays: r.trial_days, plan: r.plan, active: r.active, visits: r.visits,
    starts: byCode[r.code]?.starts || 0, completed: byCode[r.code]?.completed || 0,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  }));
}

/** Create or update a campaign by its code (the code itself never changes once made). */
export async function saveCampaign(c, code, { label, trialDays, plan = null, pieceId = null, active = true }, userId) {
  await c.query(
    `INSERT INTO marketing_campaigns (code, label, piece_id, trial_days, plan, active, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, piece_id = EXCLUDED.piece_id,
       trial_days = EXCLUDED.trial_days, plan = EXCLUDED.plan, active = EXCLUDED.active,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [code, label, pieceId, trialDays, plan, active, userId]);
}

export async function deleteCampaign(c, code) {
  const { rowCount } = await c.query('DELETE FROM marketing_campaigns WHERE code = $1', [code]);
  return { removed: rowCount > 0 };
}

// ---- public side (app pool, db.query) -------------------------------------------------------

const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const validCode = (code) => typeof code === 'string' && CODE_RE.test(code);

/**
 * Resolve a tracked link to its trial terms, or null if the code is unknown or switched off.
 * Counts the visit as a side effect (best-effort; a failed count never blocks the sign-up page).
 */
export async function resolveCampaign(db, code, { countVisit = false } = {}) {
  if (!validCode(code)) return null;
  const { rows } = await db.query(
    `SELECT m.code, m.label, m.trial_days, m.plan, m.active, p.slug AS piece_slug
       FROM marketing_campaigns m LEFT JOIN marketing_pieces p ON p.id = m.piece_id
      WHERE m.code = $1`, [code]);
  const r = rows[0];
  if (!r || !r.active) return null;
  if (countVisit) await db.query('UPDATE marketing_campaigns SET visits = visits + 1 WHERE code = $1', [code]).catch(() => {});
  return { code: r.code, label: r.label, trialDays: r.trial_days, plan: r.plan, pieceSlug: r.piece_slug };
}

/** A published piece for the public render page, or null. */
export async function publishedPiece(db, slug) {
  if (!SLUG_RE.test(String(slug || ''))) return null;
  const { rows } = await db.query("SELECT * FROM marketing_pieces WHERE slug = $1 AND status = 'published'", [slug]);
  return rows[0] ? pieceView(rows[0]) : null;
}

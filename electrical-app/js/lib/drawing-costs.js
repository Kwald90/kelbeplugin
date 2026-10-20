// Cost impact of drawing changes (money roles only). Pure helpers, shared by the canvas
// editor's Changes panel and GET /api/v1/drawings/:id/cost-impact.
//
// The job's drawings are counted the way the estimate takeoff counts them (a GFCI-flagged
// receptacle is a GFCI) and compared with the job's estimate: the quantity of each estimate
// line whose price-book item carries a symbol, plus the symbol lines of change orders
// already raised from the drawings (anything not rejected). What is left is the difference,
// priced from the price book: material at the item's price plus the estimate's markup, and
// labour hours at the item's hours. Labour hours become a labour line (at the estimate's or
// company's labour rate) only when the estimate charges labour separately; otherwise
// price-book prices already include it (lib/money.js) and the hours are for planning.
import { countWords, firstName, itemTime, person } from './drawing-collab.js';

/** Roles that always see money. Foremen do when the company allows it (settings.foremanSeesCosts). */
export const MONEY_ROLES = ['owner', 'admin', 'office'];

/**
 * Can this person see prices, costs and the cost impact?
 * @param {{ role?: string|null, perms?: Set<string>|string[] }} who
 * @param {{ foremanSeesCosts?: boolean }} [settings]
 */
export function canSeeMoney(who, settings = {}) {
  const perms = who?.perms;
  const has = perms instanceof Set ? perms.has('estimates') : Array.isArray(perms) && perms.includes('estimates');
  if (has || MONEY_ROLES.includes(who?.role)) return true;
  return who?.role === 'foreman' && settings?.foremanSeesCosts === true;
}

const add = (o, k, n) => { if (!k || !n) return; o[k] = (o[k] || 0) + n; if (!o[k]) delete o[k]; };

/** The symbol an object is priced as. */
export const pricedSymbol = (o) => (o?.symbol === 'receptacle' && o.flags?.gfci ? 'receptacle-gfci' : o?.symbol || null);

/** Symbol counts over one or more drawings: { symbol: n }. */
export function drawingCounts(drawings) {
  const out = {};
  for (const d of [].concat(drawings || [])) for (const o of d?.objects || []) add(out, pricedSymbol(o), 1);
  return out;
}

/** The estimate's symbol counts: quantities of lines whose price-book item has a symbol. */
export function estimateCounts(estimate, items) {
  const bySku = new Map((items || []).map((i) => [i.id, i]));
  const out = {};
  for (const l of estimate?.lines || []) {
    const it = l.itemId ? bySku.get(l.itemId) : null;
    if (it?.symbol) add(out, it.symbol, Number(l.qty) || 0);
  }
  return out;
}

/** Symbols already covered by change orders raised from drawings (pending or approved). */
export function changeOrderCounts(job) {
  const out = {};
  for (const co of job?.changeOrders || []) {
    if (co?.status === 'rejected') continue;
    for (const l of co?.lines || []) if (l?.symbol) add(out, l.symbol, Number(l.qty) || 0);
  }
  return out;
}

/** The estimate a job's drawings are compared with: the job's own, else its newest accepted, else its newest. */
export function jobEstimate(job, estimates) {
  if (!job) return null;
  const list = (estimates || []).filter((e) => e && (e.id === job.estimateId || e.jobId === job.id));
  const own = list.find((e) => e.id === job.estimateId);
  if (own) return own;
  const newest = (xs) => [...xs].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
  return newest(list.filter((e) => e.status === 'accepted')) || newest(list.filter((e) => e.status !== 'declined')) || null;
}

/** Does the estimate charge labour on its own lines? */
export const chargesLabour = (estimate) => (estimate?.lines || []).some((l) => l?.kind === 'labour');

/**
 * Price the difference between what is drawn and what was quoted.
 * @param {object} o
 * @param {Record<string, number>} o.current   drawingCounts() of the job's drawings
 * @param {Record<string, number>} o.baseline  estimate counts plus change-order counts
 * @param {object[]} o.items                   price book
 * @param {number} o.labourRateCents
 * @param {number} [o.markupPct]
 * @param {boolean} [o.labourSeparate]         add a labour line (the estimate charges labour)
 * @returns {{ lines: object[], totals: object, unpriced: string[] }}
 */
export function costDelta({ current, baseline, items, labourRateCents = 0, markupPct = 0, labourSeparate = false }) {
  const bySymbol = new Map();
  for (const i of items || []) if (i?.symbol && !bySymbol.has(i.symbol)) bySymbol.set(i.symbol, i);
  const symbols = new Set([...Object.keys(current || {}), ...Object.keys(baseline || {})]);
  const lines = [];
  const unpriced = [];
  for (const symbol of symbols) {
    const diff = (current?.[symbol] || 0) - (baseline?.[symbol] || 0);
    if (!diff) continue;
    const it = bySymbol.get(symbol) || null;
    if (!it) unpriced.push(symbol);
    const unitCents = Math.round(Number(it?.priceCents) || 0);
    const hrs = Number(it?.labourHours) || 0;
    const labourHours = Math.round(diff * hrs * 100) / 100;
    lines.push({
      symbol, diff, label: countWords(symbol, Math.abs(diff)), itemId: it?.id || null, sku: it?.sku || null, description: it?.name || null,
      unitCents, materialCents: diff * unitCents, labourHours, labourCents: Math.round(labourHours * (Number(labourRateCents) || 0)),
    });
  }
  lines.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || b.diff - a.diff || a.symbol.localeCompare(b.symbol));
  const materialCents = lines.reduce((s, l) => s + l.materialCents, 0);
  const markupCents = Math.round(materialCents * (Number(markupPct) || 0) / 100);
  const labourHours = Math.round(lines.reduce((s, l) => s + l.labourHours, 0) * 100) / 100;
  const labourCents = Math.round(labourHours * (Number(labourRateCents) || 0));
  return {
    lines, unpriced,
    totals: {
      materialCents, markupCents, markupPct: Number(markupPct) || 0, labourHours, labourCents, labourRateCents: Number(labourRateCents) || 0, labourSeparate: Boolean(labourSeparate),
      totalCents: materialCents + markupCents + (labourSeparate ? labourCents : 0),
    },
  };
}

/** "+4 duplex receptacles (+$48.00 material, +1.8 labour h), −1 junction box" */
export function describeDelta(lines, money = (c) => `$${(c / 100).toFixed(2)}`, { prices = true } = {}) {
  return lines.map((l) => {
    const sign = l.diff > 0 ? '+' : '−';
    const head = `${sign}${l.label}`;
    if (!prices) return head;
    const bits = [];
    if (l.materialCents) bits.push(`${l.materialCents > 0 ? '+' : '−'}${money(Math.abs(l.materialCents))} material`);
    if (l.labourHours) bits.push(`${l.labourHours > 0 ? '+' : '−'}${Math.abs(l.labourHours)} labour h`);
    return bits.length ? `${head} (${bits.join(', ')})` : head;
  }).join(', ');
}

/**
 * Who drew the added symbols, and who deleted the removed ones. Additions come from the
 * objects themselves (the newest `n` of a symbol), deletions from the drawings' history.
 * @returns {Record<string, { who: { id, name }|null, n: number, from: string|null, to: string|null }[]>}
 */
export function whoChanged(drawings, lines) {
  const out = {};
  const objs = [].concat(drawings || []).flatMap((d) => d?.objects || []);
  const hist = [].concat(drawings || []).flatMap((d) => d?.history || []).sort((a, b) => String(b.until || b.at).localeCompare(String(a.until || a.at)));
  for (const l of lines || []) {
    const groups = new Map();
    const put = (who, n, at) => {
      const k = who ? `${who.id ?? ''}|${who.name}` : '';
      if (!groups.has(k)) groups.set(k, { who: who ? person(who) : null, n: 0, from: at, to: at });
      const g = groups.get(k);
      g.n += n;
      if (at && (!g.from || at < g.from)) g.from = at;
      if (at && (!g.to || at > g.to)) g.to = at;
    };
    if (l.diff > 0) {
      const mine = objs.filter((o) => pricedSymbol(o) === l.symbol).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      for (const o of mine.slice(0, l.diff)) put(o.by || null, 1, o.at || null);
    } else {
      let left = -l.diff;
      for (const e of hist) {
        if (left <= 0) break;
        const n = Math.min(left, e.del?.[l.symbol] || 0);
        if (n) { put(e.by || null, n, e.until || e.at); left -= n; }
      }
      if (left > 0) put(null, left, null);
    }
    out[l.symbol] = [...groups.values()];
  }
  return out;
}

/** "added by Jackson (4, Oct 19 2:14 pm)" style note for a change order. */
export function attributionNote(lines, who, when = (iso) => iso) {
  const parts = [];
  for (const l of lines || []) {
    for (const g of who?.[l.symbol] || []) {
      const name = g.who ? g.who.name : 'someone before tracking';
      const verb = l.diff > 0 ? 'added' : 'removed';
      const at = g.to ? ` ${when(g.to)}` : '';
      parts.push(`${countWords(l.symbol, g.n)} ${verb} by ${name}${at}`);
    }
  }
  return parts.join('; ');
}

/**
 * A change order for the job's existing changeOrders list, from a costDelta() result.
 * Lines carry their symbol so the next comparison counts them as covered.
 */
export function changeOrderFrom(delta, { id, date, createdBy, createdAt, drawingIds = [], estimate = null, who = {}, when } = {}) {
  const lines = delta.lines.map((l) => ({
    symbol: l.symbol, itemId: l.itemId, description: l.description || l.label.replace(/^\d+\s+/, ''), qty: l.diff,
    unitCents: l.unitCents, labourHours: l.diff ? Math.round((l.labourHours / l.diff) * 1000) / 1000 : 0, kind: 'material',
  }));
  const t = delta.totals;
  // the rate goes in markupPct, which crew never get (server access.js), not in the words they do
  if (t.markupCents) lines.push({ symbol: null, itemId: null, description: 'Markup on material', markupPct: t.markupPct, qty: 1, unitCents: t.markupCents, labourHours: 0, kind: 'other' });
  if (t.labourSeparate && t.labourHours) lines.push({ symbol: null, itemId: null, description: 'Labour for the drawing changes', qty: t.labourHours, unitCents: t.labourRateCents, labourHours: 0, kind: 'labour' });
  const words = delta.lines.map((l) => `${l.diff > 0 ? '+' : '−'}${l.label}`);
  const title = `Drawing changes: ${words.slice(0, 4).join(', ')}${words.length > 4 ? ` and ${words.length - 4} more` : ''}`.slice(0, 300);
  return {
    id, title, amountCents: t.totalCents, status: 'pending', date, source: 'drawing', drawingIds,
    estimateId: estimate?.id || null, createdBy: createdBy ? person(createdBy) : null, createdAt: createdAt || null,
    note: attributionNote(delta.lines, who, when).slice(0, 2000), lines,
  };
}

/** The whole comparison for one job, from records the caller already has. */
export function jobCostImpact({ job, drawings, estimates, items, settings = {} }) {
  const estimate = jobEstimate(job, estimates);
  if (!job || !estimate) return { job: job || null, estimate, drawings: drawings || [], ready: false, reason: !job ? 'no-job' : 'no-estimate' };
  const est = estimateCounts(estimate, items);
  const covered = changeOrderCounts(job);
  const baseline = { ...est };
  for (const [k, n] of Object.entries(covered)) add(baseline, k, n);
  const current = drawingCounts(drawings);
  const delta = costDelta({
    current, baseline, items,
    labourRateCents: Number(estimate.labourRateCents) || Number(settings.labourRateCents) || 0,
    markupPct: estimate.markupPct ?? settings.markupPct ?? 0,
    labourSeparate: chargesLabour(estimate),
  });
  return { job, estimate, drawings, ready: true, current, estimateCounts: est, covered, baseline, ...delta, who: whoChanged(drawings, delta.lines) };
}

/**
 * The cost impact as a reader without money sees it: what changed and who, no prices,
 * costs, rates or hours. (The server sends this to crew; the PWA never asks for it.)
 */
export function redactCostImpact(r) {
  return {
    ready: r.ready, reason: r.reason ?? null,
    job: r.job ? { id: r.job.id, number: r.job.number ?? null, title: r.job.title ?? null } : null,
    estimate: r.estimate ? { id: r.estimate.id, number: r.estimate.number ?? null } : null,
    lines: (r.lines || []).map((l) => ({ symbol: l.symbol, diff: l.diff, label: l.label })),
    who: r.who || {},
    prices: false,
  };
}

/** The cost impact for a money reader, as the API returns it (records trimmed to references). */
export function publicCostImpact(r) {
  return {
    ready: r.ready, reason: r.reason ?? null,
    job: r.job ? { id: r.job.id, number: r.job.number ?? null, title: r.job.title ?? null } : null,
    estimate: r.estimate ? { id: r.estimate.id, number: r.estimate.number ?? null, markupPct: r.estimate.markupPct ?? 0, labourRateCents: r.estimate.labourRateCents ?? null } : null,
    lines: r.lines || [], totals: r.totals || null, unpriced: r.unpriced || [], who: r.who || {},
    prices: true,
  };
}

/** First names of the people behind a delta ("Jackson and Manny"). */
export const peopleOf = (who) => [...new Set(Object.values(who || {}).flat().map((g) => (g.who ? firstName(g.who.name) : null)).filter(Boolean))];

/** Latest time any of the job's drawings changed (for "as of"). */
export const lastChange = (drawings) => [].concat(drawings || []).flatMap((d) => (d?.objects || []).map(itemTime)).sort().pop() || null;

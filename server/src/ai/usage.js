// Token usage per company and call, estimated cost, and the monthly cap.
//
// Prices are Anthropic first-party list prices in US dollars per million tokens
// (claude-api skill model table, cached 2026-10-06). 5-minute cache writes are 1.25x
// input; cache reads as listed. An unknown model is costed as Claude Opus 5.5 so the cap
// never under-counts. Estimates only: the company's Anthropic invoice is the truth.
import { ApiError } from '../errors.js';

/** USD per MTok: [input, output, cache write (5 min), cache read] */
export const PRICES = {
  'claude-opus-5-5': [4, 20, 5, 0.2],
  'claude-opus-5': [5, 25, 6.25, 0.5],
  'claude-opus-4-8': [5, 25, 6.25, 0.5],
  'claude-sonnet-5-5': [2, 10, 2.5, 0.2],
  'claude-sonnet-5': [2, 10, 2.5, 0.2],
  'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.01],
  'claude-fable-5-1': [10, 50, 12.5, 0.25],
};

function priceFor(model) {
  if (PRICES[model]) return PRICES[model];
  const base = Object.keys(PRICES).find((k) => String(model || '').startsWith(k));
  return PRICES[base] || PRICES['claude-opus-5-5'];
}

/** Estimated cost of one call in micro-dollars (USD × 1e6), from the API usage block. */
export function costMicroUsd(model, usage = {}) {
  const [inp, out, cw, cr] = priceFor(model);
  const n = (v) => Math.max(0, Number(v) || 0);
  return Math.round(n(usage.input_tokens) * inp + n(usage.output_tokens) * out
    + n(usage.cache_creation_input_tokens) * cw + n(usage.cache_read_input_tokens) * cr);
}

export const microToCents = (m) => Math.ceil((Number(m) || 0) / 10_000);

/**
 * Log one Messages API call. `tx` is a TenantTx.
 * @param {{ feature: 'assistant'|'cec'|'background'|'mcp', model: string, actor?: string, conversationId?: string|null, usage?: object, stopReason?: string|null }} u
 */
export async function recordUsage(tx, u) {
  const usage = u.usage || {};
  const cost = costMicroUsd(u.model, usage);
  await tx.query(
    `INSERT INTO ai_usage (tenant_id, feature, model, actor, conversation_id, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost_micro_usd, stop_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [tx.tenantId, u.feature, String(u.model || 'unknown').slice(0, 80), u.actor || null, u.conversationId || null,
      usage.input_tokens || 0, usage.output_tokens || 0, usage.cache_creation_input_tokens || 0, usage.cache_read_input_tokens || 0,
      cost, u.stopReason ? String(u.stopReason).slice(0, 40) : null]);
  return cost;
}

/** First day of the current month (UTC), the cap period. */
export function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Company AI settings with defaults filled in. */
export async function aiSettings(tx, cfg) {
  const { rows } = await tx.query('SELECT * FROM ai_settings WHERE tenant_id = $1', [tx.tenantId]);
  const r = rows[0] || {};
  return {
    monthlyCapCents: r.monthly_cap_cents ?? cfg.defaultMonthlyCapCents,
    capIsDefault: r.monthly_cap_cents == null,
    backgroundEnabled: r.background_enabled ?? true,
    backgroundAiDrafts: r.background_ai_drafts ?? false,
    updatedAt: r.updated_at ?? null,
  };
}

/** This month's totals for the company. */
export async function monthUsage(tx, now = new Date()) {
  const { rows } = await tx.query(
    `SELECT count(*)::int AS calls, COALESCE(sum(input_tokens), 0)::bigint AS input, COALESCE(sum(output_tokens), 0)::bigint AS output,
            COALESCE(sum(cache_read_tokens), 0)::bigint AS cache_read, COALESCE(sum(cache_write_tokens), 0)::bigint AS cache_write,
            COALESCE(sum(cost_micro_usd), 0)::bigint AS cost
       FROM ai_usage WHERE tenant_id = $1 AND at >= $2`, [tx.tenantId, monthStart(now)]);
  const r = rows[0];
  return {
    since: monthStart(now).toISOString(), calls: r.calls, inputTokens: r.input, outputTokens: r.output,
    cacheReadTokens: r.cache_read, cacheWriteTokens: r.cache_write, costMicroUsd: r.cost, costCents: microToCents(r.cost),
  };
}

/** By feature, for the usage screen. */
export async function monthUsageByFeature(tx, now = new Date()) {
  const { rows } = await tx.query(
    `SELECT feature, count(*)::int AS calls, COALESCE(sum(input_tokens + cache_read_tokens + cache_write_tokens), 0)::bigint AS input,
            COALESCE(sum(output_tokens), 0)::bigint AS output, COALESCE(sum(cost_micro_usd), 0)::bigint AS cost
       FROM ai_usage WHERE tenant_id = $1 AND at >= $2 GROUP BY feature ORDER BY feature`, [tx.tenantId, monthStart(now)]);
  return rows.map((r) => ({ feature: r.feature, calls: r.calls, inputTokens: r.input, outputTokens: r.output, costCents: microToCents(r.cost) }));
}

export function capReached() {
  return new ApiError(429, 'ai_cap_reached',
    'Your company has reached its monthly AI spending cap. An owner or admin can raise it on the Assistant screen.', { cap: true });
}

/** Throws 429 ai_cap_reached when this month's estimated spend is at or over the cap. */
export async function assertUnderCap(tx, cfg, now = new Date()) {
  const s = await aiSettings(tx, cfg);
  const u = await monthUsage(tx, now);
  if (u.costMicroUsd >= s.monthlyCapCents * 10_000) throw capReached();
  return { settings: s, usage: u };
}

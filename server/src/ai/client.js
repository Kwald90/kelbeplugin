// The Anthropic client, built per call from the company's own key, plus the request
// options every call shares and the mapping from SDK errors to friendly API errors.
// Tests swap the factory for a scripted fake (setAnthropicClientFactory); nothing in
// the test suite talks to the real API.
import Anthropic from '@anthropic-ai/sdk';
import { ApiError } from '../errors.js';
import { getSecret } from '../services/secrets.js';

export const ANTHROPIC_SECRET = 'anthropic.api_key';

/** Beta headers (claude-api skill): refusal fallback, progress-note display, thinking-block binding control. */
export const BETA_FALLBACK = 'server-side-fallback-2026-07-01';
export const BETA_THINKING_UPDATES = 'thinking-display-updates-2026-08-18';
export const BETA_THINKING_BINDING = 'thinking-binding-controls-2026-08-01';

/** @param {string} apiKey @param {import('./config.js').AiConfig} cfg */
function defaultFactory(apiKey, cfg) {
  return new Anthropic({ apiKey, maxRetries: cfg?.maxRetries ?? 2, timeout: cfg?.timeoutMs ?? 120_000 });
}

let factory = defaultFactory;

/** Test seam: replace how clients are built (pass null to restore the real SDK). */
export function setAnthropicClientFactory(fn) {
  factory = fn || defaultFactory;
}

/** @returns {{ beta: { messages: { stream: Function } } }} */
export function anthropicClient(apiKey, cfg) {
  return factory(apiKey, cfg);
}

export function notConnected() {
  return new ApiError(409, 'ai_not_connected',
    'Connect Anthropic in Integrations to use the assistant. Your company uses its own Anthropic API key.',
    { integration: 'anthropic', guide: 'anthropic' });
}

/** The company's key, or a friendly 409 when it has not been connected. */
export async function companyKey(tx, sealer) {
  const key = await getSecret(tx, sealer, ANTHROPIC_SECRET);
  if (!key) throw notConnected();
  return key;
}

/**
 * The shared request body. `system` is [frozen prompt (cached), conversation context];
 * tools render before system, so the breakpoint on the frozen prompt caches tools + prompt.
 * Top-level cache_control caches the conversation up to the last message for the next turn.
 * @param {import('./config.js').AiConfig} cfg
 */
export function requestParams(cfg, { model, effort, maxTokens, system, tools, messages }) {
  const betas = [];
  const thinking = { type: 'adaptive' };
  if (cfg.thinkingDisplay !== 'omitted') {
    thinking.display = cfg.thinkingDisplay;
    if (cfg.thinkingDisplay === 'updates') betas.push(BETA_THINKING_UPDATES);
  }
  // A deploy that edits the prompt or a tool description changes the prefix of older
  // conversations; drop their old thinking blocks instead of failing the turn.
  thinking.block_binding = { prefix_mismatch_behavior: 'drop_block' };
  betas.push(BETA_THINKING_BINDING);
  const body = {
    model: model || cfg.model,
    max_tokens: maxTokens || cfg.maxTokens,
    thinking,
    output_config: { effort: effort || cfg.effort },
    cache_control: { type: 'ephemeral' },
    system,
    messages,
  };
  if (tools?.length) body.tools = tools;
  if (cfg.fallbacks) { body.fallbacks = 'default'; betas.push(BETA_FALLBACK); }
  body.betas = betas;
  return body;
}

/**
 * With eager input streaming the SDK raises a plain AnthropicError (not an APIError) when a
 * tool input is not parseable JSON. Its message holds the raw input: never log it.
 */
export function isToolJsonError(e) {
  return e instanceof Anthropic.AnthropicError && !(e instanceof Anthropic.APIError);
}

/**
 * SDK errors -> ApiError with a message a person can act on. Never includes the key,
 * the prompt or the upstream body. Most specific first (claude-api skill, error codes).
 */
export function upstreamError(e) {
  if (e instanceof ApiError) return e;
  if (e instanceof Anthropic.APIUserAbortError) return new ApiError(499, 'ai_cancelled', 'The request was cancelled.');
  if (e instanceof Anthropic.AuthenticationError) {
    return new ApiError(409, 'ai_key_rejected', 'Anthropic rejected your company\'s API key. Check it in Integrations.', { integration: 'anthropic', guide: 'anthropic' });
  }
  if (e instanceof Anthropic.PermissionDeniedError) {
    return new ApiError(409, 'ai_key_rejected', 'Your Anthropic key does not have access to this model. Check the key\'s workspace in the Anthropic Console.', { integration: 'anthropic', guide: 'anthropic' });
  }
  if (e instanceof Anthropic.RateLimitError) return new ApiError(429, 'ai_rate_limited', 'Anthropic is rate limiting your company\'s key. Try again in a minute.');
  if (e instanceof Anthropic.BadRequestError) {
    // Billing problems arrive as 400 invalid_request_error with a credit message.
    const credit = /credit|billing/i.test(String(e?.error?.error?.message || ''));
    return credit
      ? new ApiError(402, 'ai_billing', 'Your Anthropic account is out of credit. Add credit in the Anthropic Console.')
      : new ApiError(502, 'ai_bad_request', 'The AI service refused the request. Try again or start a new conversation.');
  }
  if (e instanceof Anthropic.APIConnectionError) return new ApiError(503, 'ai_unavailable', 'Could not reach Anthropic. Try again shortly.');
  if (e instanceof Anthropic.APIError) {
    return e.status === 529 || e.status >= 500
      ? new ApiError(503, 'ai_unavailable', 'Anthropic is busy right now. Try again shortly.')
      : new ApiError(502, 'ai_error', 'The AI service returned an error. Try again.');
  }
  if (isToolJsonError(e)) return new ApiError(502, 'ai_bad_output', 'The AI sent a malformed tool request. Try again.');
  return null;
}

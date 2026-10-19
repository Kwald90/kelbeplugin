// AI settings from the environment. Every call uses the company's own Anthropic key
// (tenant secret anthropic.api_key); these only choose the model, effort and limits.
//
// Model ids and request options follow the claude-api skill: Claude Opus 5.5
// (`claude-opus-5-5`) with adaptive thinking (always on for this model; effort is the
// control), streaming, server-side refusal fallbacks (`fallbacks: "default"`), and
// prompt caching on the tools + system prefix.

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * @param {NodeJS.ProcessEnv} env
 */
export function readAiConfig(env = process.env) {
  return {
    /** Chat model for the assistant and the CEC helper. */
    model: env.AI_MODEL || 'claude-opus-5-5',
    /** Model for background reminder wording (short, low effort). */
    backgroundModel: env.AI_BACKGROUND_MODEL || env.AI_MODEL || 'claude-opus-5-5',
    /** Claude Opus 5.5 defaults to medium; set it explicitly. */
    effort: pick(env.AI_EFFORT, EFFORTS, 'medium'),
    backgroundEffort: pick(env.AI_BACKGROUND_EFFORT, EFFORTS, 'low'),
    /** Thinking counts toward max_tokens, so leave room for it as well as the reply. */
    maxTokens: int(env.AI_MAX_TOKENS, 32000),
    backgroundMaxTokens: int(env.AI_BACKGROUND_MAX_TOKENS, 4000),
    /** Model calls per user message (each tool round trip is one call). */
    maxSteps: int(env.AI_MAX_STEPS, 8),
    /** Messages kept in one conversation before we ask for a new one. */
    maxMessages: int(env.AI_MAX_MESSAGES, 80),
    /** Server-side refusal fallback (beta server-side-fallback-2026-07-01). AI_FALLBACKS=off drops it. */
    fallbacks: env.AI_FALLBACKS !== 'off',
    /** 'updates' shows short progress notes between tool calls (beta), 'omitted' shows none. */
    thinkingDisplay: pick(env.AI_THINKING_DISPLAY, ['updates', 'omitted', 'summarized'], 'updates'),
    /** Monthly cap in US cents of estimated spend when a company has not set its own. */
    defaultMonthlyCapCents: int(env.AI_DEFAULT_MONTHLY_CAP_CENTS, 5000),
    /** MCP requests per minute per API key (on top of the global API-key limit). */
    mcpPerMinute: int(env.AI_MCP_PER_MINUTE, 120),
    /** Background agents: new suggestions per company per run, and Claude-worded drafts per run. */
    backgroundMaxFindings: int(env.AI_BACKGROUND_MAX_FINDINGS, 25),
    backgroundMaxAiDrafts: int(env.AI_BACKGROUND_MAX_AI_DRAFTS, 5),
    /** Conversations untouched this many days are deleted by the worker. */
    conversationRetentionDays: int(env.AI_CONVERSATION_RETENTION_DAYS, 180),
    /** Upstream request timeout (ms) and SDK retries for 408/409/429/5xx. */
    timeoutMs: int(env.AI_TIMEOUT_MS, 120_000),
    maxRetries: int(env.AI_MAX_RETRIES, 2),
  };
}

/** @typedef {ReturnType<typeof readAiConfig>} AiConfig */

# Fishtape AI

Workstream J. Four pieces, all running on each company's **own Anthropic API key** (tenant
secret `anthropic.api_key`, set in Integrations):

| piece | where | plan feature |
| --- | --- | --- |
| Assistant: estimates, invoices, look-ups, photos | `#/assistant`, "Ask Fishtape" on estimates, invoices and jobs | `ai.assistant` (Business) |
| CEC helper: code questions answered with the calculators | `#/assistant/cec` | `ai.cec` (Business) |
| Background agents: daily checks that draft follow-ups | worker, `#/assistant/suggestions` | `ai.background` (Business) |
| MCP server for outside agents | `POST /api/mcp`, guide in [mcp.md](mcp.md) | `mcp` (Business) |

The rule throughout: **the AI drafts, people approve.** Nothing is sent, invoiced, paid or
deleted by AI without a person clicking in the app.

## Code

```
server/src/ai/
  config.js        model, effort, limits (env, see below)
  client.js        Anthropic client per call from the company key, shared request options, error mapping
  chat.js          conversations and the streaming tool-use loop
  prompts.js       frozen system prompts + the per-conversation context block
  tools/index.js   assistant tools (price book, records, drafts); tools/cec.js the CEC calculators
  data.js          tenant-scoped reads for tools (same access rules as the REST API)
  drafts.js        propose / accept / discard estimate and invoice drafts
  usage.js         token usage per call, cost estimate, monthly cap
  background.js    the daily checks; jobs.js registers them with the worker
  mcp.js           MCP protocol and tools
  validate.js      JSON Schema validation of every tool input
server/src/routes/v1/ai.js    /api/v1/ai/* (signed-in people)
server/src/routes/mcp.js      /api/mcp (API keys)
server/migrations/0050_ai.sql tables (all RLS ENABLE + FORCE)
electrical-app/js/modules/assistant.js, js/lib/assistant-api.js, css/assistant.css
```

## How a chat turn works

1. `POST /api/v1/ai/conversations` starts a conversation (`mode: assistant | cec`, the user's
   units, and the estimate/invoice/job it was opened from). The server writes a context block
   (province, code book, tax set-up, labour rate, units, role, date, screen) **once**.
2. `POST /api/v1/ai/conversations/:id/messages` with `{ text, images? }`. Before streaming, the
   server checks, in order: the conversation belongs to this person, the plan feature, that a
   key is connected (`409 ai_not_connected`, "Connect Anthropic in Integrations"), the monthly cap
   (`429 ai_cap_reached`), and a one-turn-at-a-time lock (`409 ai_busy`). These are normal JSON
   errors.
3. Then it streams server-sent events (`start`, `text_start`, `text`, `progress`, `tool`,
   `draft`, `notice`, `error`, `done`) while it runs a manual tool-use loop
   (`client.beta.messages.stream` → `finalMessage()`), at most `AI_MAX_STEPS` model calls:
   - tool inputs are validated against the tool's schema before running (eager input streaming
     means the API no longer does it); a bad input goes back as an `is_error` tool result;
   - parallel tool calls run together and every result goes back in one user message;
   - `refusal` ends the turn without storing the declined content; `max_tokens` with a tool call
     answers the call with an error instead of running a truncated input;
   - each call is logged in `ai_usage` and the cap is checked again before the next call.
4. History is stored server-side in `ai_messages`, **append-only and byte-exact** (`content` is
   the JSON text of the API blocks, not jsonb, so key order never changes). The browser only
   sends its new message, so it can't forge earlier turns or tool results, and thinking blocks
   are replayed unchanged.

Conversations are private to the person who started them and deleted by the worker after
`AI_CONVERSATION_RETENTION_DAYS` (180) without activity.

## Model and request options

Chosen with the `claude-api` skill (2026-10):

- **Model** `claude-opus-5-5` (env `AI_MODEL`). Background wording uses `AI_BACKGROUND_MODEL`
  (default the same model) at `low` effort.
- **Thinking** adaptive (always on for this model); **effort** set explicitly to `medium`
  (`AI_EFFORT`; the model's default is also medium). No `temperature`, no forced `tool_choice`
  (Opus 5.5 rejects `any`/`tool`), no prefill.
- **Streaming** for every call; `max_tokens` 32 000 (`AI_MAX_TOKENS`) since thinking counts
  toward it.
- **Prompt caching**: tools (sorted by name, fixed per mode) render first, then the frozen system
  prompt with `cache_control`, then the per-conversation context block; top-level
  `cache_control` caches the conversation for the next turn. Nothing volatile (dates, names) is
  in the frozen prompt.
- **Refusal fallback** `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), so a
  safety-classifier false positive is retried on Anthropic's recommended fallback model instead
  of failing. After a mid-output fallback the declined attempt's thinking and tool calls are
  dropped from history as the docs require. `AI_FALLBACKS=off` removes it.
- **Progress notes** `thinking.display: "updates"` (beta `thinking-display-updates-2026-08-18`):
  short notes between tool calls show in the chat; reasoning stays hidden.
  `AI_THINKING_DISPLAY=omitted` turns it off.
- **Thinking-block binding** `block_binding.prefix_mismatch_behavior: "drop_block"` (beta
  `thinking-binding-controls-2026-08-01`): if a deploy changes a prompt or tool description,
  old conversations drop their stale thinking blocks instead of failing with a 400.
- `eager_input_streaming: true` on every tool, with our own validation (above).
- SDK: `@anthropic-ai/sdk` 0.132.1. Upstream errors are mapped to friendly codes
  (`ai_key_rejected`, `ai_rate_limited`, `ai_billing`, `ai_unavailable`, ...) and never include
  the key, prompt or upstream body.

## Tools

Assistant mode (CEC mode has only the `cec_*` tools):

| tool | does | writes |
| --- | --- | --- |
| `search_price_book` | items by name, SKU, category: sell price, labour hours, stock | no |
| `find_records` | clients, leads, jobs, estimates, invoices, payments, permits, certifications, employees, time entries, stock moves... by words and exact filters | no |
| `get_record` | one record (drawing underlays and photos are cut out) | no |
| `draft_estimate_lines` | proposes a new draft estimate or lines added to an existing one | an `ai_drafts` row |
| `draft_invoice_from_job` | proposes an invoice from the job's accepted estimate, or time and materials | an `ai_drafts` row |
| `cec_ampacity`, `cec_conductor_size`, `cec_voltage_drop`, `cec_conduit_fill`, `cec_box_fill`, `cec_dwelling_load`, `cec_motor`, `cec_province_info` | the PWA's own CEC 2024 functions (`electrical-app/js/lib/cec/`) | no |

Tools run inside `withTenant` with the caller's principal: the same `canRead`/`canWrite`,
own-row filters and field redaction as the REST API. Another company's id is "not found".

**Drafts.** Prices come from the price book (a model-supplied price for a price-book item is
replaced and noted), labour lines from the company labour rate, anything else is flagged
"Check price" / "No price". Tax is `newDocTax()` / `taxComponents()` from `js/lib/tax.js` for the
company's province and treatment; totals are `docTotals()` from `js/lib/money.js`. The draft
shows lines, the source of each price, the tax lines and the total before → after. **Accept**
(`POST /api/v1/ai/drafts/:id/accept`) writes through the records service as the person: a new
draft estimate (`E-<next>`) or invoice (`INV-<next>`), or the lines appended to the estimate with
an `If-Match` on the version captured when drafting (`409 version_conflict` if it changed).
Accepted documents are always `status: draft`; sending stays a person's job.

## Background agents

The worker queues `ai_background_dispatch` hourly; it queues one `ai_background_scan` per
active company with `ai.background`. A scan runs at most **once per company per day**
(`ai_agent_runs`), and a manager can run it by hand at most every 10 minutes.

| check | suggestion | dedupe key |
| --- | --- | --- |
| invoices sent/partial, past due, balance owing | reminder email to the client (SMS if no email, task if neither) | invoice + every 14 days overdue |
| permits expiring within 30 days (or expired, not closed) | task | permit + expiry date |
| certifications and employee licences expiring within 30 days | task | record + expiry date |
| items below their reorder point | one task listing them | week |
| finished time entries not approved after 7 days | task per employee | employee + week |

Each new finding gets an `ai_suggestions` row (unique per company and dedupe key) and an
`outbox` record with `status: "draft"`, written by the agent actor (`agent:background`).
At most `AI_BACKGROUND_MAX_FINDINGS` (25) new suggestions per run. In the app a **manager**
approves (the outbox record becomes `queued`, optionally with edited subject/body, audited as
that person) or dismisses (the draft is soft-deleted). The outbox sender only sends `queued`.

Claude is used only to word overdue-invoice reminders, and only when the company turned on
"Let Claude word reminders", has a key and is under its cap: at most
`AI_BACKGROUND_MAX_AI_DRAFTS` (5) per run, `low` effort, facts passed as data. Otherwise a plain
template is used.

## Usage and caps

Every Messages API call writes an `ai_usage` row: company, feature (`assistant`, `cec`,
`background`), model, actor, conversation, input/output/cache tokens, stop reason and an
estimated cost in micro-dollars (US list prices in `usage.js`; Opus 5.5 is $4 / $20 per MTok,
cache writes $5, cache reads $0.20). The app role can insert and read but not change or delete
these rows.

Each company has a monthly cap in **US cents of estimated spend** (calendar month, UTC):
`ai_settings.monthly_cap_cents`, default `AI_DEFAULT_MONTHLY_CAP_CENTS` (US$50). It is checked
before a message starts and before every model call; at the cap the assistant answers
`429 ai_cap_reached` and background wording falls back to templates. Owners and admins change it
under Assistant → Connect agents (`PUT /api/v1/ai/settings`); managers see
`GET /api/v1/ai/usage`; HQ has read access to `ai_usage`, `ai_settings` and `ai_agent_runs`.

**Cost notes.** A typical assistant turn is 2-4 model calls (look up, draft, summarise). The
frozen prompt and tools are cached after the first call, so later calls in a conversation mostly
pay cache-read rates for the prefix; output (including thinking) dominates. Not measured yet; a
rough estimate for a 3-call turn with ~6k tokens of tools and prompt and ~1.5k output tokens per
call: cache write US$0.03 + output US$0.09 ≈ **US$0.10-0.15 per drafted estimate**, much less for
a one-call look-up. Check `ai_usage` after real use. Ways to spend less: `AI_EFFORT=low`, or a cheaper
model via `AI_MODEL` (for example `claude-sonnet-5-5`; prices are in `usage.js`). The estimate is
ours; the company's Anthropic invoice is the truth.

## Safety rules (and where they are enforced)

- **Company keys only.** `getSecret(tx, sealer, 'anthropic.api_key')` inside the company's
  transaction; no platform key exists. No key → `409 ai_not_connected`.
- **No cross-company data.** Prompts are built only from the caller's company (RLS + explicit
  `tenant_id` filters); tools run with the caller's permissions. Tests try other companies' ids.
- **Drafts, not actions.** Tools can't send, invoice, pay, delete or change documents; accepting
  a draft or approving a suggestion is a person's click, audited as them. MCP agents keep
  estimates, invoices and outbox messages in `draft`, can't write payments, settings or the audit
  log, and have no delete tool.
- **Untrusted content.** Record contents and tool results are data; the system prompt says so,
  and background facts are passed as JSON labelled "data, not instructions".
- **No PII in server logs.** Message text, record contents and keys are never logged; tool
  failures log only the tool name and an error code (tested in `test/ai.test.js`).
- **CEC answers are advisory.** Answers cite rule/table numbers from the app's own data
  (`js/lib/cec/`), never CSA text, and every calculator result carries the note to verify with the
  authority having jurisdiction. Values marked VERIFY in the CEC code stay marked.
- **Audit.** Draft created (`agent`), accepted/discarded (`user`), suggestion approved/dismissed
  (`user`), outbox drafts (`agent`), every MCP tool call (`api_key`), settings changes.

## Configuration

| env | default | |
| --- | --- | --- |
| `AI_MODEL` | `claude-opus-5-5` | chat model |
| `AI_BACKGROUND_MODEL` | `AI_MODEL` | reminder wording |
| `AI_EFFORT` / `AI_BACKGROUND_EFFORT` | `medium` / `low` | |
| `AI_MAX_TOKENS` / `AI_BACKGROUND_MAX_TOKENS` | 32000 / 4000 | per call |
| `AI_MAX_STEPS` | 8 | model calls per message |
| `AI_MAX_MESSAGES` | 80 | per conversation |
| `AI_FALLBACKS` | on | `off` drops the refusal fallback |
| `AI_THINKING_DISPLAY` | `updates` | `omitted` or `summarized` |
| `AI_DEFAULT_MONTHLY_CAP_CENTS` | 5000 | US cents |
| `AI_MCP_PER_MINUTE` | 120 | MCP requests per key per minute |
| `AI_BACKGROUND_MAX_FINDINGS` / `AI_BACKGROUND_MAX_AI_DRAFTS` | 25 / 5 | per run |
| `AI_CONVERSATION_RETENTION_DAYS` | 180 | |
| `AI_TIMEOUT_MS` / `AI_MAX_RETRIES` | 120000 / 2 | SDK |

## Tests

`cd server && npm run test:embedded`. The Anthropic client is replaced by a scripted fake
(`test/support/anthropic-mock.js`); no test calls the real API.

- `test/ai.test.js`: no key, plan gates, streamed turns with tool calls, request options and
  caching, drafts that change nothing until accepted (new and append, stale version), invoice from
  a job, cross-company ids, private conversations, invalid tool input, refusals, rejected key,
  the CEC helper, usage logging and the cap (also between steps), RLS on every AI table, logs.
- `test/ai-agents.test.js`: every check, outbox drafts, daily throttle and dedupe, who sees and
  acts on suggestions, approve/dismiss, Claude wording with the company key and the cap, dispatch.
- `test/mcp.test.js`: handshake, bad/missing/revoked/session credentials, plan gate, scopes,
  agent write policy, audit, cross-company ids, rate limit, and the official MCP SDK client over HTTP.

// Assistant and CEC-helper conversations: a streaming tool-use loop over the Messages API
// (manual loop, claude-api skill "Streaming Manual Loop"), using the company's own key.
//
// History is stored server-side, append-only and byte-exact (ai_messages.content is the
// JSON text of the API content blocks). The client only ever sends its new message, so it
// cannot forge earlier turns or tool results, and thinking blocks are replayed unchanged.
import { ApiError, badRequest, forbidden, notFound } from '../errors.js';
import { assertFeature } from '../services/entitlements.js';
import { tenantCtx } from '../routes/util.js';
import { anthropicClient, companyKey, isToolJsonError, requestParams, upstreamError } from './client.js';
import { assertUnderCap, recordUsage } from './usage.js';
import { PROMPT_VERSION, conversationContext, systemPromptFor } from './prompts.js';
import { apiTools, canUseRecordTools, toolLabel, toolsFor } from './tools/index.js';
import { companySettings, compact } from './data.js';
import { validateInput } from './validate.js';

export const MODES = { assistant: 'ai.assistant', cec: 'ai.cec' };
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_TOOL_RESULT_CHARS = 24_000;
const BUSY_SECONDS = 300;

/** Agent actor for things the assistant does on a person's behalf (drafts). */
export const assistantActor = (p) => ({ type: 'agent', id: `assistant:${p.userId}`, label: `${p.actor?.label || 'User'} via assistant` });

/**
 * After a mid-output refusal fallback, the blocks before the last `fallback` block came from
 * the declined attempt: keep its text, drop its thinking and tool calls (claude-api skill,
 * "Echoing fallback turns back"). Without a fallback block the content is kept as is.
 */
export function historyContent(content) {
  const blocks = Array.isArray(content) ? content : [];
  let last = -1;
  blocks.forEach((b, i) => { if (b?.type === 'fallback') last = i; });
  if (last < 0) return blocks;
  return blocks.filter((b, i) => i > last || b?.type === 'text');
}

function userContent({ text, images }) {
  const content = [];
  for (const img of images || []) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  }
  if (text) content.push({ type: 'text', text });
  return content;
}

/** What the chat screen shows: text, progress notes, tool steps. Thinking text stays hidden unless it is a progress note. */
export function displayMessages(rows) {
  const out = [];
  for (const r of rows) {
    const content = JSON.parse(r.content);
    if (r.role === 'user') {
      const results = content.filter((b) => b.type === 'tool_result');
      if (results.length && results.length === content.length) {
        for (const res of results) {
          for (let i = out.length - 1; i >= 0; i--) {
            const step = out[i].tools?.find((s) => s.id === res.tool_use_id);
            if (step) { step.status = res.is_error ? 'error' : 'done'; break; }
          }
        }
        continue;
      }
      out.push({ seq: r.seq, role: 'user', text: content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), images: content.filter((b) => b.type === 'image').length, at: r.created_at });
    } else {
      const msg = { seq: r.seq, role: 'assistant', parts: [], tools: [], at: r.created_at };
      for (const b of content) {
        if (b.type === 'text' && b.text) msg.parts.push({ type: 'text', text: b.text });
        else if (b.type === 'thinking' && b.thinking) msg.parts.push({ type: 'progress', text: b.thinking });
        else if (b.type === 'tool_use') { const s = { id: b.id, name: b.name, label: toolLabel(b.name, b.input), status: 'running' }; msg.tools.push(s); msg.parts.push({ type: 'tool', id: b.id }); }
      }
      out.push(msg);
    }
  }
  return out;
}

/**
 * @param {{ db: import('../db.js').Db, sealer: object, records: object, aiCfg: import('./config.js').AiConfig, log?: object }} deps
 */
export function createChat({ db, sealer, records, aiCfg, log }) {
  const inTenant = (p, fn, opts) => db.withTenant(tenantCtx(p), fn, opts);

  async function loadConversation(tx, p, id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    const { rows } = await tx.query('SELECT * FROM ai_conversations WHERE tenant_id = $1 AND id = $2', [tx.tenantId, id]);
    // Conversations are private to the person who started them.
    if (!rows[0] || rows[0].user_id !== p.userId) throw notFound();
    return rows[0];
  }

  const convView = (c) => ({ id: c.id, mode: c.mode, title: c.title, context: c.context, messageCount: c.message_count, createdAt: c.created_at, updatedAt: c.updated_at });

  async function start(p, { mode = 'assistant', units, screen, title }, request) {
    if (!MODES[mode]) throw badRequest('mode must be assistant or cec.');
    if (p.kind !== 'session' || !p.userId) throw forbidden('Sign in to use the assistant.');
    await assertFeature(db, p.tenantId, MODES[mode]);
    if (mode === 'assistant' && !canUseRecordTools(p)) throw forbidden('Your role cannot use the assistant. Try the CEC helper.');
    return inTenant(p, async (tx) => {
      const settings = await companySettings(tx);
      const ctx = {
        units: units === 'imperial' ? 'imperial' : 'metric', province: settings.company.province,
        screen: screen?.collection && screen?.id ? { collection: screen.collection, id: screen.id, label: screen.label ? String(screen.label).slice(0, 60) : null } : null,
      };
      const system = conversationContext({ settings, principal: p, mode, units: ctx.units, screen: ctx.screen, today: new Date().toISOString().slice(0, 10) });
      const { rows } = await tx.query(
        `INSERT INTO ai_conversations (tenant_id, user_id, mode, title, context, system_context, prompt_version) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [tx.tenantId, p.userId, mode, title ? String(title).slice(0, 200) : null, ctx, system, PROMPT_VERSION]);
      void request;
      return convView(rows[0]);
    }, { write: true });
  }

  async function list(p) {
    return inTenant(p, async (tx) => {
      const { rows } = await tx.query(
        'SELECT * FROM ai_conversations WHERE tenant_id = $1 AND user_id = $2 ORDER BY updated_at DESC LIMIT 50', [tx.tenantId, p.userId]);
      return rows.map(convView);
    });
  }

  async function get(p, id) {
    return inTenant(p, async (tx) => {
      const c = await loadConversation(tx, p, id);
      const { rows } = await tx.query('SELECT seq, role, content, created_at FROM ai_messages WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY seq', [tx.tenantId, c.id]);
      const drafts = await tx.query('SELECT id, kind, status, summary, proposal, target_collection, target_id, result_id, created_at FROM ai_drafts WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY created_at', [tx.tenantId, c.id]);
      return { conversation: convView(c), messages: displayMessages(rows), drafts: drafts.rows.map((d) => ({ id: d.id, kind: d.kind, status: d.status, summary: d.summary, proposal: d.proposal, target: { collection: d.target_collection, id: d.target_id }, resultId: d.result_id, createdAt: d.created_at })) };
    });
  }

  async function remove(p, id) {
    return inTenant(p, async (tx) => {
      const c = await loadConversation(tx, p, id);
      await tx.query('DELETE FROM ai_conversations WHERE tenant_id = $1 AND id = $2', [tx.tenantId, c.id]);
      return { id: c.id, deleted: true };
    }, { write: true });
  }

  /**
   * Checks that answer with a normal JSON error before any streaming starts: the
   * conversation, plan, key, cap and one-turn-at-a-time lock.
   */
  async function prepare(p, id, body) {
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const images = Array.isArray(body?.images) ? body.images : [];
    if (!text && !images.length) throw badRequest('Type a message or attach a photo.');
    if (text.length > 20_000) throw badRequest('That message is too long (20,000 characters at most).');
    if (images.length > 3) throw badRequest('Attach at most 3 photos per message.');
    for (const img of images) {
      if (!IMAGE_TYPES.includes(img?.mediaType) || typeof img?.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(img.data)) throw badRequest('Photos must be JPEG, PNG, WebP or GIF, base64 encoded.');
      if (img.data.length > 4_000_000) throw badRequest('Each photo must be under about 3 MB. Smaller photos work as well.');
    }
    const conv = await inTenant(p, (tx) => loadConversation(tx, p, id));
    await assertFeature(db, p.tenantId, MODES[conv.mode]);
    if (conv.message_count >= aiCfg.maxMessages) throw new ApiError(409, 'ai_conversation_full', 'This conversation is long. Start a new one to keep answers fast.');
    const apiKey = await inTenant(p, async (tx) => {
      const key = await companyKey(tx, sealer);
      await assertUnderCap(tx, aiCfg);
      const { rowCount } = await tx.query(
        `UPDATE ai_conversations SET busy_until = now() + make_interval(secs => $3)
          WHERE tenant_id = $1 AND id = $2 AND (busy_until IS NULL OR busy_until < now())`, [tx.tenantId, conv.id, BUSY_SECONDS]);
      if (!rowCount) throw new ApiError(409, 'ai_busy', 'The assistant is still answering in this conversation.');
      return key;
    }, { write: true });
    return { p, conv, apiKey, content: userContent({ text, images }), title: text.slice(0, 80) };
  }

  async function append(p, convId, role, content) {
    return inTenant(p, async (tx) => {
      const { rows } = await tx.query('SELECT message_count FROM ai_conversations WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tx.tenantId, convId]);
      const seq = rows[0].message_count + 1;
      await tx.query('INSERT INTO ai_messages (tenant_id, conversation_id, seq, role, content) VALUES ($1, $2, $3, $4, $5)', [tx.tenantId, convId, seq, role, JSON.stringify(content)]);
      await tx.query('UPDATE ai_conversations SET message_count = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2', [tx.tenantId, convId, seq]);
      return seq;
    }, { write: true });
  }

  async function history(p, convId) {
    return inTenant(p, async (tx) => {
      const { rows } = await tx.query('SELECT role, content FROM ai_messages WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY seq', [tx.tenantId, convId]);
      return rows.map((r) => ({ role: r.role, content: JSON.parse(r.content) }));
    });
  }

  async function release(p, convId) {
    try {
      await inTenant(p, (tx) => tx.query('UPDATE ai_conversations SET busy_until = NULL WHERE tenant_id = $1 AND id = $2', [tx.tenantId, convId]), { write: true });
    } catch { /* the lock expires on its own */ }
  }

  async function runTool(ctx, tool, block, emit) {
    const fail = (message) => {
      emit('tool', { id: block.id, name: block.name, status: 'error', label: toolLabel(block.name, block.input) });
      return { type: 'tool_result', tool_use_id: block.id, is_error: true, content: JSON.stringify({ error: message }) };
    };
    if (!tool) return fail(`There is no tool called ${String(block.name).slice(0, 60)}.`);
    const input = structuredClone(block.input ?? {});
    const bad = validateInput(tool.input_schema, input);
    if (bad) return fail(bad);
    try {
      const out = await tool.run(ctx, input);
      const isError = Boolean(out?.error);
      emit('tool', { id: block.id, name: block.name, status: isError ? 'error' : 'done', label: toolLabel(block.name, input) });
      if (out?.proposal && out?.id && out?.status === 'proposed') emit('draft', out);
      let text = JSON.stringify(compact(out));
      if (text.length > MAX_TOOL_RESULT_CHARS) text = `${text.slice(0, MAX_TOOL_RESULT_CHARS)} [result truncated; narrow the search]`;
      return { type: 'tool_result', tool_use_id: block.id, content: text, ...(isError ? { is_error: true } : {}) };
    } catch (e) {
      if (e instanceof ApiError) return fail(e.message);
      log?.warn?.({ tool: block.name, code: e?.code }, 'ai tool failed');
      return fail('The tool failed. Try again or ask differently.');
    }
  }

  /**
   * One user message: stream the reply, run tools, loop until the model is done.
   * emit(event, data) writes server-sent events; nothing here throws after streaming starts.
   * @param {Awaited<ReturnType<typeof prepare>>} prep
   */
  async function run(prep, emit, { signal, request } = {}) {
    const { p, conv, apiKey } = prep;
    const feature = conv.mode === 'cec' ? 'cec' : 'assistant';
    const tools = toolsFor(conv.mode);
    const byName = new Map(tools.map((t) => [t.name, t]));
    const system = [
      { type: 'text', text: systemPromptFor(conv.mode), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: conv.system_context },
    ];
    const client = anthropicClient(apiKey, aiCfg);
    const actor = `user:${p.userId}`;
    const ctx = {
      db, principal: p, context: conv.context, conversationId: conv.id, feature,
      tenant: (fn, opts) => inTenant(p, fn, opts),
      who: { actor: assistantActor(p), conversationId: conv.id, request },
    };
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costMicroUsd: 0 };
    let stopReason = null;
    try {
      if (!conv.title && prep.title) {
        await inTenant(p, (tx) => tx.query('UPDATE ai_conversations SET title = $3 WHERE tenant_id = $1 AND id = $2', [tx.tenantId, conv.id, prep.title]), { write: true });
      }
      const seq = await append(p, conv.id, 'user', prep.content);
      emit('start', { conversationId: conv.id, seq });
      let jsonRetries = 0;
      for (let step = 0; step < aiCfg.maxSteps; step++) {
        await inTenant(p, (tx) => assertUnderCap(tx, aiCfg));
        const messages = await history(p, conv.id);
        const params = requestParams(aiCfg, { system, tools: apiTools(tools), messages });
        let msg;
        try {
          const stream = client.beta.messages.stream(params, { signal });
          for await (const ev of stream) {
            if (ev.type === 'content_block_start') {
              const b = ev.content_block;
              if (b?.type === 'text') emit('text_start', {});
              else if (b?.type === 'tool_use') emit('tool', { id: b.id, name: b.name, status: 'running', label: toolLabel(b.name) });
              else if (b?.type === 'fallback') emit('notice', { message: 'Answered by a fallback model after a safety check.' });
            } else if (ev.type === 'content_block_delta') {
              if (ev.delta?.type === 'text_delta') emit('text', { delta: ev.delta.text });
              else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) emit('progress', { delta: ev.delta.thinking });
            }
          }
          msg = await stream.finalMessage();
          jsonRetries = 0;
        } catch (e) {
          const mapped = upstreamError(e);
          // Eager input streaming: a tool input the SDK could not parse at all rejects the
          // stream. Re-issue the turn (nothing was stored), at most twice.
          if (isToolJsonError(e) && jsonRetries++ < 2) { step--; continue; }
          throw mapped || e;
        }
        const usage = msg.usage || {};
        const cost = await inTenant(p, (tx) => recordUsage(tx, { feature, model: msg.model || params.model, actor, conversationId: conv.id, usage, stopReason: msg.stop_reason }), { write: true });
        totals.inputTokens += (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
        totals.outputTokens += usage.output_tokens || 0;
        totals.cacheReadTokens += usage.cache_read_input_tokens || 0;
        totals.costMicroUsd += cost;
        stopReason = msg.stop_reason;

        if (msg.stop_reason === 'refusal') {
          // A declined turn is not stored: the history stays valid and append-only.
          emit('error', { code: 'ai_refused', message: 'The AI declined to answer that. Try rephrasing the question.' });
          break;
        }
        const content = historyContent(msg.content);
        if (!content.length) break;
        await append(p, conv.id, 'assistant', content);
        if (msg.stop_reason === 'pause_turn') continue;
        const uses = content.filter((b) => b.type === 'tool_use');
        if (!uses.length) break;
        let results;
        if (msg.stop_reason === 'max_tokens') {
          // A tool input cut off at max_tokens can still parse; never run it.
          results = uses.map((b) => ({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: JSON.stringify({ error: 'The request was cut off before the tool input was complete.' }) }));
          await append(p, conv.id, 'user', results);
          emit('error', { code: 'ai_truncated', message: 'The answer was too long and was cut off. Ask for less at once.' });
          break;
        }
        // Parallel tool calls: run together, return every result in one user message.
        results = await Promise.all(uses.map((b) => runTool(ctx, byName.get(b.name), b, emit)));
        await append(p, conv.id, 'user', results);
        if (step === aiCfg.maxSteps - 1) {
          stopReason = 'step_limit';
          emit('notice', { message: `Stopped after ${aiCfg.maxSteps} steps. Say "continue" to keep going.` });
        }
      }
      emit('done', { stopReason, usage: { ...totals, costCents: Math.ceil(totals.costMicroUsd / 10_000) } });
    } catch (e) {
      const err = e instanceof ApiError ? e : upstreamError(e);
      if (err) emit('error', { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) });
      else {
        log?.error?.({ code: e?.code, name: e?.name }, 'ai turn failed');
        emit('error', { code: 'internal', message: 'Something went wrong. It has been logged.' });
      }
    } finally {
      await release(p, conv.id);
    }
  }

  return { start, list, get, remove, prepare, run };
}

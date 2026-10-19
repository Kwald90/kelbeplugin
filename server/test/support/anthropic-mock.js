// A scripted stand-in for the Anthropic SDK client, so no test ever calls the real API.
// It implements the two things src/ai uses: client.beta.messages.stream(params, { signal })
// returning an async-iterable of stream events, and stream.finalMessage().
import Anthropic from '@anthropic-ai/sdk';
import { setAnthropicClientFactory } from '../../src/ai/client.js';

let n = 0;

/** A response turn: content blocks plus stop reason and usage. */
export function turn(content, { stop = null, usage = {}, model = 'claude-opus-5-5' } = {}) {
  const stopReason = stop || (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
  return { content, stop_reason: stopReason, model, usage: { input_tokens: 1200, output_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage } };
}
export const text = (t) => ({ type: 'text', text: t });
export const toolUse = (name, input) => ({ type: 'tool_use', id: `toolu_${++n}`, name, input });

function events(t) {
  const out = [{ type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: t.model, content: [], usage: { input_tokens: t.usage.input_tokens, output_tokens: 1 } } }];
  t.content.forEach((b, index) => {
    if (b.type === 'text') {
      out.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      for (const piece of b.text.match(/.{1,12}/gs) || []) out.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
    } else if (b.type === 'tool_use') {
      out.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      out.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    } else if (b.type === 'thinking') {
      out.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      if (b.thinking) out.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } });
    } else {
      out.push({ type: 'content_block_start', index, content_block: b });
    }
    out.push({ type: 'content_block_stop', index });
  });
  out.push({ type: 'message_delta', delta: { stop_reason: t.stop_reason }, usage: { output_tokens: t.usage.output_tokens } });
  out.push({ type: 'message_stop' });
  return out;
}

/**
 * Install a fake client. `script` is a list of turns (from turn()), Errors to throw, or
 * functions (params) => turn. Returns the recorded calls (params as JSON) and keys used.
 */
export function mockAnthropic(script = []) {
  const queue = [...script];
  const calls = [];
  const keys = [];
  setAnthropicClientFactory((apiKey) => {
    keys.push(apiKey);
    return {
      beta: {
        messages: {
          stream(params, opts = {}) {
            calls.push(JSON.parse(JSON.stringify(params)));
            let next = queue.shift();
            if (typeof next === 'function') next = next(params);
            if (!next) next = turn([text('(no more scripted turns)')]);
            const err = next instanceof Error ? next : null;
            const evs = err ? [] : events(next);
            const final = err ? null : { id: `msg_${n}`, type: 'message', role: 'assistant', model: next.model, content: JSON.parse(JSON.stringify(next.content)), stop_reason: next.stop_reason, stop_details: null, usage: next.usage };
            return {
              async *[Symbol.asyncIterator]() {
                if (err) throw err;
                for (const ev of evs) {
                  if (opts.signal?.aborted) throw new Anthropic.APIUserAbortError();
                  yield ev;
                }
              },
              async finalMessage() {
                if (err) throw err;
                return final;
              },
            };
          },
        },
      },
    };
  });
  return { calls, keys, pending: () => queue.length, push: (...t) => queue.push(...t) };
}

export function restoreAnthropic() {
  setAnthropicClientFactory(null);
}

export const authError = () => new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers());

/** Parse a text/event-stream body into [{ event, data }]. */
export function sse(body) {
  return String(body).split('\n\n').filter((b) => b.trim()).map((block) => {
    const ev = /^event: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    return { event: ev, data: data ? JSON.parse(data) : null };
  });
}

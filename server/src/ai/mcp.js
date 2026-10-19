// MCP server (Model Context Protocol, Streamable HTTP transport, stateless): JSON-RPC 2.0
// over POST /api/mcp, answered with application/json. Outside agents (Claude Desktop,
// Claude Code, other MCP clients) authenticate with one company's API key and get tools
// limited to that key's scopes. Every tool call is audited with actor api_key.
//
// Agents can read, search, create and update records, run the CEC calculators and draft
// estimates. They cannot delete, record payments, change settings, send anything or move a
// document out of draft: those need a person in the app.
import { COLLECTIONS, AUDIT_COLLECTION, collectionDef, filterFields } from '../collections.js';
import { canRead, canWrite } from '../auth/access.js';
import { ApiError } from '../errors.js';
import { appendAudit } from '../services/audit.js';
import { CEC_TOOLS } from './tools/cec.js';
import { LINE_SCHEMA, proposeEstimate } from './drafts.js';
import { compact, readRecord, searchRecords, summarize } from './data.js';
import { validateInput } from './validate.js';
import { TREATMENTS } from '../../../electrical-app/js/lib/tax.js';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST = PROTOCOL_VERSIONS[0];

/** Collections agents never write, whatever the key's scopes. */
export const AGENT_READ_ONLY = new Set(['payments', 'settings', AUDIT_COLLECTION, 'auditLog']);
/** Statuses an agent may set; anything else is a person's decision. */
const AGENT_STATUS = { estimates: ['draft'], invoices: ['draft'], outbox: ['draft'] };

const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 };

const idString = { type: 'string', minLength: 1, maxLength: 128 };
const json = (v) => JSON.stringify(v, null, 1);

/** Agent policy on top of the key's scopes. Returns an error message or null. */
export function agentWriteRule(coll, existing, next) {
  if (AGENT_READ_ONLY.has(coll)) return `Agents cannot change ${coll}. A person does that in the app.`;
  const allowed = AGENT_STATUS[coll];
  if (allowed && next && 'status' in next) {
    const before = existing?.status ?? null;
    if (next.status !== before && !allowed.includes(next.status)) {
      return `Agents can only keep ${coll} in ${allowed.join(' or ')}; a person sends or finalises it in the app.`;
    }
  }
  if (allowed && existing && existing.status && !allowed.includes(existing.status)) {
    return `This ${coll.replace(/s$/, '')} is ${existing.status}; only a person can change it now.`;
  }
  return null;
}

function readable(p) { return COLLECTIONS.filter((c) => c !== AUDIT_COLLECTION && canRead(p, c)); }
function writable(p) { return COLLECTIONS.filter((c) => !AGENT_READ_ONLY.has(c) && canWrite(p, c)); }

/** The tools this key may use, with collection enums narrowed to its scopes. */
export function mcpTools(p) {
  const r = readable(p);
  const w = writable(p);
  const tools = [];
  if (r.length) {
    tools.push({
      name: 'list_records',
      title: 'List records',
      description: `List one collection, newest first, with optional exact filters (record ids, statuses, numbers). Collections this key can read: ${r.join(', ')}. Money is integer cents (CAD), lengths metres, dates YYYY-MM-DD.`,
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['collection'],
        properties: {
          collection: { type: 'string', enum: r },
          filters: { type: 'object', additionalProperties: { type: 'string', maxLength: 128 }, description: 'Exact-match filters, e.g. { "status": "sent" } or { "jobId": "..." }. Fields per collection are in the API docs (/api/v1/openapi.json).' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          cursor: { type: 'string', maxLength: 1000 },
        },
      },
      annotations: { readOnlyHint: true },
      scope: 'read',
    });
    tools.push({
      name: 'search_records',
      title: 'Search records',
      description: 'Find records in one collection by words in names, titles, numbers, SKUs, addresses and emails. Returns short summaries with ids.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['collection', 'query'],
        properties: { collection: { type: 'string', enum: r }, query: { type: 'string', minLength: 1, maxLength: 100 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
      },
      annotations: { readOnlyHint: true },
      scope: 'read',
    });
    tools.push({
      name: 'get_record',
      title: 'Get a record',
      description: 'Get one record by collection and id, with its version (send the version back to update_record).',
      inputSchema: { type: 'object', additionalProperties: false, required: ['collection', 'id'], properties: { collection: { type: 'string', enum: r }, id: idString } },
      annotations: { readOnlyHint: true },
      scope: 'read',
    });
  }
  if (w.length) {
    tools.push({
      name: 'create_record',
      title: 'Create a record',
      description: `Create a record. Collections this key can write: ${w.join(', ')}. Estimates, invoices and outbox messages are created as drafts; a person sends them from the app. Validated against the collection's JSON Schema.`,
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['collection', 'record'],
        properties: { collection: { type: 'string', enum: w }, record: { type: 'object', description: 'The record body; id optional.' } },
      },
      annotations: { destructiveHint: false, idempotentHint: false },
      scope: 'write',
    });
    tools.push({
      name: 'update_record',
      title: 'Update a record',
      description: 'Shallow-merge fields into a record. Pass ifVersion (from get_record) to fail instead of overwriting someone else\'s change. Agents cannot change status beyond draft or delete records.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['collection', 'id', 'patch'],
        properties: { collection: { type: 'string', enum: w }, id: idString, patch: { type: 'object' }, ifVersion: { type: 'integer', minimum: 1 } },
      },
      annotations: { destructiveHint: false, idempotentHint: true },
      scope: 'write',
    });
  }
  if (canWrite(p, 'estimates') && canRead(p, 'items')) {
    tools.push({
      name: 'draft_estimate',
      title: 'Draft estimate lines',
      description: 'Propose estimate lines for a person to review in the app: a new draft estimate or lines added to an existing one. Price-book items are priced from the price book, labour lines from the company labour rate; tax follows the company\'s province. Returns the proposal and a draft id; nothing changes until a person accepts it.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['lines'],
        properties: {
          estimateId: idString, title: { type: 'string', maxLength: 200 }, clientId: idString, jobId: idString,
          notes: { type: 'string', maxLength: 5000 }, treatment: { type: 'string', enum: Object.keys(TREATMENTS) },
          lines: { type: 'array', minItems: 1, maxItems: 200, items: LINE_SCHEMA },
        },
      },
      annotations: { destructiveHint: false },
      scope: 'draft',
    });
  }
  for (const t of CEC_TOOLS) {
    tools.push({ name: t.name, title: t.name.replace(/^cec_/, 'CEC ').replace(/_/g, ' '), description: t.description, inputSchema: t.input_schema, annotations: { readOnlyHint: true, openWorldHint: false }, scope: 'none', run: t.run });
  }
  return tools.sort((a, b) => (a.name < b.name ? -1 : 1));
}

const publicTool = (t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations });

/**
 * @param {{ db: import('../db.js').Db, records: object, config: object }} deps
 */
export function createMcp({ db, records, config }) {
  async function callTool(p, tool, args, who) {
    const ctx = { tenantId: p.tenantId, userId: null };
    switch (tool.name) {
      case 'list_records': {
        const def = collectionDef(args.collection);
        const allowed = new Set(filterFields(def));
        const filters = Object.fromEntries(Object.entries(args.filters || {}).filter(([k]) => allowed.has(k)));
        const out = await db.withTenant(ctx, (tx) => records.listRecords(tx, p, args.collection, { limit: args.limit, cursor: args.cursor, filters }));
        return { collection: args.collection, records: compact(out.data), cursor: out.cursor, more: out.more };
      }
      case 'search_records': {
        const rows = await db.withTenant(ctx, (tx) => searchRecords(tx, p, args.collection, { query: args.query, limit: args.limit }));
        return { collection: args.collection, count: rows.length, records: rows.map((r) => summarize(args.collection, r)) };
      }
      case 'get_record':
        return { collection: args.collection, record: compact(await db.withTenant(ctx, (tx) => readRecord(tx, p, args.collection, args.id))) };
      case 'create_record': {
        const body = { ...args.record };
        if (AGENT_STATUS[args.collection] && body.status == null) body.status = 'draft';
        const rule = agentWriteRule(args.collection, null, body);
        if (rule) throw new ApiError(403, 'forbidden', rule);
        const rec = await db.withTenant(ctx, (tx) => records.createRecord(tx, p, args.collection, body, who), { write: true });
        return { collection: args.collection, record: compact(rec) };
      }
      case 'update_record': {
        const rec = await db.withTenant(ctx, async (tx) => {
          const cur = await readRecord(tx, p, args.collection, args.id);
          const rule = agentWriteRule(args.collection, cur, { ...cur, ...args.patch });
          if (rule) throw new ApiError(403, 'forbidden', rule);
          return records.patchRecord(tx, p, args.collection, args.id, args.patch, { ifVersion: args.ifVersion ?? null }, who);
        }, { write: true });
        return { collection: args.collection, record: compact(rec) };
      }
      case 'draft_estimate':
        return db.withTenant(ctx, (tx) => proposeEstimate(tx, p, args, who), { write: true });
      default:
        if (tool.run) return tool.run({ context: {} }, args);
        throw new ApiError(400, 'bad_request', 'Unknown tool.');
    }
  }

  async function audit(p, request, name, ok, extra = {}) {
    await db.withTenant({ tenantId: p.tenantId }, (tx) => appendAudit(tx, tx.tenantId, {
      actor: p.actor, action: 'mcp.tool_call', collection: extra.collection || null, recordId: extra.id || null,
      summary: `${name}${ok ? '' : ' (refused)'}`, meta: { via: 'mcp', tool: name, ok }, request,
    }), { write: true });
  }

  /** One JSON-RPC request -> result or error object. */
  async function handle(p, msg, request) {
    const { method, params = {} } = msg;
    switch (method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
        return {
          protocolVersion: asked && PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'fishtape', title: 'Fishtape', version: config.version },
          instructions: 'Fishtape is job-management software for a Canadian electrical contractor. Tools act on one company\'s data within this API key\'s scopes. Money is integer cents (CAD); lengths are metres. You can read, search, create and update records, run CEC 2024 calculators and draft estimates; a person approves drafts, sends documents and deletes records in the app. CEC results are advisory: verify with the authority having jurisdiction.',
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: mcpTools(p).map(publicTool) };
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const tool = mcpTools(p).find((t) => t.name === name);
        if (!tool) {
          await audit(p, request, name.slice(0, 60) || '(none)', false);
          return { rpcError: { code: RPC.invalidParams, message: `Unknown tool or not allowed for this key: ${name.slice(0, 60)}` } };
        }
        const args = params.arguments && typeof params.arguments === 'object' ? structuredClone(params.arguments) : {};
        const bad = validateInput(tool.inputSchema, args);
        if (bad) {
          await audit(p, request, name, false);
          return { content: [{ type: 'text', text: bad }], isError: true };
        }
        try {
          const out = await callTool(p, tool, args, { actor: p.actor, request: { ...request }, conversationId: null });
          const isError = Boolean(out?.error);
          await audit(p, request, name, !isError, { collection: args.collection, id: args.id || out?.record?.id || out?.id });
          return { content: [{ type: 'text', text: json(out) }], structuredContent: out, ...(isError ? { isError: true } : {}) };
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          await audit(p, request, name, false, { collection: args.collection, id: args.id });
          return { content: [{ type: 'text', text: `${e.code}: ${e.message}` }], isError: true };
        }
      }
      default:
        return { rpcError: { code: RPC.methodNotFound, message: `Method not found: ${String(method).slice(0, 60)}` } };
    }
  }

  /**
   * A POST body: one JSON-RPC message or (protocol 2025-03-26) a batch.
   * @returns {Promise<{ status: number, body?: unknown }>}
   */
  async function post(p, body, request) {
    const batch = Array.isArray(body);
    const msgs = batch ? body : [body];
    if (!msgs.length) return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: RPC.invalidRequest, message: 'Empty batch.' } } };
    const out = [];
    for (const m of msgs) {
      if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') { out.push({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: RPC.invalidRequest, message: 'Not a JSON-RPC 2.0 message.' } }); continue; }
      const isRequest = typeof m.method === 'string' && m.id !== undefined && m.id !== null;
      if (!isRequest) continue; // notifications (e.g. notifications/initialized) and client responses get no reply
      try {
        const r = await handle(p, m, request);
        out.push(r?.rpcError ? { jsonrpc: '2.0', id: m.id, error: r.rpcError } : { jsonrpc: '2.0', id: m.id, result: r });
      } catch (e) {
        if (e instanceof ApiError && e.statusCode === 403 && e.code === 'feature_not_in_plan') throw e;
        out.push({ jsonrpc: '2.0', id: m.id, error: { code: RPC.internal, message: 'Internal error.' } });
      }
    }
    if (!out.length) return { status: 202 };
    return { status: 200, body: batch ? out : out[0] };
  }

  return { post, handle };
}

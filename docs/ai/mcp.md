# Connecting AI agents to Fishtape (MCP)

Fishtape runs a [Model Context Protocol](https://modelcontextprotocol.io) server so outside
agents (Claude Desktop, Claude Code, other MCP clients) can work with **one company's** data.

- **URL:** `https://<your Fishtape address>/api/mcp`
  (staging: `https://tgelectrical.truecollarbuilt.com/api/mcp`)
- **Transport:** Streamable HTTP, stateless. `POST` only, JSON responses; `GET` and `DELETE`
  answer 405 (no server-initiated stream, no sessions). Protocol versions 2025-11-25,
  2025-06-18, 2025-03-26 and 2024-11-05.
- **Auth:** `Authorization: Bearer ft_live_…` (`ft_test_…` outside production): a company API
  key. Session tokens are refused. The key's company must be on the Business plan (feature `mcp`).
- **Limits:** 120 requests per minute per key (`AI_MCP_PER_MINUTE`), on top of the API-key limit.

## 1. Create an API key

An owner or admin creates the key in the app: **Settings → Developer & API keys** (`#/developer`, Business
plan), with a name, scopes (the "AI agent that drafts estimates" preset, read-only, or custom per area)
and an optional expiry. Scripts can use `POST /api/v1/api-keys` `{ name, scopes, expiresAt? }`. The key is
shown once, with a copy button and this guide filled in. Give it **only the scopes the agent needs**:

| the agent should | scopes |
| --- | --- |
| answer questions about jobs, clients, the price book | `jobs:read`, `clients:read`, `items:read` |
| draft estimates for you to approve | add `estimates:write` (and `items:read`) |
| create or update leads or clients | `leads:write`, `clients:write` |
| everything it is allowed to touch | `*:write` (not recommended) |

Anyone with the key can act for the company within its scopes. The key list shows when each key was
last used. Revoke it on the same screen when it is no longer needed (or `DELETE /api/v1/api-keys/{id}`);
revocation is immediate.

## 2. Add the server to your client

**Claude Code**

```sh
claude mcp add --transport http fishtape https://<host>/api/mcp --header "Authorization: Bearer ft_live_YOUR_KEY"
```

**Claude Desktop** (Settings → Developer → Edit config, `claude_desktop_config.json`). Desktop's
config runs local servers, so use the `mcp-remote` bridge (needs Node.js) to reach the remote
server with a header:

```json
{
  "mcpServers": {
    "fishtape": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<host>/api/mcp", "--header", "Authorization:${FISHTAPE_KEY}"],
      "env": { "FISHTAPE_KEY": "Bearer ft_live_YOUR_KEY" }
    }
  }
}
```

(The header is split this way so the space in "Bearer …" stays inside the environment variable,
which avoids quoting problems on Windows.) Restart Claude Desktop afterwards.

**Other clients** (the MCP TypeScript or Python SDK, IDE agents): use the Streamable HTTP client
transport with the URL above and the `Authorization` header. For example, TypeScript:

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('https://<host>/api/mcp'),
  { requestInit: { headers: { Authorization: `Bearer ${process.env.FISHTAPE_KEY}` } } }));
console.log((await client.listTools()).tools.map((t) => t.name));
```

Claude's own MCP connector on the Messages API (`mcp_servers` with an `authorization_token`) works
the same way: pass the key without "Bearer".

## Tools

`tools/list` shows only what the key's scopes allow (collection lists are narrowed to them).

| tool | needs | notes |
| --- | --- | --- |
| `list_records` | `<collection>:read` | newest first, exact filters (`status`, `clientId`, `jobId`, `number`...), cursor paging |
| `search_records` | `<collection>:read` | words in names, titles, numbers, SKUs, addresses, emails |
| `get_record` | `<collection>:read` | includes `version` for safe updates |
| `create_record` | `<collection>:write` | validated against the collection's JSON Schema |
| `update_record` | `<collection>:write` | shallow merge; pass `ifVersion` to avoid overwriting someone's change |
| `draft_estimate` | `estimates:write` + `items:read` | proposes lines priced from the price book with the province's tax; a person accepts it under Assistant → Drafts |
| `cec_*` (8 calculators) | any valid key | CEC 2024 ampacity, conductor size, voltage drop, conduit fill, box fill, dwelling load, motor, province info. Advisory: verify with the authority having jurisdiction |

Agents **cannot**: delete anything (there is no delete tool), write `payments`, `settings` or the
audit log, move estimates, invoices or outbox messages out of `draft`, or change one that a person
already sent. Those stay with people in the app.

Money is integer cents (CAD), lengths metres, dates `YYYY-MM-DD`. Tool results come back as JSON
text and as `structuredContent`; refusals come back as `isError: true` with a reason.

## Audit and safety

Every `tools/call` is written to the company's audit log as `mcp.tool_call` with actor type
`api_key` (key id and name), the tool, and whether it was allowed; record writes add the usual
`record.create` / `record.update` events with the same actor. The endpoint checks `Origin`
(browsers may only call it from Fishtape's own origins) and the `MCP-Protocol-Version` header.
Requests without credentials are refused by the API's CSRF guard (403); bad, expired or revoked
keys get 401 `invalid_api_key`.

## Troubleshooting

| you see | it means |
| --- | --- |
| 401 `invalid_api_key` | wrong environment prefix (`ft_test_` vs `ft_live_`), revoked or expired key |
| 401 `unauthenticated` | a session token or no key was sent |
| 403 `feature_not_in_plan` | the company is not on Business |
| 429 `rate_limited` | over 120 requests a minute for this key |
| a tool is missing from the list | the key lacks the scope |
| `isError` "Agents can only keep invoices in draft" | by design: a person sends it from the app |

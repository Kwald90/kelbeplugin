# ADR-002: Sync protocol (push mutations, pull by change sequence)

- Status: accepted (2026-10-19)
- Deciders: Kelvin (product), workstream A (backend)

## Context

The PWA is offline-first: `store.js` keeps every record in memory and IndexedDB and must keep
its synchronous API. Electricians work in basements with no signal, on shared iPads and
phones. Office staff and integrations write through REST at the same time. We need a sync
that never loses an edit silently, never applies an edit twice, and never shows one company's
data to another.

## Decision

**Push.** `POST /api/v1/sync/push` with up to 500 mutations
`{ mid, collection, id, op: 'upsert'|'delete', baseVersion, data }`, applied in order:

- **Idempotent by `mid`.** Each result is stored in `sync_mutations` under `(tenant, mid)`. A
  retried push (lost response, app killed) gets the first result back and nothing is written
  twice. `mid`s are per company, so one company's ids never collide with another's.
- **Each mutation on its own.** Each runs in a savepoint; a rejected mutation (permissions,
  schema, size) does not undo the others. Results: `ok` with the new `version` and
  `changeSeq`, `conflict` with the winning server copy, or `rejected` with an error code.
- **Optimistic concurrency.** `baseVersion` is the server version the device last saw (null for
  a new record). If it matches, the write applies.
- **Last writer wins on conflict.** If it does not match, the edit with the later edit time
  wins: the mutation's `data.updatedAt` (for deletes, `data.deletedAt`/`updatedAt` or now)
  against the server copy's `updatedAt` (or its delete time). Client times more than 5 minutes
  ahead of the server are clamped to now, so a wrong clock cannot win forever. Ties go to the
  server.
- **The loser is kept** in `record_history`: `overwritten` (the server copy a newer client
  edit replaced) or `rejected` (a client edit older than the server copy, which the device
  then replaces with `server`).
- **Deletes are soft.** The row becomes a tombstone (`deleted_at`), keeps its id, and syncs.
  Deleting something already deleted, or never seen, is `ok`.
- The same validation, access rules and audit apply as for REST (one service,
  `server/src/services/records.js`).

**Pull.** `GET /api/v1/sync/pull?since=<changeSeq>&limit=500` returns every change after
`since`, oldest first, across every collection the caller may read (role permissions, own
time entries only for non-managers, API key scopes), as
`{ collection, id, version, deleted, data|null }`, with `cursor` (the last `change_seq`) and
`more`. One row per record: a record changed five times since the cursor arrives once, in its
latest state. Pages stop early at about 8 MB of data so big drawings page one at a time. The
pull runs in one REPEATABLE READ transaction.

**Ordering guarantee.** `change_seq` comes from one global sequence, but sequence values are
handed out before commit, so a naive "everything after N" can miss a slow transaction that
commits later with a smaller number. We prevent that per company: the row trigger takes a
per-company advisory lock before drawing `change_seq`, and holds it to commit. Within one
company, `change_seq` order is commit order, and pulls are always per company. The cursor is
just a number; a forged one changes only where in your own company's history you start.

## What the client (Phase 1 `sync.js`) must do

- Queue every local `add/update/remove` as a mutation with a fresh `mid` (UUID), the record's
  last known server `version` as `baseVersion`, and the whole record as `data`. Keep the queue
  in IndexedDB until each result comes back.
- On `ok`, store `version`. On `conflict`, replace the local record with `server` (or delete it
  if `server.deleted`). On `rejected`, keep the local copy, flag it, and stop retrying that
  `mid`.
- **Pull before the first push on a new device**, and never push untouched defaults. The
  `settings` record has a fixed id: a fresh install that pushes its default settings with a
  newer `updatedAt` would win over the company's real settings.
- Do not push `auditLog` entries the store writes for ordinary changes (the server audits
  those itself). Pushed `auditLog` upserts are accepted as client events (`client.<action>`)
  for things only the device knows (exports, local sign-ins); deletes are refused.
- Store `cursor` and pull with it on reconnect and periodically; apply tombstones as deletes.

## Consequences

- Simple, debuggable, and works through any proxy (plain JSON over HTTPS).
- Field-level merges are not attempted: two people editing different fields of the same record
  offline means the later one wins the whole record. The other edit is recoverable from
  `record_history`. If this bites (likely on big drawings), add per-collection merge rules or
  move drawing strokes to their own records.
- Wall-clock comparison depends on device clocks; clamping limits the damage. A hybrid logical
  clock can replace `updatedAt` later without changing the wire format much.
- Document numbers (`settings.nextNumbers`) are allocated on the device and can collide
  across devices; server-side numbering should come with Phase 1.
- Writes per company are serialised. Acceptable at contractor scale.

## Alternatives considered

- **CRDTs (Automerge/Yjs):** best merging, but large client changes, opaque storage, and
  harder RLS and validation. Overkill for forms-shaped records.
- **Timestamps as cursors:** clock skew and equal timestamps lose rows.
- **Logical replication / CDC to clients:** not suitable for browsers or per-tenant filtering.

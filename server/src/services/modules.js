// Module switches on the server (Settings → Modules, electrical-app/js/lib/modules.js). A
// company can turn off modules it doesn't use, separately from its plan. Writes into a
// turned-off module's collections are refused with 403 module_turned_off; reads never are, so
// turning a module back on brings every record back. The switches live in the company's
// settings record (settings.modules), which owners and admins change like any other setting.
import { blockingSwitch, switchOn, turnedOffMessage } from '../../../electrical-app/js/lib/modules.js';
import { ApiError } from '../errors.js';
import { tenantCtx } from '../routes/util.js';

export function moduleTurnedOff(id) {
  return new ApiError(403, 'module_turned_off', turnedOffMessage(id), { module: id });
}

/**
 * The company's settings record as far as switches go: { modules } (modules null when the
 * company has none, which means everything is on). Run inside the tenant's transaction.
 * @param {{ query: Function, tenantId: string }} tx
 */
export async function loadModuleSettings(tx) {
  const { rows } = await tx.query(
    "SELECT data->'modules' AS modules FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId]);
  const m = rows[0]?.modules;
  return { modules: m && typeof m === 'object' && !Array.isArray(m) ? m : null };
}

/** Throws module_turned_off when a write to `coll` is blocked by a switch. */
export function assertCollectionModuleOn(settings, coll) {
  const off = blockingSwitch(settings, coll);
  if (off) throw moduleTurnedOff(off);
}

/** Throws module_turned_off unless switch `id` is on. */
export async function assertModuleOn(tx, id) {
  if (!switchOn(await loadModuleSettings(tx), id)) throw moduleTurnedOff(id);
}

/** Fastify preHandler for routes that belong to one module (AI → assistant, KPIs → workplan). */
export function requireModule(db, id) {
  return async (req) => {
    const p = req.principal;
    if (!p?.tenantId) return;
    await db.withTenant(tenantCtx(p), (tx) => assertModuleOn(tx, id));
  };
}

// Tool inputs from the model (and from MCP clients) are untrusted: with eager input
// streaming the API no longer validates them, so every input is checked against the
// tool's JSON Schema here before the tool runs.
import Ajv from 'ajv';

const newAjv = () => new Ajv({ allErrors: false, strict: false, coerceTypes: false, useDefaults: true });
let ajv = newAjv();
// Keyed by the schema's JSON text: MCP tool lists are rebuilt per request (enums follow the
// key's scopes), and ajv would otherwise keep a compiled copy of every new schema object.
const cache = new Map();

function compiled(schema) {
  const key = JSON.stringify(schema);
  let fn = cache.get(key);
  if (!fn) {
    fn = ajv.compile(JSON.parse(key));
    if (cache.size > 500) { cache.clear(); ajv = newAjv(); }
    cache.set(key, fn);
  }
  return fn;
}

/** @returns {null | string} an error message naming the field, never echoing the value */
export function validateInput(schema, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'The input must be a JSON object.';
  const fn = compiled(schema);
  if (fn(input)) return null;
  const e = fn.errors?.[0];
  const where = e?.instancePath || (e?.params?.missingProperty ? `/${e.params.missingProperty}` : '') || (e?.params?.additionalProperty ? `/${e.params.additionalProperty}` : '');
  return `Invalid input${where ? ` at ${where}` : ''}: ${e?.message || 'does not match the schema'}.`;
}

// Record validation with the JSON Schemas the PWA also uses
// (electrical-app/js/schema/<collection>.json). No type coercion, all errors reported.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { COLLECTIONS } from './collections.js';

/** Where the shared schemas live; override with SCHEMA_DIR (e.g. inside a container). */
export function schemaDir() {
  if (process.env.SCHEMA_DIR) return process.env.SCHEMA_DIR.replace(/[\\/]?$/, '/');
  return fileURLToPath(new URL('../../electrical-app/js/schema/', import.meta.url));
}

/** @returns {Record<string, object>} collection name → JSON Schema */
export function loadSchemas(dir = schemaDir()) {
  const out = {};
  for (const c of COLLECTIONS) {
    const file = `${dir}${c}.json`;
    if (!existsSync(file)) throw new Error(`missing JSON Schema for collection ${c}: ${file}`);
    out[c] = JSON.parse(readFileSync(file, 'utf8'));
  }
  return out;
}

/**
 * @param {Record<string, object>} schemas
 * @returns {{ validate(collection: string, record: object): null | { path: string, message: string }[], schemas: Record<string, object> }}
 */
export function createValidator(schemas = loadSchemas()) {
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
  addFormats(ajv);
  const compiled = new Map(Object.entries(schemas).map(([c, s]) => [c, ajv.compile(s)]));
  return {
    schemas,
    validate(collection, record) {
      const fn = compiled.get(collection);
      if (!fn) return [{ path: '', message: `unknown collection ${collection}` }];
      if (fn(record)) return null;
      return (fn.errors || []).slice(0, 20).map((e) => ({ path: e.instancePath || '/', message: e.message || 'invalid' }));
    },
  };
}

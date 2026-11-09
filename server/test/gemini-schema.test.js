// Gemini tool-schema mapping (ai/gemini-client.js geminiSchema/toGeminiTools). Pure — no API, no pg.
// Regression: the CEC tools carry `enum` on integer fields (terminationC/insulationC [60,75,90]) and
// `additionalProperties`/`default`/`minimum`; Gemini rejects an enum on a non-STRING type and some
// keywords, which 400'd the CEC helper. The mapping must produce a schema Gemini accepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiSchema, toGeminiTools } from '../src/ai/gemini-client.js';

const walk = (s, fn) => {
  if (!s || typeof s !== 'object') return;
  fn(s);
  Object.values(s.properties || {}).forEach((v) => walk(v, fn));
  if (s.items) walk(s.items, fn);
};

test('geminiSchema keeps string enums but drops enum on non-string types', () => {
  const g = geminiSchema({
    type: 'object', additionalProperties: false, required: ['size'],
    properties: {
      size: { type: 'string', enum: ['14', '12', '10'] },
      insulationC: { type: 'integer', enum: [60, 75, 90], default: 90, description: 'Insulation rating.' },
      terminationC: { type: 'integer', enum: [60, 75, 90] },
      ambientC: { type: 'number', minimum: -50, maximum: 100, default: 30 },
      freeAir: { type: 'boolean', default: false },
    },
  });
  // string enum survives (as an enum on a STRING)
  assert.equal(g.properties.size.type, 'STRING');
  assert.deepEqual(g.properties.size.enum, ['14', '12', '10']);
  // integer enum: enum removed, type kept, allowed values folded into the description
  assert.equal(g.properties.insulationC.type, 'INTEGER');
  assert.equal(g.properties.insulationC.enum, undefined);
  assert.match(g.properties.insulationC.description, /Allowed values: 60, 75, 90/);
  assert.match(g.properties.terminationC.description, /Allowed values: 60, 75, 90/);
  // nothing Gemini rejects survives anywhere
  walk(g, (s) => {
    assert.ok(!('additionalProperties' in s), 'additionalProperties stripped');
    assert.ok(!('default' in s), 'default stripped');
    assert.ok(!('minimum' in s), 'minimum stripped');
    assert.ok(!('maximum' in s), 'maximum stripped');
    if (s.enum) assert.equal(s.type, 'STRING', 'enum only on STRING');
  });
});

test('toGeminiTools builds a functionDeclarations group and omits empty parameters', () => {
  const tools = toGeminiTools([
    { name: 'cec_ampacity', description: 'x', input_schema: { type: 'object', properties: { size: { type: 'string', enum: ['14'] } }, required: ['size'] } },
    { name: 'no_args', description: 'y', input_schema: { type: 'object', properties: {} } },
  ]);
  assert.equal(tools.length, 1);
  const decls = tools[0].functionDeclarations;
  const amp = decls.find((d) => d.name === 'cec_ampacity');
  assert.ok(amp.parameters && amp.parameters.properties.size, 'tool with args keeps parameters');
  const none = decls.find((d) => d.name === 'no_args');
  assert.equal(none.parameters, undefined, 'tool with no properties omits parameters');
});

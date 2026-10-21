// Estimates (js/modules/estimates.js needs a DOM, so this reads its source): a view-only user —
// one the plan gates out of Estimates, so ctx.readOnly is true — must not be able to sign, mark
// sent, record an email acceptance or revise. The merged readOnly now includes the plan lock, so
// the status-action buttons gate on !readOnly (not just !signed), and the mutating handlers guard
// with `if (readOnly) return;` as defence in depth.
// Run: node --test electrical-app/tests/*.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../js/modules/estimates.js', import.meta.url), 'utf8');

/** The body of a `const <name> = ...` handler, up to the next top-level `const ` at the same indent. */
function handler(name) {
  const at = src.indexOf(`  const ${name} = `);
  assert.ok(at > 0, `${name} is defined`);
  const next = src.indexOf('\n  const ', at + 1);
  return src.slice(at, next > 0 ? next : src.length);
}

describe('a view-only (plan-locked) user cannot write through the estimate detail screen', () => {
  test('drawStatus gates the workflow and revise actions on !readOnly, not just !signed', () => {
    const money = src.match(/\n\s*(\S[^\n]*)\? h\('div', \{ class: 'row money-actions' \}/);
    assert.ok(money, 'the workflow action row is present');
    assert.match(money[1], /!readOnly &&/, 'the Sign / Mark sent / Accept row is hidden under the plan lock');
    assert.doesNotMatch(money[1], /^!signed &&/, 'the row no longer renders to a plan-locked user just because it is unsigned');
    const revise = src.match(/\n\s*(\S[^\n]*)\? h\('div', \{ class: 'row' \}, ui\.button\('Revise'/);
    assert.ok(revise, 'the Revise row is present');
    assert.match(revise[1], /!readOnly &&/, 'Revise is hidden under the plan lock');
  });

  test('signHere, byEmail, markSent and revise bail when readOnly before any write', () => {
    for (const name of ['signHere', 'byEmail', 'markSent', 'revise']) {
      const body = handler(name);
      assert.match(body, /if \(readOnly\) return;/, `${name} guards on readOnly`);
      // The guard comes before the first write or flush in the handler.
      const guard = body.indexOf('if (readOnly) return;');
      const write = body.search(/save\.(flush|write)\(|store\.(add|update)\(/);
      assert.ok(guard >= 0 && (write === -1 || guard < write), `${name} guards before it writes`);
    }
  });
});

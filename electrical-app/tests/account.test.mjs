// Account page (js/modules/account.js needs a DOM, so this reads its source): the Password card
// for an account with no password (Google/Microsoft only) offers the emailed set-password link
// instead of a "change password" form whose "current password" can never be right.
// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../js/modules/account.js', import.meta.url), 'utf8');

test('Password card: no password yet means the emailed link, not the change form', () => {
  const at = src.indexOf('const pwCard =');
  assert.ok(at > 0, 'the Password card is built');
  const pwCard = src.slice(at, src.indexOf('\n\n', at));
  assert.match(pwCard, /^const pwCard = me\.user\?\.hasPassword === false\s*\?/, '/me hasPassword decides which card shows');
  const [setBranch, changeBranch] = pwCard.split(/\n\s*:\s*card\(/);
  assert.match(setBranch, /setPwBtn/);
  assert.doesNotMatch(setBranch, /curPw/, 'no "current password" field without a password');
  assert.match(changeBranch, /curPw, newPw, newPw2/);
  const setBtn = src.slice(src.indexOf('const setPwBtn'), at);
  assert.match(setBtn, /api\.post\('\/api\/v1\/auth\/password\/forgot', \{ email: me\.user\.email \}\)/);
});

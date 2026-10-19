// Run: node --test electrical-app/tests/*.test.mjs
// js/session.js in the iOS app (bearer tokens from the Keychain, the configured API origin) and on
// the web (cookies, same origin), against a fake fetch and a fake Capacitor bridge.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const ORIGIN = 'https://tgelectrical.truecollarbuilt.com';
const keychain = new Map();
const calls = [];
let answers = [];

function fakeFetch(url, init) {
  calls.push({ url, ...init, headers: { ...init.headers }, body: init.body === undefined ? undefined : JSON.parse(init.body) });
  const [status, body] = answers.shift() || [200, {}];
  return Promise.resolve({
    status, ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    json: async () => body,
  });
}

const nativeBridge = {
  isNativePlatform: () => true,
  Plugins: {
    FishtapeKeychain: {
      get: async ({ key }) => (keychain.has(key) ? { value: keychain.get(key) } : {}),
      set: async ({ key, value }) => { keychain.set(key, value); },
      remove: async ({ key }) => { keychain.delete(key); },
    },
  },
};

let S; // the native copy of session.js
const realFetch = globalThis.fetch;
before(async () => {
  globalThis.fetch = fakeFetch;
  globalThis.FISHTAPE_API_BASE = ORIGIN + '/';
  globalThis.Capacitor = nativeBridge;
  S = await import('../js/session.js?native');
});
after(() => {
  globalThis.fetch = realFetch;
  delete globalThis.FISHTAPE_API_BASE;
  delete globalThis.Capacitor;
});

const last = () => calls.at(-1);

test('iOS app: sign in asks for a bearer token and keeps it in the Keychain, not web storage', async () => {
  globalThis.Capacitor = nativeBridge;
  assert.equal(S.API_BASE, ORIGIN);
  answers = [[200, { token: 'tok-1', mfa: null, me: { user: { id: 'u1' } } }]];
  const r = await S.session.login('a@b.ca', 'pw');
  assert.equal(r.token, 'tok-1');
  const c = last();
  assert.equal(c.url, `${ORIGIN}/api/v1/auth/login`);
  assert.deepEqual(c.body, { email: 'a@b.ca', password: 'pw', mode: 'bearer' });
  assert.equal(c.credentials, 'omit');
  assert.equal(c.headers['X-Fishtape'], '1', 'the CSRF header still goes on writes');
  assert.equal(c.headers.Authorization, undefined);
  assert.equal(keychain.get('session'), 'tok-1');

  answers = [[200, { user: { id: 'u1' } }]];
  await S.api.get('/api/v1/me');
  assert.equal(last().url, `${ORIGIN}/api/v1/me`);
  assert.equal(last().headers.Authorization, 'Bearer tok-1');
  assert.equal(last().headers['X-Fishtape'], undefined);
  assert.equal(last().credentials, 'omit');
});

test('iOS app: shared iPad device token, crew sign-in and sign-out', async () => {
  globalThis.Capacitor = nativeBridge;
  answers = [[201, { device: { id: 'd1', name: 'Site iPad' }, deviceToken: 'ftd_dev-1' }]];
  await S.api.post('/api/v1/devices', { name: 'Site iPad' });
  assert.equal(keychain.get('device'), 'ftd_dev-1');

  answers = [[204, null]];
  await S.session.logout();
  assert.equal(last().url, `${ORIGIN}/api/v1/auth/logout`);
  assert.equal(last().headers.Authorization, 'Bearer tok-1', 'logout revokes this session');
  assert.equal(keychain.has('session'), false, 'sign-out clears the token');

  answers = [[200, { company: 'TG', crew: [] }]];
  await S.api.get('/api/v1/devices/crew');
  assert.equal(last().headers.Authorization, undefined);
  assert.equal(last().headers['X-Fishtape-Device'], 'ftd_dev-1');

  answers = [[200, { token: 'crew-1', name: 'Sam', role: 'electrician' }]];
  await S.api.post('/api/v1/devices/crew/sign-in', { membershipId: 'm1', pin: '1234' });
  assert.deepEqual(last().body, { membershipId: 'm1', pin: '1234', mode: 'bearer' });
  assert.equal(keychain.get('session'), 'crew-1');

  S.session.setDevice(null);
  await new Promise((r) => setImmediate(r));
  assert.equal(keychain.has('device'), false);
});

test('iOS app: a failed sign-in keeps the old token; Google and Microsoft are hidden', async () => {
  globalThis.Capacitor = nativeBridge;
  answers = [[401, { error: { code: 'invalid_credentials', message: 'Email or password is wrong.' } }]];
  await assert.rejects(S.session.login('a@b.ca', 'nope'), (e) => e.code === 'invalid_credentials' && e.status === 401);
  assert.equal(keychain.get('session'), 'crew-1');
  answers = [[200, { password: true, google: true, microsoft: true, signupOpen: false }]];
  assert.deepEqual(await S.session.providers(), { password: true, google: false, microsoft: false, signupOpen: false });
});

test('authInit (also used by integrations.js): Keychain token in the app, the cookie on the web', async () => {
  globalThis.Capacitor = nativeBridge;
  const n = await S.authInit({ 'x-fishtape': '1' }, { webCredentials: 'same-origin' });
  assert.deepEqual(n, { headers: { 'x-fishtape': '1', Authorization: 'Bearer crew-1' }, credentials: 'omit' });
  delete globalThis.Capacitor;
  assert.deepEqual(await S.authInit({ 'x-fishtape': '1' }, { webCredentials: 'same-origin' }), { headers: { 'x-fishtape': '1' }, credentials: 'same-origin' });
});

test('web: same origin with the cookie, no mode, no token handling', async () => {
  delete globalThis.Capacitor;
  delete globalThis.FISHTAPE_API_BASE;
  const W = await import('../js/session.js?web');
  assert.equal(W.API_BASE, '');
  const before = new Map(keychain);
  answers = [[200, { mfa: null, me: { user: { id: 'u1' } } }]];
  await W.session.login('a@b.ca', 'pw');
  assert.equal(last().url, '/api/v1/auth/login');
  assert.deepEqual(last().body, { email: 'a@b.ca', password: 'pw' });
  assert.equal(last().credentials, 'include');
  assert.equal(last().headers['X-Fishtape'], '1');
  assert.equal(last().headers.Authorization, undefined);
  answers = [[200, { password: true, google: true, microsoft: false }]];
  assert.deepEqual(await W.session.providers(), { password: true, google: true, microsoft: false });
  assert.deepEqual(keychain, before);
});

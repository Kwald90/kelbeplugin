// Register the app's bundle ID with Apple through the App Store Connect API. Run on the build Mac:
//   node mobile/scripts/register-bundle-id.mjs [identifier] [name]
// Reads ~/.appstoreconnect/api_key.json ({ key_id, issuer_id, key_filepath }). Prints only the
// result: never the key or the signed token. Safe to re-run: an existing ID is reported, not duplicated.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createSign } from 'node:crypto';

const IDENTIFIER = process.argv[2] || 'com.fishtapehq.app';
const NAME = process.argv[3] || 'Fishtape';
const API = 'https://api.appstoreconnect.apple.com/v1';

const cfg = JSON.parse(readFileSync(`${homedir()}/.appstoreconnect/api_key.json`, 'utf8'));
const keyPath = String(cfg.key_filepath || '').replace(/^~/, homedir());
const key = readFileSync(keyPath, 'utf8');

const b64u = (b) => Buffer.from(b).toString('base64url');
function token() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'ES256', kid: cfg.key_id, typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: cfg.issuer_id, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }));
  const sig = createSign('SHA256').update(`${head}.${body}`).sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}

async function call(method, path, payload) {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (json.errors || []).map((e) => `${e.code}: ${e.detail || e.title}`).join('; ');
    throw new Error(`${method} ${path} -> ${res.status} ${err}`);
  }
  return json;
}

const show = (d) => console.log(JSON.stringify({ id: d.id, identifier: d.attributes.identifier, name: d.attributes.name, platform: d.attributes.platform, teamId: d.attributes.seedId }, null, 2));

const found = await call('GET', `/bundleIds?filter[identifier]=${encodeURIComponent(IDENTIFIER)}&limit=50`);
const exact = (found.data || []).find((d) => d.attributes.identifier === IDENTIFIER);
if (exact) {
  console.log('Already registered:');
  show(exact);
} else {
  const created = await call('POST', '/bundleIds', { data: { type: 'bundleIds', attributes: { identifier: IDENTIFIER, name: NAME, platform: 'IOS' } } });
  console.log('Registered:');
  show(created.data);
}

// Small App Store Connect API helper for TestFlight uploads. Run on the build Mac:
//   node mobile/scripts/asc.mjs app [bundleId]                         the app record (id, name, SKU)
//   node mobile/scripts/asc.mjs wait-build <buildNumber> [minutes]     wait until the upload is processed
//   node mobile/scripts/asc.mjs testflight <buildNumber> [group]       put the build in an internal group
// Reads ~/.appstoreconnect/api_key.json ({ key_id, issuer_id, key_filepath }) like
// register-bundle-id.mjs. Prints only results: never the key, the issuer ID or the signed token.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createSign } from 'node:crypto';

const API = 'https://api.appstoreconnect.apple.com/v1';
const BUNDLE_ID = process.env.FISHTAPE_BUNDLE_ID || 'com.fishtapehq.app';
const DEFAULT_GROUP = 'TG Electrical';

const cfg = JSON.parse(readFileSync(`${homedir()}/.appstoreconnect/api_key.json`, 'utf8'));
const key = readFileSync(String(cfg.key_filepath || '').replace(/^~/, homedir()), 'utf8');

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
  if (res.status === 204) return null;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (json.errors || []).map((e) => `${e.code}: ${e.detail || e.title}`).join('; ');
    throw new Error(`${method} ${path.split('?')[0]} -> ${res.status} ${err}`);
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => console.log(JSON.stringify(o, null, 2));

async function app(bundleId = BUNDLE_ID) {
  const r = await call('GET', `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=name,bundleId,sku,primaryLocale`);
  const a = (r.data || []).find((d) => d.attributes.bundleId === bundleId);
  if (!a) throw new Error(`No App Store Connect app record for ${bundleId}. Create it under Apps > + > New App.`);
  return { id: a.id, name: a.attributes.name, bundleId: a.attributes.bundleId, sku: a.attributes.sku };
}

async function findBuild(appId, number) {
  const r = await call('GET', `/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(number)}&fields[builds]=version,processingState,uploadedDate,expired,usesNonExemptEncryption&limit=5`);
  return r.data?.[0] || null;
}

async function waitBuild(number, minutes = 25) {
  const a = await app();
  const until = Date.now() + minutes * 60_000;
  let last = '';
  for (;;) {
    const b = await findBuild(a.id, number);
    const state = b ? b.attributes.processingState : 'NOT_YET_VISIBLE';
    if (state !== last) { console.log(`${new Date().toISOString()} build ${number}: ${state}`); last = state; }
    if (b && state !== 'PROCESSING') {
      out({ build: number, id: b.id, processingState: state, usesNonExemptEncryption: b.attributes.usesNonExemptEncryption });
      if (state !== 'VALID') process.exitCode = 1;
      return b;
    }
    if (Date.now() > until) { console.log(`Still ${state} after ${minutes} minutes; check App Store Connect > TestFlight later.`); process.exitCode = 2; return null; }
    await sleep(30_000);
  }
}

async function testflight(number, groupName = DEFAULT_GROUP) {
  const a = await app();
  const b = await findBuild(a.id, number);
  if (!b) throw new Error(`Build ${number} isn't in App Store Connect yet.`);
  const groups = await call('GET', `/betaGroups?filter[app]=${a.id}&fields[betaGroups]=name,isInternalGroup,hasAccessToAllBuilds&limit=50`);
  let g = (groups.data || []).find((x) => x.attributes.name === groupName);
  if (!g) {
    g = (await call('POST', '/betaGroups', {
      data: {
        type: 'betaGroups',
        attributes: { name: groupName, isInternalGroup: true, hasAccessToAllBuilds: true },
        relationships: { app: { data: { type: 'apps', id: a.id } } },
      },
    })).data;
    console.log(`Created internal TestFlight group "${groupName}".`);
  }
  if (!g.attributes.hasAccessToAllBuilds) {
    await call('POST', `/betaGroups/${g.id}/relationships/builds`, { data: [{ type: 'builds', id: b.id }] });
  }
  const testers = await call('GET', `/betaGroups/${g.id}/betaTesters?fields[betaTesters]=email&limit=200`);
  out({
    group: g.attributes.name, internal: g.attributes.isInternalGroup, allBuilds: g.attributes.hasAccessToAllBuilds,
    build: number, testers: (testers.data || []).length,
  });
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'app') out(await app(args[0]));
  else if (cmd === 'wait-build') await waitBuild(args[0], Number(args[1]) || 25);
  else if (cmd === 'testflight') await testflight(args[0], args[1]);
  else { console.error('usage: asc.mjs app [bundleId] | wait-build <buildNumber> [minutes] | testflight <buildNumber> [group]'); process.exitCode = 64; }
} catch (e) {
  console.error(`asc: ${e.message}`);
  process.exitCode = 1;
}

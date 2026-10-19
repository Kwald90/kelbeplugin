// Run: cd mobile && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { API_ORIGINS, buildConfig, configScript, withConfigScript } from './web-config.mjs';

test('staging is the default; production and a custom https origin can be picked', () => {
  assert.deepEqual(buildConfig({}), { env: 'staging', apiOrigin: 'https://tgelectrical.truecollarbuilt.com' });
  assert.deepEqual(buildConfig({ FISHTAPE_ENV: 'production' }), { env: 'production', apiOrigin: API_ORIGINS.production });
  assert.deepEqual(buildConfig({ FISHTAPE_API_ORIGIN: 'https://api.test.example:8443/' }), { env: 'staging', apiOrigin: 'https://api.test.example:8443' });
});

test('bad settings stop the build', () => {
  assert.throws(() => buildConfig({ FISHTAPE_ENV: 'prod' }), /FISHTAPE_ENV must be staging or production/);
  assert.throws(() => buildConfig({ FISHTAPE_ENV: 'toString' }), /FISHTAPE_ENV must be/);
  assert.throws(() => buildConfig({ FISHTAPE_API_ORIGIN: 'http://192.168.0.5:3410' }), /must be https/);
  assert.throws(() => buildConfig({ FISHTAPE_API_ORIGIN: 'https://x.example/api' }), /no path/);
  assert.throws(() => buildConfig({ FISHTAPE_API_ORIGIN: 'https://x.example";alert(1);"' }), /must be https/);
});

test('config.js sets the globals session.js reads, as JSON strings', () => {
  const js = configScript({ env: 'staging', apiOrigin: 'https://tgelectrical.truecollarbuilt.com' });
  const win = {};
  new Function('window', js)(win);
  assert.deepEqual(win, { FISHTAPE_ENV: 'staging', FISHTAPE_API_BASE: 'https://tgelectrical.truecollarbuilt.com' });
  const code = js.split('\n').filter((l) => !l.startsWith('//')).join('\n');
  assert.doesNotMatch(code, /key|token|secret|password/i);
});

test('config.js loads before the app module in the real index.html', () => {
  const html = withConfigScript(readFileSync(new URL('../../electrical-app/index.html', import.meta.url), 'utf8'));
  const config = html.indexOf('<script src="config.js"></script>');
  const app = html.indexOf('<script type="module" src="js/app.js"></script>');
  assert.ok(config > 0 && app > config);
  assert.throws(() => withConfigScript('<html></html>'), /no longer has/);
});

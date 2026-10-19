// The iOS build's web config: which API the app talks to. Used by copy-web.mjs; tested in
// mobile/scripts/web-config.test.mjs.
//
// The app runs at capacitor://localhost, so it can't use relative /api URLs:
//   FISHTAPE_ENV=staging (default)  https://tgelectrical.truecollarbuilt.com
//   FISHTAPE_ENV=production         https://app.fishtapehq.com (not live yet)
//   FISHTAPE_API_ORIGIN=https://…   any other https origin, for testing
// www/config.js sets window.FISHTAPE_ENV and window.FISHTAPE_API_BASE; electrical-app/js/session.js
// reads FISHTAPE_API_BASE. It is a classic <script> before js/app.js. It holds no secrets.

export const API_ORIGINS = {
  staging: 'https://tgelectrical.truecollarbuilt.com',
  production: 'https://app.fishtapehq.com',
};

/** { env, apiOrigin } for this build, or throws with a plain-English reason. */
export function buildConfig(environ = process.env) {
  const env = environ.FISHTAPE_ENV || 'staging';
  if (!environ.FISHTAPE_API_ORIGIN && !Object.hasOwn(API_ORIGINS, env)) {
    throw new Error(`FISHTAPE_ENV must be ${Object.keys(API_ORIGINS).join(' or ')} (got "${env}"), or set FISHTAPE_API_ORIGIN`);
  }
  const apiOrigin = String(environ.FISHTAPE_API_ORIGIN || API_ORIGINS[env]).replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(apiOrigin)) {
    throw new Error(`The API origin must be https://host with no path (got "${apiOrigin}")`);
  }
  return { env, apiOrigin };
}

/** The text of www/config.js. */
export function configScript({ env, apiOrigin }) {
  return [
    '// Written by mobile/scripts/copy-web.mjs for the Fishtape iOS app. Not part of the PWA. No secrets.',
    `window.FISHTAPE_ENV = ${JSON.stringify(env)};`,
    `window.FISHTAPE_API_BASE = ${JSON.stringify(apiOrigin)};`,
    '',
  ].join('\n');
}

const APP_SCRIPT = '<script type="module" src="js/app.js"></script>';

/** index.html with config.js loaded before the app. */
export function withConfigScript(html) {
  if (!html.includes(APP_SCRIPT)) throw new Error(`index.html no longer has ${APP_SCRIPT}; update mobile/scripts/web-config.mjs`);
  return html.replace(APP_SCRIPT, `<script src="config.js"></script>\n  ${APP_SCRIPT}`);
}

// Where the app lives, as seen from a public site page. In production the marketing site is
// the apex (fishtapehq.com) and the app is app.fishtapehq.com; on staging and locally they share
// one host, so the app is at `/`. A page can pin it with <meta name="fishtape-app" content="https://…">.
// Links marked data-app-link (value = path inside the app, default "/") are pointed there.

/** Marketing hosts whose app is on another host. */
export const APP_ORIGIN_BY_HOST = Object.freeze({
  'fishtapehq.com': 'https://app.fishtapehq.com',
  'www.fishtapehq.com': 'https://app.fishtapehq.com',
  'fishtapehq.ca': 'https://app.fishtapehq.com',
  'www.fishtapehq.ca': 'https://app.fishtapehq.com',
});

/** '' (same host) or an https origin. Pure, for tests. */
export function appOriginFor(hostname, metaContent = '') {
  const meta = String(metaContent || '').trim().replace(/\/$/, '');
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(meta)) return meta;
  return APP_ORIGIN_BY_HOST[String(hostname || '').toLowerCase()] || '';
}

export function appOrigin(doc = document) {
  return appOriginFor(doc.defaultView?.location?.hostname, doc.querySelector('meta[name="fishtape-app"]')?.content);
}

/** URL of a path inside the app ("/" or "/#/sign-in"). */
export function appUrl(path = '/', doc = document) {
  const p = String(path || '/').startsWith('/') ? String(path || '/') : `/${path}`;
  return `${appOrigin(doc)}${p}`;
}

/** Point every [data-app-link] at the app. */
export function wireAppLinks(doc = document) {
  for (const a of doc.querySelectorAll('a[data-app-link]')) a.href = appUrl(a.dataset.appLink || '/', doc);
}

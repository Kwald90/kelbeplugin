# Security headers and Content Security Policy

| | |
| --- | --- |
| Owner | Kelvin Waldner |
| Applies to | nginx on staging and production; the PWA (`electrical-app/`), HQ console, `sw.js` |
| Review cadence | Annually, and whenever a header file, `index.html`, `sw.js` or a third-party script changes |
| Last reviewed | 2026-10-19 |
| Related controls | SDL (secure development), CRY (TLS, HSTS), OPS in `compliance/controls.yaml` |

Every header Fishtape sends, why, and how to change them without breaking the app or the
protection. The headers are set by nginx. The API sets its own `Cache-Control` and, for any HTML
it serves, its own CSP (required by the contract).

| file | installed as | used by |
| --- | --- | --- |
| `deploy/staging/security-headers.conf` | `/etc/nginx/snippets/fishtape-staging-headers.conf` | the staging vhost, through `nginx-api.conf.snippet` |
| `deploy/production/nginx/security-headers.conf` | `/etc/nginx/snippets/fishtape-headers.conf` | every HTTPS server block in `fishtape.conf` |
| `deploy/production/nginx/proxy.conf`, `deploy/staging/nginx-proxy.conf` (identical; CI checks) | `fishtape-proxy.conf`, `fishtape-staging-proxy.conf` | every `/api/` location: body limit, `no-store`, transport headers |
| `deploy/production/nginx/deny.conf`; the same rules inside `deploy/staging/nginx-api.conf.snippet` | `fishtape-deny.conf` | 404 for dotfiles, repo folders, scripts, dumps, keys and config files |
| `deploy/staging/nginx-http.conf`; top of `deploy/production/nginx/fishtape.conf` | `fishtape-staging-http.conf` | access log formats without query strings |

The two header files must send the same CSP and Permissions-Policy; `check-csp.mjs` fails CI
otherwise. Header files are installed by `install-nginx.sh`, not by `update.sh`: after a change,
run `sudo deploy/<env>/install-nginx.sh` on each host.

## Response headers

| header | value | why |
| --- | --- | --- |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | After one visit, browsers use HTTPS only for a year, for this host and its subdomains. Stops SSL stripping on job-site and hotel Wi-Fi. No `preload` yet ([below](#hsts-preload-for-fishtapehqcom)). |
| `X-Content-Type-Options` | `nosniff` | Browsers trust `Content-Type`, so a JSON or text response can't be run as a script or stylesheet. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Other sites see only `https://app.fishtapehq.com`, never paths or query strings; nothing at all goes from HTTPS to HTTP. |
| `X-Frame-Options` | `DENY` | Older browsers' version of `frame-ancestors 'none'`: no site can frame Fishtape (clickjacking). |
| `Cross-Origin-Opener-Policy` | `same-origin` | Windows from other sites can't keep a handle on ours (`window.opener`), which closes several cross-window leaks. Side effect: sign-in with Google or Microsoft must use full-page redirects, not popups. |
| `Cross-Origin-Resource-Policy` | `same-origin` | Other sites can't embed our files (images, scripts, JSON). If an email template ever loads an image straight from our host, some webmail clients will refuse it; host email images elsewhere or relax CORP for that one path. |
| `Permissions-Policy` | see the table below | Turns off browser features Fishtape doesn't use, for our pages and any frame. |
| `Content-Security-Policy` | see [the CSP](#content-security-policy) | Limits where scripts, styles, images and connections can come from; the main defence against XSS doing damage. |
| `Cache-Control` | per path ([caching](#caching-rules)); `no-store` on `/api/` | Updates reach devices quickly; API responses are never kept by the browser's disk cache or a shared cache. |
| `Server` | `nginx`, no version (`server_tokens off`) | No version banner for scanners. `X-Powered-By` from the API is removed (`proxy_hide_header`). |
| `X-Robots-Tag` | `noindex, nofollow` (on `hq.` only) | Keeps the HQ console out of search engines. |

On `/api/` responses nginx sends only the transport headers (HSTS, `nosniff`, Referrer-Policy,
X-Frame-Options) and `Cache-Control: no-store`. It hides the API's own copies of those headers,
its `Cache-Control` and `X-Powered-By`, so no response carries two different values. The API's
own CSP (`default-src 'none'`), CORP and COOP pass through.

### Permissions-Policy

| feature | setting | why |
| --- | --- | --- |
| `camera` | `(self)` | AR measuring, photos of work |
| `xr-spatial-tracking` | `(self)` | WebXR AR tape measure on Android |
| `accelerometer`, `gyroscope`, `magnetometer` | `(self)` | device orientation for AR and level tools |
| `geolocation` | `(self)` | job-site location |
| `fullscreen` | `(self)` | drawings full screen |
| `screen-wake-lock` | `(self)` | keep the screen on while measuring or bending |
| `clipboard-write` | `(self)` | copy numbers and links |
| `microphone`, `payment`, `usb`, `serial`, `hid`, `bluetooth`, `midi`, `display-capture` | `()` | not used; denied to us and to any frame |
| `browsing-topics` | `()` | opts out of the Topics advertising API |

`(self)` also means a frame from another origin can't use the feature. We have no frames today.

## Content Security Policy

The policy, one directive per line (nginx sends it on one line):

```
default-src 'self';
script-src 'self';
style-src 'self';
style-src-attr 'unsafe-hashes' 'sha256-EcJt9BR7RzlCkX1VP+89sqJ3ShKTcSMgu49NQP6XlIU=';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self';
worker-src 'self' blob:;
manifest-src 'self';
media-src 'self' blob:;
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests
```

| directive | why |
| --- | --- |
| `default-src 'self'` | Fallback for anything not listed: our own origin only. |
| `script-src 'self'` | Our ES modules and the self-hosted pdf.js. No `'unsafe-inline'` and no `'unsafe-eval'`: inline scripts, `onclick="..."`, `javascript:` URLs, `eval` and `new Function` don't run. |
| `style-src 'self'` | Stylesheets from `css/` only; `<style>` blocks are refused. |
| `style-src-attr 'unsafe-hashes' 'sha256-...'` | One exception for one inline `style` attribute: the `#boot` loading message in `index.html`. `'unsafe-hashes'` is the keyword that lets a hash apply to an attribute; despite its name, only that exact text is allowed. |
| `img-src 'self' data: blob:` | Drawing thumbnails and plan underlays are `data:` URLs; photos and canvas exports are `blob:` URLs. Images from other hosts are refused, which also blocks tracking pixels and data exfiltration through image URLs in AI output. |
| `font-src 'self' data:` | Local fonts and fonts embedded in CSS. |
| `connect-src 'self'` + pdf.js path | `fetch` and XHR to our own API only. The pdf.js path is here because `sw.js` re-fetches the page's requests, and a service worker's fetches are connections. |
| `worker-src 'self' blob:` | `sw.js` (service workers fall under `worker-src`) and the pdf.js worker (same-origin since the self-hosting; `blob:` kept until re-tested). |
| `manifest-src 'self'` | The web app manifest. |
| `media-src 'self' blob:` | Media played back from `blob:` URLs. |
| `frame-src 'none'` | No iframes at all. Stripe Elements would change this ([below](#stripe)). |
| `object-src 'none'` | No plugins (`<object>`, `<embed>`). |
| `base-uri 'none'` | No `<base>` tag, so injected markup can't re-point relative URLs. |
| `form-action 'self'` | Forms post only to our origin. |
| `frame-ancestors 'none'` | Nobody can frame us. |
| `upgrade-insecure-requests` | Any `http://` sub-resource is fetched over HTTPS. |

There is no `report-to` or `report-uri` yet, so violations in the field are invisible. Planned:
a rate-limited report endpoint in the API, and new policies tried as
`Content-Security-Policy-Report-Only` before they are enforced.

### What the CSP allows and blocks in this app

Allowed:

- `<script type="module" src="js/app.js">` and every module it imports from our origin;
- pdf.js and its worker from the pinned path;
- stylesheets from `css/`;
- styles set from JavaScript through the CSSOM: `el.style.color = ...` or
  `Object.assign(el.style, {...})`, which is what `h()` in `ui.js` does with an object `style`
  prop. CSP does not govern CSSOM property writes;
- SVG markup inserted with `innerHTML` in `icons.js` (CSP stops scripts, not markup);
- images from `data:` and `blob:` URLs;
- `fetch` to `/api/`.

Blocked:

- inline `<script>` and scripts from any other host;
- `on*="..."` handler attributes, including ones inside markup set through `innerHTML`;
- `javascript:` URLs;
- `eval`, `new Function`, `setTimeout('code as a string')`;
- `<style>` blocks; `style="..."` in HTML, `el.setAttribute('style', ...)`, and a string `style`
  prop passed to `h()` (which becomes an attribute), except the exact `#boot` text;
- images, fonts, scripts and fetches from other hosts (Google Fonts, analytics, map tiles, an
  image link in an AI answer);
- any iframe (YouTube, maps, Stripe Elements);
- `<object>`, `<embed>`, `<base>`;
- forms posting elsewhere; being framed.

`.github/scripts/check-csp.mjs` catches most of the blocked list in CI, so a problem shows up in
the pull request and not on a crew member's iPad. It also lists external origins found in app
code and whether the CSP allows them. Mark a reviewed exception with `csp-ok` in a comment on
that line.

### The `#boot` hash

`index.html` has one inline style:

```html
<div id="boot" style="position:fixed;inset:0;display:grid;place-items:center;font:600 14px system-ui;color:#5f5a51">
```

The CSP hash covers that exact attribute text. Change one character (even a space) and:

- the browser ignores the style (the "Loading Fishtape..." text flashes unstyled) and logs a CSP
  violation in the console;
- CI fails: `check-csp.mjs` hashes every inline style and finds this one isn't allowed.

To fix it, compute the new hash and put it in both header files in the same commit (CI checks
that they match), then run `install-nginx.sh` on each host when the commit is deployed:

```bash
printf '%s' 'position:fixed;inset:0;display:grid;place-items:center;font:600 14px system-ui;color:#5f5a51' \
  | openssl dgst -sha256 -binary | openssl base64
# EcJt9BR7RzlCkX1VP+89sqJ3ShKTcSMgu49NQP6XlIU=
```

Simpler later: move the boot style into `css/app.css` (`#boot { ... }`) and drop `style-src-attr`
entirely. `index.html` is a frozen shared file in Phase 0, so this waits for Phase 1.

## The add_header inheritance trap

nginx copies `add_header` lines from the server level into a `location` only if that location
has no `add_header` of its own. One header added in a location silently drops all the others
there, CSP and HSTS included:

```nginx
server {
    include /etc/nginx/snippets/fishtape-headers.conf;   # CSP, HSTS, ...
    location = /sw.js {
        add_header Service-Worker-Allowed "/";          # this one line drops every
    }                                                   # header above for /sw.js
}
```

How the config avoids it:

1. All security headers sit in one snippet, included once at server level.
2. Static locations use `expires` for caching, which is not `add_header`, so they keep the
   server-level headers.
3. The `/api/` locations need their own headers, so they include the shared proxy snippet
   (`proxy.conf` in production, the identical `nginx-proxy.conf` on staging), which repeats the
   transport headers deliberately and adds `Cache-Control: no-store`. It leaves out CSP and
   Permissions-Policy on purpose.
4. On `hq.`, `X-Robots-Tag` is added at server level next to the include; both apply.
5. Every header uses `always`, so 404s, 429s and 500s carry them too.
6. Rule: never put `add_header` inside a location. If you must, `include` the headers snippet in
   that location as well.
7. Staging: delete CloudPanel's own `add_header` lines from the vhost (README step 5). Two CSP
   headers are both enforced (the stricter combination wins); two different `X-Frame-Options`
   values may both be ignored.
8. `deploy/check-exposure.sh` checks the required headers on several kinds of path after every
   deploy.

## Caching rules

| path | rule | `Cache-Control` sent |
| --- | --- | --- |
| `/sw.js` | `expires epoch` | `no-cache` |
| `/index.html` and `/` | `expires epoch` | `no-cache` |
| `/manifest.webmanifest` | `expires epoch` | `no-cache` |
| app code: `*.js`, `*.mjs`, `*.css`, `*.json` | `expires epoch` | `no-cache` (revalidated each load; unchanged files answer `304`) |
| images, icons, fonts | `expires 30d` | `max-age=2592000` |
| `/vendor/<name>-<version>/` | `expires 1y` | `max-age=31536000` |
| `/api/` | forced in nginx | `no-store` |
| `/hq/` (staging) | `expires epoch` | `no-cache` |
| anything else | not on the allow-list | `404` (no SPA fallback; the app uses a hash router) |

`expires epoch` sends `Cache-Control: no-cache` with an `Expires` date in 1970: the browser may
keep the file but must ask the server before using it.

Why app code is never long-cached: there is no build step, so file names never change when the
code does. ES modules import each other by URL. If `ui.js` were cached for 30 days and `app.js`
changed, the browser would run new `app.js` against old `ui.js`: broken imports at best, a
security fix that never reaches the iPad at worst. The service worker's network-first `fetch()`
still goes through the browser's HTTP cache, so a long `max-age` would hand back the stale file
even when the device is online. `no-cache` costs one small conditional request per file.

The 30-day image rule means a changed icon can take a month to appear: give a changed image a
new file name. `/vendor/` can be cached for a year because the version is in the folder name;
an upgrade is a new folder, and files inside a version folder never change.

`no-store` on `/api/` keeps API responses out of the browser's disk cache and any shared cache.
It does not stop `sw.js` from copying them into Cache Storage, which ignores `Cache-Control`
(threat model TM-WEB-04): `sw.js` must skip `/api/` entirely.

## pdf.js

pdf.js 4.10.38 (legacy build, for older iPad Safari) is self-hosted in
`electrical-app/vendor/pdfjs-4.10.38/`, taken from the npm package `pdfjs-dist@4.10.38` (npm
checks the package integrity on download). `js/canvas/editor.js` (`loadPdfJs()`) imports
`pdf.min.mjs` as a module and points `workerSrc` at `pdf.worker.min.mjs` in the same folder.

- `script-src` and `connect-src` are `'self'` only; no CDN is allowed.
- `getDocument()` is called with `isEvalSupported: false`, so pdf.js never tries
  `new Function` for font outlines. 4.2.67 and later also fix CVE-2024-4367.
- The folder name carries the version because `/vendor/` is cached for a year. To upgrade, add a
  new `vendor/pdfjs-<version>/` folder, update `PDFJS` in `editor.js`, test with real plan PDFs
  (including scanned ones), then delete the old folder. If a future version needs WebAssembly,
  decide between `'wasm-unsafe-eval'` in `script-src` and its non-WebAssembly fallback.
- `.github/scripts/check-csp.mjs` skips `vendor/`: its line patterns can't judge minified
  third-party code. Vendored code is reviewed when it is added or upgraded.
- The worker is same-origin now, so `blob:` in `worker-src` is no longer needed for pdf.js.
  It stays until a test pass confirms nothing else creates `blob:` workers.

## Extending the CSP

Any new origin goes into both header files in the same commit, with a security note in the PR.
Install the new headers on each host before or together with the code that needs them.

### Stripe

First choice: Stripe Checkout or Stripe's hosted invoice page. The customer is redirected to
Stripe and back; no CSP change, card data never touches our pages, and the PWA keeps its
strict policy.

If Stripe Elements or Stripe.js must run in our pages (Stripe.js has to be loaded from
`js.stripe.com`; it can't be self-hosted):

| directive | add |
| --- | --- |
| `script-src` | `https://js.stripe.com` |
| `frame-src` | `https://js.stripe.com https://hooks.stripe.com` (replacing `'none'`) |
| `connect-src` | `https://api.stripe.com` |

Wallets (Apple Pay, Google Pay) may also need the Permissions-Policy `payment` feature allowed
for Stripe's frame. Check Stripe's current CSP guidance when building. Better still, serve the
payment page from its own path with its own header snippet so the rest of the app doesn't trust
`js.stripe.com`. Because of the inheritance trap, that location must include a complete second
snippet (for example `fishtape-headers-pay.conf`), and `check-csp.mjs` must be taught about it.

### Google and Microsoft sign-in

Use the redirect flow: the browser goes to Google or Microsoft and comes back to
`/api/v1/auth/oidc/<provider>/callback`. Top-level navigation isn't limited by this CSP, so
nothing changes. Two cautions:

- Start the flow with a link or `location.assign(...)`, not a form POST: some browsers apply
  `form-action` to redirects that follow a form submission, so a POST that redirects to Google
  can be blocked.
- Don't use Google's JavaScript sign-in button or One Tap, or MSAL popups. They need script,
  frame and connect entries for Google or Microsoft, and popups don't work with
  `Cross-Origin-Opener-Policy: same-origin`.

## Trusted Types (later)

`require-trusted-types-for 'script'` makes the browser refuse plain strings at DOM sinks such as
`innerHTML` unless they come from a named policy. It would turn the "don't pass data to
`innerHTML`" rule into something the browser enforces.

- Blocker today: `icons.js` sets `svg.innerHTML`. Build icons with `createElementNS` from a parsed
  list, or add one policy (`trusted-types fishtape-icons`) that only returns values from `ICONS`.
  Check pdf.js too.
- Roll out as `Content-Security-Policy-Report-Only` first and watch the console.
- Chromium browsers enforce Trusted Types; check WebKit (the iPads) and Firefox before relying on
  it. Until every target browser enforces it, it is defence in depth only.

## HSTS preload for fishtapehq.com

Today HSTS with `includeSubDomains` is sent by `app.`, `hq.` and `status.fishtapehq.com`. It covers
those hosts and their own subdomains, not the rest of the domain. There is no `preload`.

The preload list (hstspreload.org) requires:

- a valid certificate;
- HTTP redirecting to HTTPS on the same host;
- every subdomain served over HTTPS, including `www` if it exists in DNS;
- the apex `fishtapehq.com` sending, over HTTPS,
  `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` (one year or more),
  including on a redirect if the apex redirects.

Before submitting:

- give the apex and `www` an HTTPS site or redirect with that header (today nginx covers only
  `app`, `hq` and `status`);
- make sure every subdomain, now and later, can serve HTTPS, including ones run by vendors (an
  external status page, a help centre, email click-tracking domains);
- run with a one-year `max-age` for a few months without trouble;
- treat it as permanent: removal from the list takes months.

The same applies to `fishtapehq.ca` once registered. Never preload `truecollarbuilt.com`: staging
shares it with other sites.

## Testing

After every deploy, and after any nginx change:

```bash
B=https://tgelectrical.truecollarbuilt.com          # or https://app.fishtapehq.com
deploy/check-exposure.sh "$B"     # sensitive paths (with traversal variants) and required headers; exits 1 on a problem

hdr() { curl -s -o /dev/null -D - "$1" | grep -iE '^(HTTP|strict-transport|content-security|permissions-policy|x-frame|x-content-type|referrer-policy|cross-origin|cache-control|server|x-powered-by)'; }
hdr "$B/"                      # every header; Cache-Control: no-cache
hdr "$B/sw.js"                 # no-cache
hdr "$B/js/app.js"             # no-cache
hdr "$B/icons/icon-180.png"    # max-age=2592000
hdr "$B/api/v1/status"         # no-store and the transport headers; no CSP from nginx
hdr "$B/no-such-file"          # 404, and still CSP and HSTS (the `always` flag)
curl -s -o /dev/null -w '%{http_code}\n' https://app.fishtapehq.com/api/hq/health    # 404
```

Also:

- Unknown host on production: `curl -sk --resolve example.invalid:443:<server ip> https://example.invalid/`
  must fail the TLS handshake.
- TLS: `testssl.sh` against each host (TLS 1.2 and 1.3 only, strong ciphers).
- Browser: open the app with the developer console open; visit the dashboard, drawings (import a
  PDF plan), calculators and settings. There should be no CSP errors except, until
  `isEvalSupported: false` is set, one from pdf.js's `eval` check.
- Outside view: run securityheaders.com or Mozilla's HTTP Observatory against staging and
  production. Expected remarks: no HSTS preload, and `'unsafe-hashes'` in `style-src-attr`.
- CI: `check-csp.mjs` on every push and PR; the deploy workflows run `check-exposure.sh` after
  each deploy.
- Trying a stricter policy: send it as `Content-Security-Policy-Report-Only` next to the enforced
  one on staging, browse the app, and read the console.

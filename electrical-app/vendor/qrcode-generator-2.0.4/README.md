# qrcode-generator 2.0.4 (vendored)

Kazuhiko Arase's **qrcode-generator**, the ES-module build, vendored so the app can
draw a QR code for a panel entirely offline. No build step, no network, no `eval`
and no `new Function` — a pure encoder that exposes `getModuleCount()` and
`isDark(row, col)` so we rasterise the matrix into our own inline `<svg>` of plain
`<rect>` elements (see `electrical-app/js/lib/qr.js`). Nothing here touches the DOM,
`document` or the network at import time, which keeps it inside the app's strict CSP
(`script-src 'self'`, no `'unsafe-eval'`, no external origins).

- **Upstream:** https://github.com/kazuhikoarase/qrcode-generator
- **Package:** https://www.npmjs.com/package/qrcode-generator
- **Version:** 2.0.4 (pinned)
- **Licence:** MIT — see `LICENSE`.

## What is here

- `qrcode.mjs` — copied verbatim from the published npm tarball
  (`qrcode-generator@2.0.4`, `dist/qrcode.mjs`). **No modifications.** It already ships
  as an ES module (`export const qrcode`, `export default qrcode`).
- `LICENSE` — the MIT licence as stated in the file header.

The base build encodes Latin-1 / ASCII, which is all a panel deep-link URL needs
(panel ids are constrained to `[A-Za-z0-9._:-]`). We do not use the SJIS/UTF-8
variants or the library's own `createSvgTag` / `createImgTag` helpers (those emit
inline `style="…"` attributes that the CSP blocks); we read the module matrix and
build the SVG ourselves.

## Updating

Pull a new pinned version from the npm tarball, replace `qrcode.mjs` verbatim, bump
the directory name and the version above, re-check for `eval`/`new Function`, then
re-run `node tools/gen-precache.mjs` so the service worker precaches the new path.

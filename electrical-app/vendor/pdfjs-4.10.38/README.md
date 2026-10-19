# pdf.js (vendored)

Mozilla pdf.js 4.10.38, legacy build (supports older iPad Safari), from the npm
package `pdfjs-dist@4.10.38` (`legacy/build/`). Licence: Apache-2.0 (`LICENSE`).

Self-hosted so the CSP can stay `script-src 'self'`, PDFs open offline, and the
version is pinned. 4.2.67+ fixes CVE-2024-4367; the app also passes
`isEvalSupported: false`. To update: `npm pack pdfjs-dist@<version>`, copy the
same two files from `legacy/build/` into a new `vendor/pdfjs-<version>/` (the folder is cached for a
year, so the version must be in its name) and update `PDFJS` in `js/canvas/editor.js`.

# Intuit artwork (not in the repo yet)

The QuickBooks screens should use Intuit's official **"Connect to QuickBooks"** button
(docs/integrations/quickbooks.md section 8). Intuit's artwork is licensed only to apps under the
Intuit Developer Terms and its branding guidelines, so no Intuit file is committed here and nothing
in Fishtape draws or imitates it. Until the file is added, the PWA shows a plain Fishtape button that
reads "Connect to QuickBooks" (and "Reconnect to QuickBooks").

## What Kelvin does

1. Sign in at https://developer.intuit.com with the Fishtape developer account.
2. Download the "Connect to QuickBooks" button set from Intuit's branding / app-development
   guidelines page (green button, default and hover states). Use the files unaltered: no recolouring,
   cropping or scaling beyond Intuit's sizes.
3. Read the licence terms that come with the files and record them below (what is allowed, the date,
   the page URL). If the terms need a written attribution, check that the trademark line in
   `js/lib/qbo-ui.js` (`TRADEMARK`) and `guides/quickbooks.md` matches the wording Intuit asks for
   (contract 11.4 item 21).
4. Put the file here, for example `img/intuit/C2QB_green_btn_med_default.svg`, and set
   `CONNECT_BUTTON_ASSET` in `electrical-app/js/lib/qbo-ui.js` to that path. The button is then
   shown at its intrinsic size; the service worker caches it like any other file.
5. Keep Fishtape's own name larger than any Intuit mark on the same screen.

## Licence terms

Not recorded yet (no Intuit file in this folder).

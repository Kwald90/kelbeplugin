# Landing page and promotions

The public landing page is `site/index.html`: a video hero, a short value section, feature
highlights, a pricing teaser (from `electrical-app/js/plans.js`), an Enterprise "Let's talk" link and
a footer with the status page. The hero's text, buttons and clips are a **promotion**, managed in
**HQ → Promotions** and served by the API. How to make the clips: [hero-video-prompts.md](hero-video-prompts.md).

| file | what |
| --- | --- |
| `site/index.html`, `site/landing.js` | the page; fetches the live promotion, renders the pricing teaser |
| `site/hero.js`, `site/hero.css` | the player (also used by the HQ preview) |
| `site/app-link.js` | where "Sign in" goes: `https://app.fishtapehq.com/` from `fishtapehq.com`/`www.`, else `/` (a `<meta name="fishtape-app">` overrides) |
| `site/img/hero/default-*.svg` | posters of the built-in promotion |
| `site/img/shots/*.{webp,jpg}` | real screenshots of the app in demo mode (see below) |
| `hq/js/pages/promotions.js`, `hq/promotions.css` | HQ → Promotions |
| `server/src/routes/promotions.js`, `server/src/services/promotions.js` | API |
| `server/migrations/0025_promotions.sql`, `0026_hq_media.sql` | tables |

## The rest of the site

Every page shares one header (Features, Pricing, Services, About, Status, Sign in, Start free
trial; a `<details>` menu on phones) and one footer, plus a canonical URL on fishtapehq.com,
Open Graph and Twitter tags and the card image `site/img/og/fishtape-og.png`.

| URL (production) | file | what |
| --- | --- | --- |
| `/` | `index.html` | the landing page above |
| `/features`, `/features/<slug>` | `features/*.html` | overview grid and one page per feature (14) |
| `/for/<slug>` | `for/*.html` | residential, commercial and industrial, solo; Ontario, BC, Alberta, Saskatchewan, Manitoba, Atlantic Canada; switching from Jobber, Housecall Pro, QuickBooks |
| `/services` | `services.html` | setup, data import, price book, training, templates, Enterprise; each "Talk to us" posts to `/api/v1/public/enterprise-leads` with a `service` (HQ → Leads shows it) |
| `/about` | `about.html` | why Fishtape exists, principles, contact form (`service: contact`) |
| `/pricing`, `/signup`, `/status`, `/terms`, `/privacy` | hand-written pages | the status page is in [docs/runbooks/status-page.md](../runbooks/status-page.md) |
| `/sitemap.xml`, `/robots.txt` | generated | robots allows the site, disallows `/api/` and `/hq/` |

**Generated, then committed.** `node tools/site/build.mjs` writes the feature, landing, services
and about pages from `tools/site/{features,landing,pages}.mjs`, fills the `<!-- @site:NAME -->`
blocks in the hand-written pages (head metadata, header, footer, the "No caps on your work" section,
the home page screenshots, the pricing cards and feature table), and writes the sitemap and robots.
`--check` fails when anything is out of date; `electrical-app/tests/site-pages.test.mjs` runs it.
So: edit the copy in `tools/site/`, run the build, commit both. Which plan includes a feature is
read from `electrical-app/js/plans.js` at build time and again in the browser (`site/site.js`);
province facts (code in force, inspection authority, amendments, sales tax, WCB) from the app's
`js/lib/cec/provinces.js`, `amendments.js`, `js/lib/tax.js` and `js/lib/safety-reporting.js`.

**Links.** The HTML links to the clean production URLs. Staging serves the same files under
`/site/` (`/site/about.html`, `/site/features/wire-runs.html`); `site/site.js` rewrites the links
there on any host that isn't a marketing host (`site/site-lib.js` `localHref`). On
`status.fishtapehq.com` the other pages link to the apex. Production nginx 301s old
`/site/<page>.html` addresses to the clean URL.

**Preview and check locally.**

    node tools/site/serve.mjs --mock-api      # http://localhost:8090, production routing and CSP
    node tools/site/crawl.mjs                 # Chrome at 1280 and 390 px: every page and link

The crawl fails on sideways scroll, console errors (CSP included), failed requests, layout shift
over 0.05, images without sizes or much larger than shown, and checks the phone menu, the services
form and the status page. `node tools/site/og-image.mjs` redraws the card image.

**Copy rules.** en-CA, plain trade language, only what is built; pending things say "coming"
(App Store listing, live QuickBooks sync, logo on documents). No testimonials, customer counts,
ratings, awards, partner logos or "trusted by"; the site test refuses the obvious ones. Service
prices say "Quoted per job" until Kelvin sets them.

## How promotions work

A promotion has a name (HQ only), a status (draft, active, inactive), an optional window
(`startsAt`/`endsAt`), a priority, an optional audience tag, the overlay (eyebrow, headline,
sub-line, fine print, main button, optional second button), timing, internal notes, and **3 to 5
slides**. Each slide has a desktop video (16:9 MP4), a phone video (9:16 or 4:5 MP4), a poster,
optionally a phone poster and WebM versions, and optional text that replaces the promotion's text
on that slide (blank = use the promotion's).

`GET /api/v1/public/promotions/active` returns **one** promotion:

1. only `active` ones inside their window (`startsAt <= now < endsAt`; blank = open-ended);
2. an audience-tagged one only for visitors carrying that tag;
3. highest priority wins; on a tie a targeted one beats a general one, then the latest start,
   then the latest edit.

With nothing live (or the database unreachable) it returns the **built-in default**: "Built for
Canadian electricians", "Start your 14-day free trial" (to `/site/signup.html?plan=pro`), the
"$1 deposit, credited to your first month" note and three poster-only slides. If the API can't be
reached at all the page shows the same default (`FALLBACK_PROMOTION` in `site/hero.js`; a test
keeps it identical to the server's).

The public answer holds only `id`, `overlay`, `slides` and `settings` (no name, notes, status,
priority, window, audience or authors); the app role can read only the `promotions_public` view.
It is cached in the API process for `PROMOTIONS_CACHE_S` (30 s); an HQ change in the same process
clears it, so **a saved change reaches the site within 30 seconds**. nginx sends `no-store` on all
`/api/` answers, so browsers don't keep it.

**Audience tags.** The page passes codes from its own address: `/site/?province=ON` → `province=ON`,
`?campaign=spring-show` or `?utm_campaign=spring-show` → `campaign=spring-show`. Nothing else from
the URL is sent. Use them in ad links (e.g. an Ontario campaign's final URL) and set the same tag on
the promotion. The endpoint is left out of `openapi.json` (it belongs to the website, not the
developer API), so `leaks.test.js`' query-parameter list doesn't need `audience`.

**Button links** may be a site path (`/site/signup.html?plan=business`), an `#anchor`, `mailto:`,
or https on `PUBLIC_ORIGIN` / `PROMOTION_LINK_ORIGINS`. **Media URLs** must be `/media/<upload>`,
`/site/img/...` (images shipped with the site) or https on `PROMOTION_MEDIA_ORIGINS` (no query
strings). Anything else is refused with the field named.

## The player

- Two stacked layers, ping-ponged. While a clip plays the next one preloads in the hidden layer.
  `handoverAtMs` before the end (default 1000 ms) the next clip starts playing, still invisible, and
  crossfades in on top (`transitionMs`, default 800 ms) once it is producing frames. The outgoing
  clip stays fully visible underneath until the fade ends, and holds its last frame if it ends
  first. Inside each layer the video only shows after its first frame; until then the poster shows,
  and behind everything a dark gradient. After the last slide it loops to the first.
- "Slide" instead of crossfade is a per-promotion setting.
- **Reduced motion**, **Save-Data** or a slow connection (`effectiveType` 3g or slower), or a browser
  that blocks muted autoplay: posters only, a slow (1.6 s) crossfade every 8 s or more. No video
  bytes are downloaded.
- Pauses while the tab is hidden, while the hero is off-screen, and while a button in the text has
  keyboard focus. A pause button (labelled "Pause background video" / "Play background video")
  and dots (one per slide, with progress, arrow keys move between them) are keyboard accessible.
- Phones in portrait (≤ 900 px wide) get the phone cut and poster when there is one; the choice is
  made per clip, so rotating takes effect on the next one.
- Text sits on a scrim that is at least 76 % near-black under every line (on wide screens the
  gradient follows the centred text column). Worst case, a pure white frame, white text is 9.5:1
  and the yellow eyebrow 5.1:1 (WCAG AA).
- The headline from the HTML shows if JavaScript doesn't run; with JavaScript the text fades in
  once the promotion is known (at most 1.5 s), so a promotion never flashes the default first.
- No layout shift: the hero's height comes from the viewport, images below the fold are lazy with
  dimensions, the pricing teaser reserves its height. CSP-clean: no inline scripts or styles; JS
  styles go through CSSOM.

## Video and poster specs

| | |
| --- | --- |
| Format | H.264 MP4 (High or Main profile, yuv420p, `+faststart`), optional WebM (VP9) alongside |
| Size | 1920×1080 desktop, 1080×1920 phone (1080×1350 4:5 also works) |
| Length | 6–10 s per clip, 3–5 clips |
| Bit rate | at most 8 Mbps (a 10 s clip ≈ 10 MB) |
| Audio | none (strip the track) |
| Frames | the last second slow and calm; the first frame of clip N+1 close to the last of clip N so the crossfade reads as one shot |
| Text | none baked in; the left third (desktop) or top third (phone) calm and darker |
| Poster | JPG or WebP, the clip's **first frame**, same size, ≤ 300 KB |

Export example with ffmpeg:

    ffmpeg -i in.mov -an -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 21 -maxrate 8M -bufsize 16M \
      -vf "scale=1920:1080,fps=30" -movflags +faststart clip-1.mp4
    ffmpeg -i clip-1.mp4 -frames:v 1 -q:v 3 clip-1.jpg
    ffmpeg -i in.mov -an -c:v libvpx-vp9 -b:v 0 -crf 33 -row-mt 1 -vf scale=1920:1080 clip-1.webm   # optional

## Making or changing a promotion (HQ)

1. HQ → **Promotions** (HQ admins only) → **Upload videos or posters**. Pick all the MP4s and
   posters at once. Files are checked by their bytes (MP4, WebM, JPG, PNG, WebP only), capped
   (150 MB per video, 15 MB per image; on staging the proxy caps any upload at 72 MB) and stored
   under random names. Each upload is audited.
2. **New promotion** starts from the built-in default. Fill in the text and buttons, then for
   each slide pick the uploads in the desktop video, phone video and poster fields (they suggest
   uploaded files). The preview on the right is the real player, desktop and phone, and follows
   your typing.
3. Set **Status: Active**, and a start and end if it should run on a schedule. Leave the audience
   blank for everyone. Save. It is live within 30 seconds, or at its start time.
4. To stop it: **Deactivate** (list or editor). **Duplicate** copies it as a draft for the next
   campaign. Media still used by a draft or active promotion can't be deleted.

Every create, update, status change, duplicate, delete, upload and media delete writes an audit
event on the platform chain (no copy text in the summary).

## Screenshots

`site/img/shots/` holds real captures of the app (17 screens), taken with headless Chrome at iPad
landscape size (1366×1024; `phone-my-day` at iPhone size, 390×844 @2x) from a fresh demo
("Try the demo on this device", metric) plus what a person enters through the UI: a floor plan
built with the Room tool and Auto-place, a wire run, tasks, an FLHA, clock-ins. `integrations`,
`assistant` and `hq-dashboard` come from the API on an embedded database with the server's own seed
accounts. No customer data beyond the demo seed.

Each screen is four files: `<name>.webp` and `.jpg` (full size, WebP ≤ 75 KB) and `<name>-sm.webp`
and `-sm.jpg` (half size, for cards). Pages use them through `shotImg()` in `tools/site/lib.mjs`
(`<picture>`, WebP first, sizes and `srcset`); the build fails if a file is missing.

| name | shows |
| --- | --- |
| `plan-canvas`, `cec-check` | a floor plan with boxes placed and the takeoff; the same plan after the CEC check |
| `wire-runs`, `bending`, `calculators` | a wire run with allowances; an EMT offset; conductor sizing with rule references |
| `estimate`, `invoice` | Ontario HST estimate; a progress invoice with a payment recorded |
| `my-day`, `phone-my-day`, `work-plan`, `time-clock` | the crew's day, the planner, the clock |
| `safety-flha`, `leads`, `integrations`, `assistant`, `security`, `hq-dashboard` | the rest |

Retake them after a visible UI change, keep the names, then run `node tools/site/build.mjs`.

## Environment

| variable | where | default | what |
| --- | --- | --- | --- |
| `MEDIA_DIR` | hq-api | unset = uploads off | absolute path for uploads; refused if inside the code checkout |
| `MEDIA_MAX_VIDEO_MB` | hq-api | 150 | per video |
| `MEDIA_MAX_IMAGE_MB` | hq-api | 15 | per poster |
| `PROMOTION_MEDIA_ORIGINS` | api, hq-api | none | extra https origins for media (a CDN); also add them to the CSP `media-src`/`img-src` in both header files |
| `PROMOTION_LINK_ORIGINS` | hq-api | none | extra https origins buttons may link to |
| `PROMOTIONS_CACHE_S` | api | 30 | public cache, seconds |

## Deploying (for the platform workstream)

**Staging** (`deploy/staging/`, not changed here except the nginx location):

- Host folder: `sudo install -d -o 1000 -g 1000 -m 0755 /var/lib/fishtape-staging/media`
  (1000 = the image's `node` user).
- `docker-compose.yml`, service `hq-api` only: `MEDIA_DIR: /media` in `environment`, and a volume
  `- /var/lib/fishtape-staging/media:/media:rw` (the container stays `read_only`).
- nginx: the `location ^~ /media/` block now in `nginx-api.conf.snippet` (root
  `/var/lib/fishtape-staging`, only `<32 hex>.(mp4|webm|jpg|png|webp)`, everything else 404,
  `expires 1y`). Edit the live vhost the usual way: back up, `nginx -t`, reload.
- Uploads over 72 MB need `client_max_body_size` raised for `/api/hq/media` (a dedicated
  location with `proxy_request_buffering off`); the proxy include sets 72m, so it can't simply be
  overridden in the same block.
- `location = /site/` still redirects to `pricing.html`; point it at `index.html` once the landing
  page should be the entry.
- `deploy/check-exposure.sh` could add: `/media/` (404, no listing), `/media/x.php` (404),
  `/media/../` (404).

**Production**: the marketing site is the apex `fishtapehq.com` (serve `site/` there with `/`
→ `site/index.html`, plus `/css/tokens.css`, `/js/plans.js`, `/js/brand.js`, `/icons/` from the app
build), the app `app.fishtapehq.com`, HQ `hq.fishtapehq.com`. `/media/` with the same rules from
`/var/lib/fishtape-production/media`, mounted into hq-api as `MEDIA_DIR`. The landing page calls
`/api/v1/public/promotions/active` on its own host: either proxy that one path to the API on the
apex, or set `<meta name="fishtape-api" content="https://app.fishtapehq.com">` and add
`https://fishtapehq.com` to `CORS_ORIGINS` and to the CSP `connect-src`. Media uploaded in HQ
(`hq.`) must be served on the host the landing page loads them from: the URLs are `/media/...`
(same origin), so the apex needs the `/media/` location too.

## Tests

- `node --test electrical-app/tests/site-hero.test.mjs`: scheduling (handover timing, wrap-around,
  modes, source choice, overlay merge, link checks, app links) and the fallback = server default.
- `cd server && npm run test:embedded` (`test/promotions.test.js`): public default, active window,
  audience, no internal fields, caching headers, admin-only access, validation, audit, uploads by
  magic bytes, size caps, traversal refused, uploads off without a safe `MEDIA_DIR`.
- `node electrical-app/tests/e2e/landing.e2e.mjs [scratch dir]` (needs ffmpeg and Chrome): makes
  three 3-second clips, signs in to HQ, uploads, creates a promotion with the live preview, then
  samples every composited frame (Page.startScreencast, ~35 fps) across four handovers and the
  loop and fails on any frame that isn't one clip or a mix of two neighbours; also pause, dots
  and arrow keys, off-screen pause, reduced motion, Save-Data, an HQ edit reaching the page, a
  390 px phone, the other site pages, and a clean console under the real CSP.
- `node --test electrical-app/tests/site-pages.test.mjs`: clean-URL mapping, plan labels from plans.js,
  status page helpers, the generated site up to date, one h1, canonical and Open Graph tags, no inline
  style or script, every internal link and image resolves, the no-caps section, honesty rules.
- `node tools/site/crawl.mjs`: every page in Chrome at 1280 and 390 px (see "The rest of the site").

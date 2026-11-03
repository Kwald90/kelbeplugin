// Published marketing piece, rendered from the HQ block model (services/marketing.js). The slug
// picks the piece (?slug=catalog by default); a tracked ?code= carries through to the trial link
// and sets the accent/partner from the piece's co-brand. No inline styles or handlers (CSP): the
// accent is set through the CSSOM (element.style), which CSP style-src does not govern.
const API = document.querySelector('meta[name="fishtape-api"]')?.content.replace(/\/$/, '') || '';
const params = new URLSearchParams(location.search);
const SLUG = (() => { const s = (params.get('slug') || 'catalog').toLowerCase(); return /^[a-z0-9][a-z0-9-]{0,62}$/.test(s) ? s : 'catalog'; })();
const CODE = (() => { const c = (params.get('code') || '').toLowerCase(); return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(c) ? c : ''; })();
const host = document.getElementById('piece');

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

const trialHref = () => `/site/signup.html${CODE ? `?code=${encodeURIComponent(CODE)}` : ''}`;

function renderCover(s, cobrand) {
  return el('section', { class: 'mk-cover' },
    cobrand.partner ? el('p', { class: 'mk-partner' }, `In partnership with ${cobrand.partner}`) : null,
    el('h1', {}, s.title || 'Fishtape'),
    s.subtitle ? el('p', { class: 'mk-sub' }, s.subtitle) : null,
    cobrand.tagline ? el('p', { class: 'mk-tagline' }, cobrand.tagline) : null,
    el('a', { class: 'mk-cta', href: trialHref() }, 'Start your free trial'),
    s.footnote ? el('p', { class: 'mk-foot' }, s.footnote) : null);
}

function renderFeatures(s) {
  return el('section', { class: 'mk-section' },
    s.heading ? el('h2', {}, s.heading) : null,
    s.intro ? el('p', { class: 'mk-intro' }, s.intro) : null,
    s.cards?.length
      ? el('div', { class: 'mk-grid' }, s.cards.map((c) => el('div', { class: 'mk-card' },
        el('h3', {}, c.title), c.body ? el('p', {}, c.body) : null)))
      : null);
}

function renderCta(s) {
  return el('section', { class: 'mk-section mk-cta-block' },
    s.heading ? el('h2', {}, s.heading) : null,
    s.body ? el('p', { class: 'mk-intro' }, s.body) : null,
    el('a', { class: 'mk-cta', href: trialHref() }, 'Start your free trial'),
    s.footnote ? el('p', { class: 'mk-foot' }, s.footnote) : null);
}

function render(piece) {
  const cobrand = piece.cobrand || {};
  if (piece.title) document.title = cobrand.enabled && cobrand.partner ? `${piece.title} · ${cobrand.partner}` : piece.title;
  if (cobrand.enabled && /^#[0-9a-f]{6}$/.test(cobrand.accent || '')) {
    // CSSOM write, not a style attribute — allowed under style-src 'self'.
    document.documentElement.style.setProperty('--mk-accent', cobrand.accent);
  }
  const sections = (piece.content?.sections || []).map((s) => {
    if (s.kind === 'cover') return renderCover(s, cobrand.enabled ? cobrand : {});
    if (s.kind === 'cta') return renderCta(s);
    return renderFeatures(s);
  }).filter(Boolean);
  host.replaceChildren(...(sections.length ? sections : [el('p', { class: 'mk-loading' }, 'This page is empty.')]));
}

fetch(`${API}/api/v1/public/marketing/${encodeURIComponent(SLUG)}`, { credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' } })
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => {
    if (!d?.piece) { host.replaceChildren(el('p', { class: 'mk-loading' }, 'This page isn’t available.')); return; }
    render(d.piece);
  })
  .catch(() => { host.replaceChildren(el('p', { class: 'mk-loading' }, 'Could not load this page. Check your connection.')); });

// Page bodies for the generated pages. Each returns { path, file, title, description, body, ... }
// for lib.pageHtml().
import { html, raw, shotFigure, shotImg, planBadge, planList, limitsSection, ctaBand, faq, TRIAL_HREF, plans } from './lib.mjs';
import { FEATURES, MORE, bySlug } from './features.mjs';
import { LANDING } from './landing.mjs';
import { planLabel, planPrice } from '../../site/site-lib.js';

const ctas = (primary = ['Start free trial', TRIAL_HREF], secondary = ['See pricing', '/pricing']) =>
  html`<div class="mk-ctas"><a class="site-btn big" href="${primary[1]}">${primary[0]}</a> <a class="site-btn ghost big" href="${secondary[1]}">${secondary[0]}</a></div>`;

const relatedLinks = (slugs) => html`<ul class="mk-links">${slugs.map((s) => html`<li><a href="/features/${s}">${bySlug[s].name}</a></li>`)}</ul>`;

function card(f, sizes = '(min-width: 1120px) 350px, (min-width: 700px) 45vw, 100vw') {
  const shot = f.shot || f.phoneShot;
  return html`<li class="mk-card"><a href="/features/${f.slug}">${shotImg(shot[0], shot[1], { sizes })}<div class="mk-card-body"><h3>${f.name}</h3><p>${f.card}</p><p class="mk-tag" data-plan-feature="${f.plan}">${planLabel(f.plan, plans)}</p></div></a></li>`;
}

// ---- /features/<slug> ------------------------------------------------------------------------

export function featurePage(f) {
  const heroShot = f.phoneShot
    ? shotFigure(f.phoneShot[0], f.phoneShot[1], null, { eager: true, phone: true, sizes: '(min-width: 900px) 320px, 80vw' })
    : shotFigure(f.shot[0], f.shot[1], null, { eager: true, sizes: '(min-width: 1120px) 590px, (min-width: 900px) 52vw, 100vw' });
  const body = html`
<p class="mk-crumbs"><a href="/features">Features</a> / ${f.name}</p>
<section class="mk-hero ${f.phoneShot ? 'has-phone' : 'has-shot'}" aria-labelledby="page-title">
  <div class="mk-hero-copy">
    <p class="mk-eyebrow">${f.eyebrow}</p>
    <h1 id="page-title">${f.h1}</h1>
    <p class="mk-lede">${f.lede}</p>
    ${planBadge(f.plan)}
    ${ctas()}
  </div>
  ${heroShot}
</section>

<div class="site-section mk-cols">
  <section class="mk-block" aria-labelledby="what-title">
    <h2 id="what-title">What it does</h2>
    <ul class="mk-list">${f.what.map(([t, d]) => html`<li><strong>${t}</strong>${d}</li>`)}</ul>
  </section>
  <section class="mk-block" aria-labelledby="site-title">
    <h2 id="site-title">How it works on site</h2>
    <ol class="mk-steps">${f.steps.map((s) => html`<li>${s}</li>`)}</ol>
  </section>
</div>
${f.more ? html`
<section class="site-section" aria-label="More screenshots">
  <div class="mk-shots">${f.more.map(([name, alt, cap]) => shotFigure(name, alt, cap))}</div>
</section>` : ''}
<section class="site-section" aria-labelledby="plans-title">
  <div class="site-section-head"><h2 id="plans-title">Which plan includes it</h2><p>Every plan has no caps on invoices, estimates, jobs, clients or drawings. Plans differ by features and included users.</p></div>
  ${planList(f.plans)}
  <p class="mk-note"><strong>Good to know.</strong> ${f.notes}</p>
</section>
${ctaBand()}
<section class="site-section" aria-labelledby="related-title">
  <h2 id="related-title">Related features</h2>
  ${relatedLinks(f.related)}
</section>`;
  return { path: `/features/${f.slug}`, file: `features/${f.slug}.html`, title: f.title, description: f.description, body };
}

// ---- /features ---------------------------------------------------------------------------------

export function featuresIndex() {
  const body = html`
<section class="mk-hero" aria-labelledby="page-title">
  <div class="mk-hero-copy">
    <p class="mk-eyebrow">Features</p>
    <h1 id="page-title">Everything an electrical contractor runs on, in one app</h1>
    <p class="mk-lede">From the plan set to the final invoice, built around the Canadian Electrical Code and Canadian tax, and made to work on the iPad on site with no signal.</p>
    ${ctas()}
  </div>
</section>

<section aria-labelledby="field-title">
  <div class="site-section-head"><h2 id="field-title">Field and office, one app</h2><p>Each one has its own page with screenshots, how it works on site and which plan includes it.</p></div>
  <ul class="mk-grid">${FEATURES.map((f) => card(f))}</ul>
</section>

<section class="site-section" aria-labelledby="more-title">
  <div class="site-section-head"><h2 id="more-title">Also in the app</h2></div>
  <ul class="mk-plans">${MORE.map(([t, d, feature]) => html`<li><span><strong>${t}.</strong> ${d}</span><span data-plan-feature="${feature}">${planLabel(feature, plans)}</span></li>`)}</ul>
</section>

${limitsSection()}
${ctaBand()}`;
  return {
    path: '/features', file: 'features/index.html',
    title: 'Features · Fishtape, software for Canadian electrical contractors',
    description: 'Plans and takeoff, box auto-placement with CEC checks, AR wire runs, pipe bending, CEC calculators, estimates and invoices with Canadian tax, work plans, safety, time clock, CRM and AI.',
    body,
  };
}

// ---- /for/<slug> -------------------------------------------------------------------------------

function featureCards(slugs) {
  return html`<ul class="mk-grid">${slugs.map((s) => card(bySlug[s]))}</ul>`;
}

function audienceBody(p) {
  return html`
<section class="mk-hero has-shot" aria-labelledby="page-title">
  <div class="mk-hero-copy">
    <p class="mk-eyebrow">${p.eyebrow}</p>
    <h1 id="page-title">${p.h1}</h1>
    <p class="mk-lede">${p.lede}</p>
    ${p.starter ? html`<p class="mk-plan">Starter: <span data-plan-price="starter">${planPrice('starter', plans)}</span> with <span data-plan-users="starter">${plans.PLANS.starter.includedUsers} users</span> included <a href="/pricing">See pricing</a></p>` : ''}
    ${ctas()}
  </div>
  ${shotFigure(p.shot[0], p.shot[1], null, { eager: true, sizes: '(min-width: 1120px) 590px, (min-width: 900px) 52vw, 100vw' })}
</section>

<section class="site-section" aria-labelledby="why-title">
  <div class="site-section-head"><h2 id="why-title">What you get</h2></div>
  <ul class="mk-principles">${p.points.map(([t, d, href]) => html`<li><h3><a href="${href}">${t}</a></h3><p>${d}</p></li>`)}</ul>
</section>

<section class="site-section" aria-labelledby="feat-title">
  <div class="site-section-head"><h2 id="feat-title">The tools you'll use most</h2></div>
  ${featureCards(p.features)}
</section>
${limitsSection()}
${ctaBand()}`;
}

function provinceBody(p) {
  const single = p.facts.length === 1;
  const factList = (f) => html`<dl class="mk-facts">
  <div class="mk-fact"><dt>Electrical code</dt><dd>${f.edition}, in force since ${f.effective}<small>${f.codeInForce}</small></dd></div>
  <div class="mk-fact"><dt>Permits and inspections</dt><dd><a href="${f.authority.url}" rel="noopener">${f.authority.name}</a>${f.permitNote ? html`<small>${f.permitNote}</small>` : ''}</dd></div>
  <div class="mk-fact"><dt>Sales tax on your invoices</dt><dd>${f.tax}<small>Default: ${f.taxTreatment}. ${f.taxHint}</small></dd></div>
  ${f.wcb ? html`<div class="mk-fact"><dt>Injury reports</dt><dd>${f.wcb.name}, ${f.wcb.form}<small>${f.wcb.deadline}. Safety lists what to report to ${f.regulator} and when.</small></dd></div>` : ''}
</dl>`;
  const amendments = p.facts.flatMap((f) => f.amendments.map((a) => ({ ...a, prov: f.name })));
  return html`
<section class="mk-hero has-shot" aria-labelledby="page-title">
  <div class="mk-hero-copy">
    <p class="mk-eyebrow">${p.eyebrow}</p>
    <h1 id="page-title">${p.h1}</h1>
    <p class="mk-lede">${p.lede}</p>
    ${ctas()}
  </div>
  ${shotFigure(p.shot[0], p.shot[1], null, { eager: true, sizes: '(min-width: 1120px) 590px, (min-width: 900px) 52vw, 100vw' })}
</section>

<section class="site-section" aria-labelledby="facts-title">
  <div class="site-section-head"><h2 id="facts-title">${single ? `${p.facts[0].name}, set up for you` : 'Each province, set up for you'}</h2><p>Pick your province when you sign up and Fishtape sets the code book, permit authority, tax and safety reporting to match. These facts come from the same data the app uses.</p></div>
  ${single ? factList(p.facts[0]) : p.facts.map((f) => html`<h3>${f.name}</h3>${factList(f)}`)}
</section>

${amendments.length ? html`
<section class="site-section" aria-labelledby="amend-title">
  <div class="site-section-head"><h2 id="amend-title">Provincial amendments in the app</h2><p>${p.extra} Our own one-line summaries; the code book and your inspector decide.</p></div>
  <ul class="mk-plans">${amendments.map((a) => html`<li><span><strong>${p.facts.length > 1 ? `${a.prov}, ` : ''}Rule ${a.rule}.</strong> ${a.summary}</span></li>`)}</ul>
</section>` : html`
<section class="site-section"><p class="mk-note"><strong>Amendments.</strong> ${p.extra}</p></section>`}

<section class="site-section" aria-labelledby="feat-title">
  <div class="site-section-head"><h2 id="feat-title">Built for the way you work</h2></div>
  ${featureCards(['cec-calculators', 'box-placement', 'estimating-invoicing', 'safety'])}
</section>
${limitsSection()}
${ctaBand({ title: `Try Fishtape in ${p.name}` })}`;
}

function switchingBody(p) {
  return html`
<section class="mk-hero has-shot" aria-labelledby="page-title">
  <div class="mk-hero-copy">
    <p class="mk-eyebrow">${p.eyebrow}</p>
    <h1 id="page-title">${p.h1}</h1>
    <p class="mk-lede">${p.lede}</p>
    ${ctas(['Start free trial', TRIAL_HREF], ['Have us move it for you', '/services#data-import'])}
  </div>
  ${shotFigure(p.shot[0], p.shot[1], null, { eager: true, sizes: '(min-width: 1120px) 590px, (min-width: 900px) 52vw, 100vw' })}
</section>

<div class="site-section mk-cols">
  <section class="mk-block" aria-labelledby="bring-title">
    <h2 id="bring-title">What comes across</h2>
    <ul class="mk-list">${p.presets.map((t) => html`<li>${t}</li>`)}<li>Duplicates found by email, phone or name, and you choose to skip or update them. Money and dates are read the Canadian way.</li></ul>
  </section>
  <section class="mk-block" aria-labelledby="how-title">
    <h2 id="how-title">How to move</h2>
    <ol class="mk-steps">${p.exportSteps.map((s) => html`<li>${s}</li>`)}<li>In Fishtape, open Import, pick the ${p.qbo ? 'QuickBooks' : p.from} preset and drop the file in.</li><li>Check the column matches and the preview, then import. Up to 20,000 rows per file; you can undo an import on the device that ran it.</li></ol>
  </section>
</div>
${p.qbo ? html`
<section class="site-section" aria-labelledby="qbo-title">
  <div class="site-section-head"><h2 id="qbo-title">Back to QuickBooks for the books</h2><p>Fishtape writes customers, invoices and payments as files QuickBooks Online imports, with tax codes you can rename to match yours (HST ON, GST/PST BC and so on).</p></div>
  <p class="mk-note"><strong>Coming.</strong> A live QuickBooks Online connection that sends invoices and payments without files. Today it is the export, in QuickBooks' own import format.</p>
</section>` : ''}
<section class="site-section" aria-labelledby="then-title">
  <div class="site-section-head"><h2 id="then-title">Then add the electrical side</h2><p>The tools a general field-service app doesn't have.</p></div>
  ${featureCards(['plans-takeoff', 'box-placement', 'cec-calculators', 'pipe-bending'])}
</section>
<section class="site-section" aria-labelledby="faq-title">
  <h2 id="faq-title">Questions</h2>
  ${faq([
    ['Can you move the data for me?', ['Yes. Send us the export files and we bring them across and check them with you. It\'s quoted per job. See Services.']],
    ['Do I have to cancel my old software first?', ['No. Run both during your Fishtape trial, then cancel the old one when you\'re ready.']],
    ['Is there a cap on how many clients I can import?', ['No. Every plan has no caps on clients, jobs, estimates, invoices or drawings. One file holds up to 20,000 rows; split bigger lists into several files.']],
  ])}
  <p class="site-fine">${p.from} and QuickBooks are trademarks of their owners. Fishtape is not affiliated with them; the presets read the export files their own help pages describe.</p>
</section>
${ctaBand()}`;
}

export function landingPage(p) {
  const body = p.kind === 'audience' ? audienceBody(p) : p.kind === 'province' ? provinceBody(p) : switchingBody(p);
  return { path: `/for/${p.slug}`, file: `for/${p.slug}.html`, title: p.title, description: p.description, body };
}

export const landingPages = () => LANDING.map(landingPage);

// ---- /services ---------------------------------------------------------------------------------

export const SERVICES = [
  { id: 'setup-integrations', anchor: 'setup', title: 'Done-for-you setup', text: 'We connect your accounts with you on a screen share, test each one with a real payment, email or text, and show your office how it works.', items: ['Stripe: card payments on invoices, tested with a real payment and refund', 'SendGrid domain authentication, so your quotes don\'t land in spam', 'Twilio: a local number for texts, with STOP handled', 'Facebook Lead Ads: your lead forms straight into the pipeline'], price: 'Quoted per job, up front. Included with Enterprise.' },
  { id: 'data-import', anchor: 'data-import', title: 'Data import from your old software', text: 'Send us the exports from Jobber, QuickBooks Online, Housecall Pro or your spreadsheets. We bring clients, the price book, jobs and employees across and check them with you.', items: ['Clients with addresses, tags and notes', 'Your price book with costs, sell prices and labour hours', 'Open jobs and your people'], price: 'Quoted per job.' },
  { id: 'price-book', anchor: 'price-book', title: 'Price book build-out', text: 'A price book that matches how you quote: materials from your supplier\'s list, your labour units, assemblies for the things you install every week.', items: ['Materials by category with your costs and markup', 'Labour hours per device', 'Units set up so wire runs price by the foot, metre or coil'], price: 'Quoted per job.' },
  { id: 'crew-training', anchor: 'training', title: 'Crew training, remote or on site', text: 'Get the office and the crew using it the same week: the time clock and My day for the field, estimates and invoices for the office.', items: ['Remote sessions by video, recorded for new hires', 'On site at your shop (travel quoted)', 'A short guide for your own way of working'], price: 'Quoted per job.' },
  { id: 'plan-templates', anchor: 'templates', title: 'Custom plan sets and templates', text: 'Your symbols, layers, room defaults and task templates set up once, so every drawing and work plan starts the way you like it.', items: ['Symbol and layer sets for your drawings', 'Placement defaults: mounting heights, switch distance, alarms', 'Work-plan task templates and SOPs'], price: 'Quoted per job.' },
  { id: 'enterprise', anchor: 'enterprise', title: 'Enterprise', text: 'For bigger shops: as many users as you need, single sign-on, setup done for you and a contact who knows your account.', items: ['Custom user counts', 'Single sign-on', 'Setup, import and training included'], price: 'Custom pricing. Let\'s talk.' },
];

const SERVICE_LABEL = Object.fromEntries(SERVICES.map((s) => [s.id, s.title]));

export function leadForm({ id, services = true, defaultService = '', title = 'Talk to us', intro, doneId }) {
  return html`<section class="site-section site-talk" id="${id}" aria-labelledby="${id}-title">
  <div>
    <h2 id="${id}-title">${title}</h2>
    <p>${intro}</p>
    <p class="site-fine">We reply within one business day. Your details go to Fishtape's own sales list (HQ Leads) and nowhere else, and aren't added to a mailing list.</p>
  </div>
  <form class="site-form" data-lead-form data-done="${doneId}" novalidate>
    <label>Your name <input name="name" autocomplete="name" required maxlength="120"></label>
    <label>Work email <input name="email" type="email" autocomplete="email" required maxlength="254"></label>
    <label>Company <input name="company" autocomplete="organization" required maxlength="200"></label>
    <label>Phone <span class="site-muted">(optional)</span> <input name="phone" type="tel" autocomplete="tel" maxlength="40"></label>
    <label>Province
      <select name="province">
        <option value="">Choose…</option>
        ${raw(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'].map((p) => `<option>${p}</option>`).join(''))}
      </select>
    </label>
    <label>Team size
      <select name="teamSize">
        <option value="">Choose…</option><option>1-5</option><option>6-15</option><option>16-50</option><option>51-200</option><option>200+</option>
      </select>
    </label>
    ${services ? html`<label class="wide">What can we help with?
      <select name="service">
        ${SERVICES.map((s) => html`<option value="${s.id}"${raw(s.id === defaultService ? ' selected' : '')}>${s.title}</option>`)}
      </select>
    </label>` : html`<input type="hidden" name="service" value="${defaultService}">`}
    <label class="wide">Message <textarea name="message" rows="4" maxlength="4000"></textarea></label>
    <div class="site-hp" aria-hidden="true"><label>Website <input name="website" tabindex="-1" autocomplete="off"></label></div>
    <p class="site-error wide" data-error role="alert" hidden></p>
    <button class="site-btn wide" type="submit">Send</button>
  </form>
  <div id="${doneId}" class="site-done" hidden role="status" tabindex="-1">
    <h3>Thanks, we have your message.</h3>
    <p>We'll reply within one business day.</p>
  </div>
</section>`;
}

export function servicesPage() {
  const body = html`
<section class="mk-hero" aria-labelledby="page-title">
  <div class="mk-hero-copy">
    <p class="mk-eyebrow">Services</p>
    <h1 id="page-title">We'll set it up with you</h1>
    <p class="mk-lede">Fishtape is built to set up yourself, with a guide for every step. If you'd rather not spend an evening on DNS records and API keys, we'll do it with you.</p>
  </div>
</section>

<ul class="mk-services">${SERVICES.map((s) => html`<li class="mk-service" id="${s.anchor}">
  <h2>${s.title}</h2>
  <p>${s.text}</p>
  <ul>${s.items.map((i) => html`<li>${i}</li>`)}</ul>
  <p class="mk-price">${s.price}</p>
  <a class="site-btn" href="#talk" data-service-pick="${s.id}">Talk to us</a>
</li>`)}</ul>

<p class="mk-note"><strong>How pricing works.</strong> Each service is quoted per job before we start, from what you tell us in the form. Nothing is charged until you agree the quote. Setup is included with Enterprise.</p>

${leadForm({ id: 'talk', intro: 'Tell us what you need and we\'ll come back with a quote. Pick a service above or in the form.', doneId: 'talk-done', defaultService: 'setup-integrations' })}
${ctaBand({ title: 'Prefer to do it yourself?', text: 'Every integration has a step-by-step guide and a connection test in the app. Start a trial and have a look.' })}`;
  return {
    path: '/services', file: 'services.html',
    title: 'Services: setup, data import, training · Fishtape',
    description: 'Done-for-you setup of Stripe, SendGrid, Twilio and Facebook Lead Ads, data import from Jobber, QuickBooks and Housecall Pro, price book build-out, crew training and Enterprise. Quoted per job.',
    body,
  };
}

export { SERVICE_LABEL };

// ---- /about ------------------------------------------------------------------------------------

export function aboutPage() {
  const body = html`
<section class="mk-hero" aria-labelledby="page-title">
  <div class="mk-hero-copy">
    <p class="mk-eyebrow">About Fishtape</p>
    <h1 id="page-title">Built by an electrical contractor, for crews who work to the CEC</h1>
    <p class="mk-lede">Fishtape started inside TG Electrical, a working Canadian electrical contractor. It's made for the people who quote the job, bend the pipe, fill in the FLHA and send the invoice, and who work to the Canadian Electrical Code every day.</p>
  </div>
</section>

<section class="mk-prose" aria-labelledby="why-title">
  <h2 id="why-title">Why it exists</h2>
  <p>General job software is built for every trade at once. It books the visit and sends the invoice, but the code book, the plan set and the bending chart aren't its job.</p>
  <p>That leaves a crew juggling a scheduling app, a spreadsheet price book, a bending chart taped in the van, a calculator app, a clipboard for the FLHA and an accounting package for the rest. Fishtape puts the electrical work and the business side in one app, built around the CEC and the way Canadian contractors charge tax.</p>
</section>

<section class="site-section" aria-labelledby="does-title">
  <div class="site-section-head"><h2 id="does-title">What it does</h2><p>Quotes, jobs, drawings, crew time and invoices in one app, for the office and the field.</p></div>
  <ul class="mk-links">${FEATURES.map((f) => html`<li><a href="/features/${f.slug}">${f.name}</a></li>`)}</ul>
</section>

<section class="site-section" aria-labelledby="principles-title">
  <div class="site-section-head"><h2 id="principles-title">What we hold to</h2></div>
  <ul class="mk-principles">
    <li><h3>Canadian code and tax built in</h3><p>CEC 2024 with provincial amendments by default, and GST, HST, PST and RST by province, with dates, sources and anything unconfirmed marked to verify.</p></li>
    <li><h3>Works offline on site</h3><p>Time clock, drawings, calculators, bending, wire runs and today's jobs work with no signal and sync when you're back in range.</p></li>
    <li><h3>Your data stays yours, and separate</h3><p>Each company's records are kept apart by the database itself. Export everything any time. Downgrading never deletes anything.</p></li>
    <li><h3>People approve what AI drafts</h3><p>The assistant drafts estimates, invoices and follow-ups. Nothing is sent, invoiced, paid or deleted until a person presses the button.</p></li>
    <li><h3>Plans that don't nickel-and-dime</h3><p>No caps on invoices, estimates, jobs, clients or drawings. Plans differ by features and included users.</p></li>
    <li><h3>Straight about what's built</h3><p>If something is coming, we say "coming". The App Store listing and a live QuickBooks connection are two of them.</p></li>
  </ul>
</section>

${leadForm({ id: 'contact', services: false, defaultService: 'contact', title: 'Contact us', intro: 'Questions about Fishtape, a demo for your crew, or something that doesn\'t work the way you\'d expect: send it here and a person will answer.', doneId: 'contact-done' })}
<p class="site-fine">Found a security problem? Please report it privately: see our <a href="/.well-known/security.txt">security.txt</a> and <a href="/features/security-privacy">security and privacy</a>.</p>
${ctaBand()}`;
  return {
    path: '/about', file: 'about.html',
    title: 'About Fishtape · Built by a Canadian electrical contractor',
    description: 'Fishtape is built by TG Electrical, a working Canadian electrical contractor, for crews who work to the CEC: Canadian code and tax built in, offline on site, your data kept separate, people approve what AI drafts.',
    body,
  };
}

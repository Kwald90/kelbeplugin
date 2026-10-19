// Account: sign-in, two-step sign-in (TOTP + recovery codes), password reset, the company
// switcher, shared-iPad crew PIN mode, preferences and sync status.
//
// The screens before sign-in render full-screen through renderGate() (no rail). The
// signed-in Account page is a hidden module the rail's avatar opens. Nothing here stores a
// token: sessions live in httpOnly cookies, and one-time secrets (the TOTP key, recovery
// codes, a reset token) stay in memory only.
import * as ui from '../ui.js';
import { api, session, savePref, isUnreachable } from '../session.js';
import { DEMO_DB } from '../store.js';
import { renderSVG } from '../vendor/qr.js';
import { PLANS, planFor } from '../plans.js';
import { BRAND } from '../brand.js';
import { getUnits } from '../lib/units.js';

const { h } = ui;

// Inline icons (BUILD-PLAN: modules inline the ones icons.js lacks).
export const ICON = {
  cloud: '<path d="M7 18a5 5 0 01-.9-9.9A6 6 0 0117.7 9 4.5 4.5 0 0117.5 18z"/>',
  cloudOk: '<path d="M7 18a5 5 0 01-.9-9.9A6 6 0 0117.7 9 4.5 4.5 0 0117.5 18z"/><path d="M9.5 13.5l2 2 3.5-4"/>',
  cloudOff: '<path d="M3 3l18 18"/><path d="M8.5 8.4A5 5 0 007 18h10.5M20.6 16.3A4.5 4.5 0 0017.7 9 6 6 0 0010.3 5.4"/>',
  cloudSync: '<path d="M7 18a5 5 0 01-.9-9.9A6 6 0 0117.7 9 4.5 4.5 0 0117.5 18z"/><path d="M10 12.5a2.5 2.5 0 014.3-1.4M14 14.5a2.5 2.5 0 01-4.3 1.4"/><path d="M14.5 9.8v1.6h-1.6M9.5 17.2v-1.6h1.6"/>',
  cloudAlert: '<path d="M7 18a5 5 0 01-.9-9.9A6 6 0 0117.7 9 4.5 4.5 0 0117.5 18z"/><path d="M12 10v3.2M12 15.6v.1"/>',
  google: '<path d="M20.5 12.2c0-.6-.1-1.2-.2-1.7H12v3.3h4.8a4.1 4.1 0 01-1.8 2.7v2.2h2.9c1.7-1.6 2.6-3.9 2.6-6.5z"/><path d="M12 21c2.4 0 4.5-.8 5.9-2.2L15 16.5c-.8.5-1.8.9-3 .9a5.3 5.3 0 01-5-3.7H4v2.3A9 9 0 0012 21z"/><path d="M7 13.7a5.4 5.4 0 010-3.4V8H4a9 9 0 000 8z"/><path d="M12 6.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 004 8l3 2.3a5.3 5.3 0 015-3.7z"/>',
  microsoft: '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>',
  tablet: '<rect x="5" y="2.5" width="14" height="19" rx="2"/><path d="M11 18.5h2"/>',
};

// ---------------------------------------------------------------------------
// one-time reset token: taken from the address bar at boot, kept in memory only

let resetToken = null;
/** app.js hands over the token from #/reset-password?token= and then strips it from the URL. */
export function holdResetToken(token) { resetToken = typeof token === 'string' && token.length <= 200 ? token : null; }

const OIDC_ERRORS = {
  no_account: 'No account uses that sign-in yet. Ask your company owner for an invite, or sign in with your email.',
  expired: 'That sign-in took too long. Try again.',
  provider_error: 'The sign-in provider did not complete the sign-in. Try again.',
  provider_disabled: 'That sign-in option is not set up here.',
  already_linked: 'That account is already linked to a different user.',
  disabled: 'This account is disabled. Ask your company owner.',
  session_revoked: 'Too many wrong codes, so we signed you out. Sign in again.',
};
const errorText = (code) => OIDC_ERRORS[code] || (code ? 'Sign-in did not work. Try again.' : null);

function note(text, tone = 'info') { return text ? h('div', { class: ['gate-note', tone], role: tone === 'danger' ? 'alert' : 'status' }, text) : null; }

function brandMark() {
  return h('div', { class: 'gate-brand' }, h('span', { class: 'gate-logo' }, ui.icon('zap', 22)), h('strong', null, BRAND.name));
}

/** Full-screen card for the screens before sign-in. */
function gateCard(title, sub, ...body) {
  return h('div', { class: 'gate-card card' }, brandMark(), h('h1', null, title), sub ? h('p', { class: 'muted gate-sub' }, sub) : null, ...body);
}

function busyButton(btn, fn) {
  return async (...a) => {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await fn(...a); } finally { btn.disabled = false; }
  };
}

const field = (label, input, hint) => h('label', { class: 'field' }, h('span', null, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
const input = (props) => h('input', { class: 'input', ...props });

// ---------------------------------------------------------------------------
// gate: the screens before sign-in

/**
 * Render a pre-sign-in screen.
 * @param {HTMLElement} root
 * @param {string} view 'sign-in' | 'forgot' | 'reset' | 'mfa' | 'crew' | 'no-company'
 * @param {object} ctx { restart(hash), startDemo(), opts }
 */
export function renderGate(root, view, ctx) {
  const go = (v, opts = {}) => renderGate(root, v, { ...ctx, opts });
  ui.clear(root);
  root.className = 'gate';
  const o = ctx.opts || {};
  const views = {
    'sign-in': () => signInView(go, ctx, o),
    forgot: () => forgotView(go, o),
    reset: () => resetView(go),
    mfa: () => (o.mfa === 'enrol' ? enrolView(go, ctx) : verifyView(go, ctx)),
    crew: () => crewView(go, ctx, o),
    'no-company': () => noCompanyView(go, ctx, o),
  };
  root.append((views[view] || views['sign-in'])());
  setTimeout(() => root.querySelector('input:not([type=checkbox]), button.primary')?.focus(), 30);
}

function signInView(go, ctx, o) {
  const msg = h('div', { class: 'gate-msg' },
    o.unreachable ? note("Can't reach the server right now. Check the connection, or try the demo on this device.", 'warning') : null,
    o.expired ? note('Your session ended. Sign in again. Changes on this device are kept until you do.', 'info') : null,
    o.info ? note(o.info, 'success') : null,
    note(errorText(o.error), 'danger'));
  const email = input({ type: 'email', name: 'email', autocomplete: 'username', required: true, value: o.email || '', inputmode: 'email' });
  const password = input({ type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const submit = ui.button('Sign in', { variant: 'primary lg', type: 'submit' });
  submit.classList.add('wide');
  const form = h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); doSignIn(); } },
    field('Email', email), field('Password', password), submit,
    h('div', { class: 'row gate-links' }, h('a', { href: '#/sign-in', onClick: (e) => { e.preventDefault(); go('forgot', { email: email.value }); } }, 'Forgot password?')));
  const doSignIn = busyButton(submit, async () => {
    msg.replaceChildren();
    try {
      const r = await session.login(email.value.trim(), password.value);
      if (r.mfa) return go('mfa', { mfa: r.mfa });
      if (!r.me?.tenant) return go('no-company', { me: r.me });
      ctx.restart('dashboard');
    } catch (e) {
      password.value = '';
      msg.append(note(isUnreachable(e) ? "Can't reach the server. Check the connection and try again." : e.message, 'danger'));
    }
  });

  const providers = h('div', { class: 'stack gate-providers' });
  session.providers().then((p) => {
    const kids = [];
    if (p?.google) kids.push(oidcButton('google', 'Continue with Google', ICON.google));
    if (p?.microsoft) kids.push(oidcButton('microsoft', 'Continue with Microsoft', ICON.microsoft));
    if (kids.length) providers.append(h('div', { class: 'gate-sep' }, h('span', null, 'or')), ...kids);
  }).catch(() => {});

  const device = session.device();
  const demoBtn = ui.button('Try the demo on this device', { variant: 'ghost', icon: 'play', onClick: () => ctx.startDemo() });
  demoBtn.classList.add('wide');
  // Someone who used the demo before keeps their demo data: say so.
  globalThis.indexedDB?.databases?.().then((dbs) => {
    if (dbs?.some((d) => d.name === DEMO_DB)) demoBtn.querySelector('span').textContent = 'Continue the demo on this device';
  }).catch(() => {});

  return gateCard('Sign in', `Your company's jobs, drawings and money, on every device.`,
    msg, form, providers,
    device ? h('div', { class: 'gate-sep' }, h('span', null, 'shared iPad')) : null,
    device ? ui.button(`Crew sign-in on ${device.name}`, { variant: 'secondary', icon: ICON.tablet, onClick: () => go('crew') }) : null,
    h('div', { class: 'gate-demo' },
      demoBtn,
      h('p', { class: 'muted' }, 'Demo mode: sample data that stays on this device and never syncs. No account needed.')));
}

function oidcButton(provider, label, svg) {
  // A plain navigation: the API redirects to the provider and back to #/ (or #/sign-in?mfa=, ?error=).
  const b = ui.button(label, { variant: 'secondary lg', icon: svg, href: `/api/v1/auth/oidc/${provider}/start` });
  b.classList.add('wide');
  return b;
}

function forgotView(go, o) {
  const email = input({ type: 'email', autocomplete: 'username', required: true, value: o.email || '' });
  const msg = h('div', { class: 'gate-msg' });
  const submit = ui.button('Email me a link', { variant: 'primary lg', type: 'submit' });
  submit.classList.add('wide');
  const send = busyButton(submit, async () => {
    msg.replaceChildren();
    try {
      await api.post('/api/v1/auth/password/forgot', { email: email.value.trim() });
      msg.append(note('If an account uses that email, a link is on its way. It works for one hour.', 'success'));
    } catch (e) {
      msg.append(note(isUnreachable(e) ? "Can't reach the server. Try again shortly." : e.message, 'danger'));
    }
  });
  return gateCard('Reset your password', 'We email you a link to set a new one.',
    msg, h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); send(); } }, field('Email', email), submit),
    h('div', { class: 'row gate-links' }, h('a', { href: '#/sign-in', onClick: (e) => { e.preventDefault(); go('sign-in', { email: email.value }); } }, 'Back to sign in')));
}

function resetView(go) {
  const pw = input({ type: 'password', autocomplete: 'new-password', required: true, minlength: 12 });
  const pw2 = input({ type: 'password', autocomplete: 'new-password', required: true, minlength: 12 });
  const msg = h('div', { class: 'gate-msg' }, resetToken ? null : note('This link is missing its code or was already used. Ask for a new one.', 'warning'));
  const submit = ui.button('Set password', { variant: 'primary lg', type: 'submit', disabled: !resetToken });
  submit.classList.add('wide');
  const save = busyButton(submit, async () => {
    msg.replaceChildren();
    if (pw.value !== pw2.value) { msg.append(note('The two passwords are different.', 'danger')); return; }
    try {
      await api.post('/api/v1/auth/password/reset', { token: resetToken, newPassword: pw.value });
      resetToken = null;
      go('sign-in', { info: 'Password set. Sign in with it now.' });
    } catch (e) {
      msg.append(note(e.code === 'invalid_token' ? 'This link has expired or was already used. Ask for a new one.' : e.message, 'danger'));
    }
  });
  return gateCard('Set a new password', 'At least 12 characters. A short sentence is easy to remember and hard to guess.',
    msg, h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); save(); } },
      field('New password', pw), field('Type it again', pw2), submit),
    h('div', { class: 'row gate-links' },
      h('a', { href: '#/sign-in', onClick: (e) => { e.preventDefault(); go('forgot'); } }, 'Ask for a new link'),
      h('a', { href: '#/sign-in', onClick: (e) => { e.preventDefault(); go('sign-in'); } }, 'Back to sign in')));
}

async function signOutToGate(go, extra = {}) {
  await session.logout();
  go('sign-in', extra);
}

function verifyView(go, ctx) {
  let recovery = false;
  const msg = h('div', { class: 'gate-msg' });
  const code = input({ name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: 6, required: true, placeholder: '123456', class: 'input code-input' });
  const rcode = input({ name: 'recoveryCode', autocomplete: 'off', required: true, placeholder: 'xxxx-xxxx-xxxx', class: 'input code-input' });
  const host = h('div');
  const toggle = h('a', { href: '#/sign-in', onClick: (e) => { e.preventDefault(); recovery = !recovery; draw(); } });
  const submit = ui.button('Verify', { variant: 'primary lg', type: 'submit' });
  submit.classList.add('wide');
  const draw = () => {
    host.replaceChildren(recovery ? field('Recovery code', rcode, 'One of the codes you saved when you set this up. Each works once.') : field('6-digit code from your authenticator app', code));
    toggle.textContent = recovery ? 'Use the authenticator app instead' : 'Use a recovery code instead';
    (recovery ? rcode : code).focus();
  };
  const verify = busyButton(submit, async () => {
    msg.replaceChildren();
    try {
      const r = await api.post('/api/v1/auth/mfa/verify', recovery ? { recoveryCode: rcode.value.trim() } : { code: code.value.trim() });
      if (r.recoveryCodesLeft != null) {
        ui.toast(`${r.recoveryCodesLeft} recovery code${r.recoveryCodesLeft === 1 ? '' : 's'} left${r.recoveryCodesLeft <= 3 ? '. Make new ones in Account.' : ''}`, r.recoveryCodesLeft <= 3 ? 'error' : 'info', 5000);
        await new Promise((res) => setTimeout(res, 1200));
      }
      ctx.restart('dashboard');
    } catch (e) {
      code.value = ''; rcode.value = '';
      if (e.code === 'session_revoked' || e.status === 401) return go('sign-in', { error: 'session_revoked' });
      msg.append(note(e.code === 'invalid_code' ? "That code didn't match. Check the time on your phone and try again." : e.message, 'danger'));
    }
  });
  const card = gateCard('Two-step sign-in', 'Enter the code from your authenticator app.',
    msg, h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); verify(); } }, host, submit),
    h('div', { class: 'row gate-links' }, toggle, h('a', { href: '#/sign-in', onClick: (e) => { e.preventDefault(); signOutToGate(go); } }, 'Sign out')));
  draw();
  return card;
}

/**
 * TOTP enrolment: QR + key, confirm with a code, then the recovery codes (shown once).
 * Used by the gate (owners/admins must enrol) and by the Account page.
 */
export function enrolFlow({ onDone, onCancel }) {
  const host = h('div', { class: 'stack' });
  const msg = h('div', { class: 'gate-msg' });
  host.append(msg, h('p', { class: 'muted' }, 'Getting your key…'));
  api.post('/api/v1/auth/mfa/totp/enrol').then(({ secret, otpauthUri }) => {
    const qr = h('div', { class: 'qr-box', role: 'img', 'aria-label': 'QR code for your authenticator app' });
    // Our own SVG string from the vendored encoder (rects and one path; nothing user-supplied is markup).
    qr.innerHTML = renderSVG(otpauthUri, { ecc: 'M', border: 2, pixelSize: 6, blackColor: '#1c1b19', whiteColor: '#ffffff' });
    const grouped = secret.replace(/(.{4})/g, '$1 ').trim();
    const code = input({ inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: 6, required: true, placeholder: '123456', class: 'input code-input' });
    const submit = ui.button('Turn on two-step sign-in', { variant: 'primary', type: 'submit' });
    const confirm = busyButton(submit, async () => {
      msg.replaceChildren();
      try {
        const { recoveryCodes } = await api.post('/api/v1/auth/mfa/totp/confirm', { code: code.value.trim() });
        host.replaceChildren(recoveryCodesView(recoveryCodes, onDone));
      } catch (e) {
        code.value = '';
        msg.append(note(e.code === 'invalid_code' ? "That code didn't match. Check the time on your phone and try again." : e.message, 'danger'));
      }
    });
    host.replaceChildren(msg,
      h('ol', { class: 'enrol-steps' },
        h('li', null, 'Open an authenticator app on your phone: Google Authenticator, Microsoft Authenticator, 1Password or similar.'),
        h('li', null, 'Scan this code, or enter the key by hand.'),
        h('li', null, 'Type the 6-digit code it shows.')),
      h('div', { class: 'enrol-key' }, qr,
        h('div', { class: 'stack' },
          h('div', null, h('div', { class: 'muted' }, 'Key'), h('code', { class: 'secret', 'aria-label': 'Authenticator key' }, grouped)),
          h('div', { class: 'row' },
            ui.button('Copy key', { size: 'sm', icon: 'copy', onClick: () => copy(secret, 'Key copied') }),
            h('a', { class: 'btn sm', href: otpauthUri }, 'Open in app')))),
      h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); confirm(); } }, field('6-digit code', code), h('div', { class: 'row' }, submit, onCancel ? ui.button('Cancel', { variant: 'ghost', onClick: onCancel }) : null)));
    code.focus();
  }).catch((e) => {
    host.replaceChildren(note(e.code === 'mfa_required' ? 'Verify your current authenticator first.' : e.message, 'danger'));
  });
  return host;
}

function copy(text, done) {
  navigator.clipboard?.writeText(text).then(() => ui.toast(done, 'success'), () => ui.toast('Copy did not work; select the text instead', 'error'));
}

/** The ten recovery codes, shown once, with download and copy; Continue once saved. */
function recoveryCodesView(codes, onDone) {
  const text = `${BRAND.name} recovery codes\nEach code works once, if you lose your phone.\nKeep them somewhere safe, like a password manager.\n\n${codes.join('\n')}\n`;
  const saved = h('input', { type: 'checkbox' });
  const cont = ui.button('Continue', { variant: 'primary', disabled: true, onClick: () => onDone() });
  saved.addEventListener('change', () => { cont.disabled = !saved.checked; });
  return h('div', { class: 'stack' },
    note('Two-step sign-in is on. Save these recovery codes now: they are shown only once.', 'success'),
    h('ul', { class: 'codes', 'aria-label': 'Recovery codes' }, codes.map((c) => h('li', null, h('code', null, c)))),
    h('div', { class: 'row' },
      ui.button('Download', { icon: 'download', onClick: () => ui.download(`${BRAND.backupTag}-recovery-codes.txt`, text, 'text/plain') }),
      ui.button('Copy', { icon: 'copy', onClick: () => copy(codes.join('\n'), 'Codes copied') })),
    h('label', { class: 'field check' }, saved, h('span', null, 'I saved my recovery codes')),
    cont);
}

function enrolView(go, ctx) {
  return gateCard('Set up two-step sign-in', 'Owners and admins protect the company with a code from their phone as well as a password.',
    enrolFlow({ onDone: () => ctx.restart('dashboard') }),
    h('div', { class: 'row gate-links' }, h('a', { href: '#/sign-in', onClick: (e) => { e.preventDefault(); signOutToGate(go); } }, 'Sign out')));
}

function crewView(go, ctx, o) {
  const device = session.device();
  const msg = h('div', { class: 'gate-msg' }, o.info ? note(o.info, 'info') : null);
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading the crew…'));
  const card = gateCard('Who is working?', device ? `${device.name}: tap your name, then your PIN.` : 'Tap your name, then your PIN.',
    msg, body,
    h('div', { class: 'row gate-links' }, h('a', { href: '#/sign-in', onClick: (e) => { e.preventDefault(); go('sign-in'); } }, 'Manager? Sign in with email')));
  api.get('/api/v1/devices/crew').then(({ company, crew }) => {
    if (!crew.length) { body.replaceChildren(note('Nobody has a PIN yet. A manager can set PINs in Account → Shared iPad.', 'info')); return; }
    card.querySelector('.gate-sub').textContent = `${company}: tap your name, then your PIN.`;
    body.replaceChildren(h('div', { class: 'crew-grid' }, crew.map((c) => h('button', { type: 'button', class: 'crew-tile', onClick: () => pinPad(body, msg, c, ctx) },
      h('span', { class: 'avatar' }, ui.initials(c.name)), h('span', { class: 'title' }, c.name)))));
  }).catch((e) => {
    if (e.code === 'invalid_device' || e.status === 401) {
      session.setDevice(null);
      go('sign-in', { info: null, error: null, unreachable: false });
      ui.toast('This iPad is no longer registered for crew sign-in', 'error', 4000);
      return;
    }
    body.replaceChildren(note(isUnreachable(e) ? 'Crew sign-in needs a connection. Try again when this iPad is online.' : e.message, 'warning'),
      ui.button('Try again', { icon: 'redo', onClick: () => go('crew') }));
  });
  return card;
}

function pinPad(host, msg, person, ctx) {
  let pin = '';
  const dots = h('div', { class: 'pin-dots', 'aria-live': 'polite' });
  const draw = () => { dots.replaceChildren(...Array.from({ length: Math.max(4, pin.length) }, (_, i) => h('span', { class: i < pin.length ? 'on' : null }))); dots.setAttribute('aria-label', `${pin.length} digits entered`); };
  const press = (d) => { if (pin.length < 8) { pin += d; draw(); } };
  const back = () => { pin = pin.slice(0, -1); draw(); };
  const ok = h('button', { type: 'button', class: 'pin-key ok', 'aria-label': 'Sign in' }, ui.icon('check', 22));
  const submit = busyButton(ok, async () => {
    if (pin.length < 4) return;
    msg.replaceChildren();
    try {
      await api.post('/api/v1/devices/crew/sign-in', { membershipId: person.membershipId, pin });
      ctx.restart('dashboard');
    } catch (e) {
      pin = ''; draw();
      msg.append(note(e.code === 'invalid_pin' ? 'Wrong PIN. Try again.' : e.message, 'danger'));
    }
  });
  ok.addEventListener('click', submit);
  const key = (d) => h('button', { type: 'button', class: 'pin-key', onClick: () => press(d) }, d);
  const onKey = (e) => {
    if (!host.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') back();
    else if (e.key === 'Enter') submit();
  };
  document.addEventListener('keydown', onKey);
  host.replaceChildren(
    h('div', { class: 'row' }, h('span', { class: 'avatar' }, ui.initials(person.name)), h('strong', { class: 'grow' }, person.name),
      ui.button('Not me', { variant: 'ghost', size: 'sm', onClick: () => { document.removeEventListener('keydown', onKey); ctx.restart(''); } })),
    dots,
    h('div', { class: 'pin-pad' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(key),
      h('button', { type: 'button', class: 'pin-key', 'aria-label': 'Delete', onClick: back }, ui.icon('chevron-left', 22)), key('0'), ok));
  draw();
}

function noCompanyView(go, ctx, o) {
  const ms = o.me?.memberships || [];
  return gateCard('No active company', 'Your account is not an active member of a company yet.',
    ms.length ? h('div', { class: 'list' }, ms.map((m) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('div', { class: 'title' }, m.tenantName), h('div', { class: 'meta' }, `${m.role} · ${m.status}${m.tenantStatus !== 'active' ? ` · company ${m.tenantStatus}` : ''}`))))) : null,
    h('p', { class: 'muted' }, 'If you were invited, use the link in the invite email to set your password. Otherwise ask the company owner.'),
    ui.button('Sign out', { icon: 'log-out', onClick: () => signOutToGate(go) }));
}

// ---------------------------------------------------------------------------
// sync status (rail button, sheet, Account card)

export function syncLabel(s) {
  if (!s) return { icon: ICON.cloud, text: 'Sync', tone: '' };
  if (s.state === 'syncing') return { icon: ICON.cloudSync, text: 'Syncing…', tone: 'info' };
  if (s.state === 'offline') return { icon: ICON.cloudOff, text: s.waiting ? `Offline · ${s.waiting} waiting` : 'Offline', tone: 'warning' };
  if (s.state === 'error') return { icon: ICON.cloudAlert, text: 'Sync problem · tap to retry', tone: 'danger' };
  if (s.rejected) return { icon: ICON.cloudAlert, text: `${s.rejected} change${s.rejected === 1 ? '' : 's'} not saved`, tone: 'danger' };
  if (s.waiting) return { icon: ICON.cloudSync, text: `${s.waiting} waiting`, tone: 'info' };
  return { icon: ICON.cloudOk, text: 'Synced', tone: 'success' };
}

const COLL_LABEL = { timeEntries: 'time entry', stockMoves: 'stock move', wireRuns: 'wire run', benderProfiles: 'bender profile', settings: 'settings' };
const describeEntry = (store, e) => {
  const r = store.get(e.collection, e.id);
  const name = r ? String(r.number || r.name || r.title || r.description || '').slice(0, 60) : '';
  return `${e.op === 'delete' ? 'Delete ' : ''}${COLL_LABEL[e.collection] || e.collection.replace(/s$/, '')}${name ? `: ${name}` : ''}`;
};

/** Sync details: state, last sync, waiting count, refused changes with Retry / Use the server copy. */
export function syncPanel(app) {
  const host = h('div', { class: 'stack' });
  const draw = () => {
    const s = app.sync?.status();
    if (!s) { host.replaceChildren(h('p', { class: 'muted' }, 'Demo mode: nothing syncs. Data stays on this device.')); return; }
    const l = syncLabel(s);
    const rejected = app.store.queue.filter((e) => e.state === 'rejected' && e.collection !== 'auditLog');
    host.replaceChildren(
      h('div', { class: 'row' }, h('span', { class: ['sync-dot', l.tone] }), h('strong', { class: 'grow' }, l.text),
        ui.button('Sync now', { size: 'sm', icon: 'redo', onClick: async () => { await app.sync.syncNow(); draw(); } })),
      h('div', { class: 'muted' }, s.lastSyncAt ? `Last synced ${ui.fmtDateTime(s.lastSyncAt)}` : 'Not synced yet on this device'),
      s.state === 'offline' ? h('div', { class: 'muted' }, 'Changes are saved on this device and sync when the connection is back.') : null,
      s.error ? note(s.error.message, 'danger') : null,
      rejected.length ? h('div', { class: 'stack' },
        h('div', null, h('strong', null, 'Not saved on the server'), h('div', { class: 'muted' }, 'The server refused these. Your copy is still on this device.')),
        h('div', { class: 'list' }, rejected.map((e) => h('div', { class: 'list-row' },
          h('div', { class: 'grow' }, h('div', { class: 'title' }, describeEntry(app.store, e)), h('div', { class: 'meta' }, e.error?.message || 'Refused')),
          ui.button('Retry', { size: 'sm', onClick: async () => { await app.sync.retry(e.mid); draw(); } }),
          ui.button('Use server copy', { size: 'sm', variant: 'ghost', onClick: async () => {
            try { await app.sync.discard(e.mid); ui.toast('Replaced with the server copy', 'success'); } catch (err) { ui.toast(err.message, 'error'); }
            draw();
          } }))))) : null);
  };
  draw();
  const off = app.onSyncStatus?.(draw);
  host.cleanup = off;
  return host;
}

export function openSyncSheet(app) {
  const panel = syncPanel(app);
  ui.openSheet({ title: 'Sync', dialog: true, body: panel, onClose: () => panel.cleanup?.() });
}

// ---------------------------------------------------------------------------
// plans: locked modules

/**
 * The upgrade card for a module the company's plan does not include. Reads are never
 * blocked: when the module has records, "View your records" opens it read-only.
 */
export function upgradeCard(mod, { auth, hasData, onView, entitlements }) {
  const need = planFor(mod.id);
  const plan = PLANS[need] || null;
  const current = PLANS[entitlements?.plan]?.name || 'your current plan';
  const enterprise = Boolean(plan?.contactSales);
  const admin = auth.isAdmin();
  return ui.page({ title: mod.title },
    h('section', { class: 'card upgrade-card' },
      h('div', { class: 'ico' }, ui.icon('lock', 24)),
      h('h2', null, plan ? `${mod.title} is part of ${plan.name}` : `${mod.title} is not in your plan`),
      h('p', { class: 'muted' }, `Your company is on ${current}. ${plan?.blurb ? `${plan.name}: ${plan.blurb.replace(/\.?$/, '.')}` : ''}`),
      admin
        ? h('div', { class: 'row' }, ui.button(enterprise ? "Let's talk" : `See ${plan?.name || 'plans'}`, { variant: 'primary', icon: enterprise ? 'mail' : 'star', href: enterprise ? '#/billing?plan=enterprise' : `#/billing?plan=${need || ''}` }))
        : h('p', { class: 'muted' }, 'Ask an owner or admin to upgrade.'),
      hasData ? h('div', { class: 'stack upgrade-read' },
        h('p', { class: 'muted' }, 'Your existing records are still yours to read.'),
        ui.button(`View your ${mod.title.toLowerCase()}`, { icon: 'eye', onClick: onView })) : null));
}

export function readOnlyBanner(mod) {
  const plan = PLANS[planFor(mod.id)];
  return h('div', { class: 'readonly-banner no-print', role: 'note' }, ui.icon('lock', 16),
    h('span', null, `Read-only: ${mod.title} is part of ${plan?.name || 'a higher plan'}. Changes you make here will not be saved to the server.`),
    h('a', { href: '#/billing' }, 'Upgrade'));
}

// ---------------------------------------------------------------------------
// the Account page (signed in) and the demo explainer

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', office: 'Office', foreman: 'Foreman', electrician: 'Electrician', apprentice: 'Apprentice' };

function pinDialog(title, label) {
  return new Promise((resolve) => {
    let done = false;
    const a = input({ type: 'password', inputmode: 'numeric', autocomplete: 'off', pattern: '[0-9]{4,8}', maxlength: 8 });
    const b = input({ type: 'password', inputmode: 'numeric', autocomplete: 'off', pattern: '[0-9]{4,8}', maxlength: 8 });
    const err = h('div');
    const ok = () => {
      err.replaceChildren();
      if (!/^\d{4,8}$/.test(a.value)) return err.append(note('Use 4 to 8 digits.', 'danger'));
      if (a.value !== b.value) return err.append(note('The two PINs are different.', 'danger'));
      done = true; resolve(a.value); s.close();
    };
    const s = ui.openSheet({
      title, dialog: true,
      body: h('form', { class: 'stack', onSubmit: (e) => { e.preventDefault(); ok(); } }, err, field(label, a, '4 to 8 digits, not all the same'), field('Again', b), h('button', { type: 'submit', hidden: true })),
      actions: [ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }), ui.button('Save PIN', { variant: 'primary', onClick: ok })],
      onClose: () => { if (!done) resolve(null); },
    });
  });
}

async function setPin(membershipId, name) {
  const pin = await pinDialog(name ? `PIN for ${name}` : 'Your crew PIN', 'PIN');
  if (pin == null) return false;
  try {
    await api.put(`/api/v1/members/${encodeURIComponent(membershipId)}/pin`, { pin });
    ui.toast('PIN saved', 'success');
    return true;
  } catch (e) { ui.toast(e.message, 'error', 4000); return false; }
}

function sharedDeviceCard(app, auth) {
  const host = h('div', { class: 'stack' });
  const draw = async () => {
    const device = session.device();
    const kids = [];
    if (device) {
      kids.push(h('div', { class: 'row' }, ui.icon(ICON.tablet, 18), h('strong', { class: 'grow' }, device.name), ui.badge('Shared iPad', 'success')),
        h('p', { class: 'muted' }, 'Crew sign in here with their name and PIN. Signing out keeps this company’s data on the iPad.'),
        h('div', { class: 'row' },
          ui.button('Hand over to crew', { variant: 'primary', icon: 'users', onClick: () => app.signOut({ keepData: true }) }),
          ui.button('Stop crew sign-in here', { variant: 'ghost danger', onClick: async () => {
            if (!(await ui.confirmDialog('Crew will no longer be able to sign in on this iPad with a PIN.', { title: 'Stop crew sign-in?', okLabel: 'Stop' }))) return;
            try { await api.del(`/api/v1/devices/${encodeURIComponent(device.id)}`); } catch (e) { if (e.status !== 404) return ui.toast(e.message, 'error'); }
            session.setDevice(null); ui.toast('This iPad is a personal device again', 'success'); draw();
          } })));
    } else {
      kids.push(h('p', { class: 'muted' }, 'Leave an iPad on site or in the van: crew tap their name and enter a PIN instead of a password. Crew sessions can do at most what a foreman can.'),
        ui.button('Use this iPad for crew sign-in', { icon: ICON.tablet, onClick: async () => {
          const name = await ui.promptDialog('Name for this iPad', { title: 'Register shared iPad', value: 'Site iPad', okLabel: 'Register' });
          if (!name?.trim()) return;
          try {
            const r = await api.post('/api/v1/devices', { name: name.trim().slice(0, 100) });
            session.setDevice({ id: r.device.id, name: r.device.name, tenantId: auth.account.tenantId });
            ui.toast('Registered. Set crew PINs below, then hand it over.', 'success', 4000);
            draw();
          } catch (e) { ui.toast(e.message, 'error', 4000); }
        } }));
    }
    // Crew PINs (managers): who can sign in on a shared iPad.
    const list = h('div', { class: 'list' }, h('div', { class: 'list-row muted' }, 'Loading crew…'));
    kids.push(h('strong', null, 'Crew PINs'), list);
    host.replaceChildren(...kids);
    try {
      const { data } = await api.get('/api/v1/members');
      list.replaceChildren(...data.filter((m) => m.status === 'active').map((m) => h('div', { class: 'list-row' },
        h('span', { class: 'avatar', style: { background: '#5f5a51' } }, ui.initials(m.displayName || '?')),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, m.displayName), h('div', { class: 'meta' }, ROLE_LABEL[m.role] || m.role)),
        m.hasPin ? ui.badge('PIN set', 'success') : ui.badge('No PIN', 'neutral'),
        ui.button(m.hasPin ? 'Change' : 'Set PIN', { size: 'sm', onClick: async () => { if (await setPin(m.id, m.displayName)) draw(); } }))));
    } catch (e) {
      list.replaceChildren(h('div', { class: 'list-row muted' }, isUnreachable(e) ? 'Needs a connection.' : e.message));
    }
  };
  draw();
  return host;
}

function demoPage(root, ctx) {
  const { app } = ctx;
  root.append(ui.page({ title: 'Account', subtitle: 'Demo on this device' },
    h('div', { class: 'grid-2 account-grid' },
      h('section', { class: 'card stack' }, h('h3', null, 'You are using the demo'),
        h('p', { class: 'muted' }, 'Sample data that stays on this device and never syncs. Your company account keeps jobs, drawings and money in sync on every device.'),
        h('div', { class: 'row' }, ui.button('Sign in to your company', { variant: 'primary', icon: 'key', onClick: () => app.leaveDemo() }))),
      h('section', { class: 'card stack' }, h('h3', null, 'Who is using this device'),
        h('p', { class: 'muted' }, 'In the demo, pick a person from Employees to try different roles.'),
        h('div', { class: 'row' }, ui.button('Switch person', { icon: 'users', onClick: () => app.switchDemoUser() }))))));
}

export default {
  id: 'account',
  title: 'Account',
  icon: 'user',
  group: 'admin',
  hidden: true,
  render(root, ctx) {
    const { auth, app } = ctx;
    if (!auth.synced) return demoPage(root, ctx);
    const me = session.me || {};
    const acct = auth.account;
    const card = (title, sub, ...kids) => h('section', { class: 'card stack' }, h('div', null, h('h3', null, title), sub ? h('div', { class: 'muted' }, sub) : null), ...kids);
    const offline = !session.online;

    // company switcher
    const others = (me.memberships || []).filter((m) => m.status === 'active' && m.tenantStatus === 'active' && m.tenantId !== acct.tenantId);
    const companyCard = card('Company', null,
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, acct.tenantName), ui.badge(ROLE_LABEL[acct.role] || acct.role, 'accent'), acct.crew ? ui.badge('Crew PIN', 'neutral') : null),
      me.entitlements ? h('div', { class: 'muted' }, `${PLANS[me.entitlements.plan]?.name || me.entitlements.plan} plan${me.entitlements.onTrial ? ` · trial${me.entitlements.trialEndsAt ? ` until ${ui.fmtDate(me.entitlements.trialEndsAt)}` : ''}` : ''}`) : null,
      others.length && !acct.crew ? h('div', { class: 'stack' }, h('div', { class: 'muted' }, 'Your other companies. Each keeps its own data on this device.'),
        h('div', { class: 'list' }, others.map((m) => h('div', { class: 'list-row' },
          h('div', { class: 'grow' }, h('div', { class: 'title' }, m.tenantName), h('div', { class: 'meta' }, ROLE_LABEL[m.role] || m.role)),
          ui.button('Switch', { size: 'sm', disabled: offline, onClick: () => app.switchCompany(m.tenantId) }))))) : null);

    // preferences: units and theme follow the person (PATCH /api/v1/me/prefs)
    const prefsHost = h('div', { class: 'stack' });
    const drawPrefs = () => {
      let theme = 'system';
      try { theme = localStorage.getItem('kc.theme') || 'system'; } catch { /* ignore */ }
      const set = async (k, v) => { await savePref(session.me, k, v); drawPrefs(); app.refreshShell(); };
      prefsHost.replaceChildren(
        h('div', { class: 'stack', style: { gap: 'var(--s2)' } }, h('strong', null, 'Lengths'),
          ui.tabs([{ id: 'metric', label: 'Metric (m, mm)' }, { id: 'imperial', label: 'Imperial (ft, in)' }], getUnits(app.store.settings().units), (u) => set('units', u))),
        h('div', { class: 'stack', style: { gap: 'var(--s2)' } }, h('strong', null, 'Theme'),
          ui.tabs([{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }, { id: 'system', label: 'Match device' }], theme, (t) => set('theme', t))),
        h('div', { class: 'muted' }, 'Saved to your profile, so they follow you to other devices.'));
    };
    drawPrefs();

    // two-step sign-in
    const mfaHost = h('div', { class: 'stack' });
    const drawMfa = () => {
      const on = me.session?.mfaEnrolled;
      mfaHost.replaceChildren(
        h('div', { class: 'row' }, h('span', { class: 'grow' }, on ? 'On: a code from your phone is needed at each new sign-in.' : 'Off.'), ui.badge(on ? 'On' : 'Off', on ? 'success' : 'neutral')),
        on ? ui.button('Make new recovery codes', { icon: 'key', disabled: offline, onClick: async () => {
          if (!(await ui.confirmDialog('Your old recovery codes stop working.', { title: 'Make new recovery codes?', okLabel: 'Make new codes', danger: false }))) return;
          try {
            const { recoveryCodes } = await api.post('/api/v1/auth/mfa/recovery-codes');
            const s = ui.openSheet({ title: 'New recovery codes', dialog: true, body: recoveryCodesView(recoveryCodes, () => s.close()) });
          } catch (e) { ui.toast(e.message, 'error'); }
        } }) : ui.button('Turn on two-step sign-in', { variant: 'primary', icon: 'shield-check', disabled: offline, onClick: () => {
          const s = ui.openSheet({ title: 'Two-step sign-in', wide: true, body: enrolFlow({ onDone: () => { s.close(); me.session.mfaEnrolled = true; drawMfa(); }, onCancel: () => s.close() }) });
        } }));
    };
    drawMfa();

    const sync = syncPanel(app);
    root.append(ui.page({ title: 'Account', subtitle: `${acct.name}${me.user?.email ? ` · ${me.user.email}` : ''}`, actions: [
      ui.button(acct.crew ? 'Done: hand back the iPad' : 'Sign out', { variant: acct.crew ? 'primary' : 'secondary', icon: 'log-out', onClick: () => app.signOut() })] },
      offline ? note('Offline: showing what is on this device. Account changes need a connection.', 'warning') : null,
      h('div', { class: 'grid-2 account-grid' },
        companyCard,
        card('Sync', 'Every change is saved on this device first, then sent to the server.', sync),
        card('Your preferences', null, prefsHost),
        acct.crew ? null : card('Two-step sign-in', 'Required for owners and admins.', mfaHost),
        acct.crew || !acct.membershipId ? null : card('Your crew PIN', 'For signing in on a shared iPad.',
          ui.button('Set my PIN', { icon: 'key', disabled: offline, onClick: () => setPin(acct.membershipId) })),
        auth.isManager() && !acct.crew ? card('Shared iPad', 'Crew PIN sign-in on a company iPad', offline ? h('p', { class: 'muted' }, 'Needs a connection.') : sharedDeviceCard(app, auth)) : null)));
    return () => sync.cleanup?.();
  },
};

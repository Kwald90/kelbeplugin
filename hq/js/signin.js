// HQ sign-in: email + password, then TOTP (set up on first sign-in), using the same
// auth endpoints as the app. HQ staff must have two-step sign-in; there is no way round it.
import { BRAND } from '/js/brand.js';
import { api, post } from './api.js';

/**
 * @param {{ step: 'password'|'verify'|'enrol'|'not-staff'|'offline', ui: typeof import('/js/ui.js'), onDone: Function, onSignOut: Function, error?: string|null }} o
 */
export function showSignIn({ step, ui, onDone, onSignOut, error = null }) {
  const { h } = ui;
  document.querySelector('.hq-signin')?.remove();
  const card = h('div', { class: 'card hq-signin-card' });
  const root = h('div', { class: 'hq-signin' }, card);
  document.body.append(root);

  const errorBox = h('p', { class: 'hq-error', role: 'alert', hidden: !error }, error || '');
  const fail = (e) => { errorBox.textContent = e.message || 'Something went wrong.'; errorBox.hidden = false; };
  const busy = (btn, on) => { btn.disabled = on; };
  const head = (title, sub) => [
    h('div', { class: 'hq-brand' }, ui.icon('zap', 20), h('strong', null, `${BRAND.name} HQ`)),
    h('h1', null, title), sub ? h('p', { class: 'muted' }, sub) : null,
  ];

  function draw(nodes) { ui.clear(card); card.append(...nodes.flat().filter(Boolean)); card.querySelector('input')?.focus(); }

  function passwordStep() {
    const email = h('input', { type: 'email', name: 'email', autocomplete: 'username', required: true });
    const password = h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
    const form = h('form', { class: 'stack', onSubmit: async (e) => {
      e.preventDefault();
      errorBox.hidden = true;
      busy(btn, true);
      try {
        const r = await api('/api/v1/auth/login', { method: 'POST', body: { email: email.value, password: password.value }, quiet: true });
        if (r.mfa === 'verify') verifyStep();
        else if (r.mfa === 'enrol') enrolStep();
        else onDone();
      } catch (err) { fail(err); } finally { busy(btn, false); }
    } },
    h('label', { class: 'field' }, h('span', null, 'Email'), email),
    h('label', { class: 'field' }, h('span', null, 'Password'), password),
    errorBox, btn);
    draw([head('Sign in', 'For Fishtape staff. Two-step sign-in is required.'), form]);
  }

  function verifyStep() {
    let recovery = false;
    const code = h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9 ]*', maxlength: 8, required: true });
    const label = h('span', null, 'Code from your authenticator app');
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Verify');
    const toggle = h('button', { class: 'btn ghost sm', type: 'button', onClick: () => {
      recovery = !recovery;
      label.textContent = recovery ? 'Recovery code' : 'Code from your authenticator app';
      code.removeAttribute('pattern'); code.setAttribute('maxlength', recovery ? '32' : '8'); code.inputMode = recovery ? 'text' : 'numeric';
      toggle.textContent = recovery ? 'Use the authenticator instead' : 'Use a recovery code';
      code.value = ''; code.focus();
    } }, 'Use a recovery code');
    const form = h('form', { class: 'stack', onSubmit: async (e) => {
      e.preventDefault();
      errorBox.hidden = true;
      busy(btn, true);
      try {
        await api('/api/v1/auth/mfa/verify', { method: 'POST', body: recovery ? { recoveryCode: code.value.trim() } : { code: code.value.replace(/\s/g, '') }, quiet: true });
        onDone();
      } catch (err) {
        fail(err);
        if (['unauthenticated', 'session_revoked', 'session_expired'].includes(err.code)) setTimeout(passwordStep, 1500);
      } finally { busy(btn, false); }
    } }, h('label', { class: 'field' }, label, code), errorBox, btn, toggle);
    draw([head('Two-step sign-in', 'Enter the 6-digit code for Fishtape HQ.'), form, signOutLink()]);
  }

  async function enrolStep() {
    draw([head('Set up two-step sign-in', 'HQ staff need an authenticator app (1Password, Google Authenticator, Authy…).'), h('p', { class: 'muted' }, 'Preparing…')]);
    let secret, uri;
    try {
      ({ secret, otpauthUri: uri } = await post('/api/v1/auth/mfa/totp/enrol'));
    } catch (err) { draw([head('Set up two-step sign-in'), errorBox, signOutLink()]); fail(err); return; }
    const grouped = secret.replace(/(.{4})/g, '$1 ').trim();
    const code = h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 8, required: true });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Turn on two-step sign-in');
    const form = h('form', { class: 'stack', onSubmit: async (e) => {
      e.preventDefault();
      errorBox.hidden = true;
      busy(btn, true);
      try {
        const r = await post('/api/v1/auth/mfa/totp/confirm', { code: code.value.replace(/\s/g, '') });
        recoveryStep(r.recoveryCodes);
      } catch (err) { fail(err); } finally { busy(btn, false); }
    } },
    h('ol', { class: 'hq-steps' },
      h('li', null, 'In your authenticator app, add an account by entering this key (time-based):'),
      h('li', { class: 'hq-secret mono', 'aria-label': 'Setup key' }, grouped),
      h('li', null, 'On a phone? ', h('a', { href: uri }, 'Open it in your authenticator app'), '.'),
      h('li', null, 'Enter the 6-digit code it shows.')),
    h('label', { class: 'field' }, h('span', null, 'Code'), code), errorBox, btn);
    draw([head('Set up two-step sign-in', 'HQ staff need an authenticator app (1Password, Google Authenticator, Authy…).'), form, signOutLink()]);
  }

  function recoveryStep(codes) {
    const list = h('ul', { class: 'hq-codes mono' }, codes.map((c) => h('li', null, c)));
    draw([
      head('Save your recovery codes', 'Each works once if you lose your phone. They are shown only now.'),
      list,
      h('div', { class: 'row' },
        ui.button('Download', { icon: 'download', onClick: () => ui.download('fishtape-hq-recovery-codes.txt', codes.join('\n') + '\n', 'text/plain') }),
        h('span', { class: 'grow' }),
        ui.button('I saved them', { variant: 'primary', onClick: onDone })),
    ]);
  }

  function notStaff() {
    draw([head('HQ staff only', 'This account is signed in but is not Fishtape HQ staff.'),
      h('div', { class: 'row' }, ui.button('Sign out', { variant: 'primary', icon: 'log-out', onClick: onSignOut }), ui.button('Open the app', { href: '/' }))]);
  }

  function offline() {
    draw([head('Cannot reach the API'), errorBox, ui.button('Try again', { variant: 'primary', onClick: onDone })]);
  }

  const signOutLink = () => h('button', { class: 'btn ghost sm hq-signout', type: 'button', onClick: onSignOut }, 'Use a different account');

  ({ password: passwordStep, verify: verifyStep, enrol: enrolStep, 'not-staff': notStaff, offline })[step]();
}

// "Talk to us" forms (services, about): post to the public lead endpoint, which creates a lead in
// HQ -> Leads and emails Fishtape. A [data-service-pick="<id>"] button picks that service in
// the form and moves to it.
import { LEAD_SERVICES } from '/site/site-lib.js';

const API = document.querySelector('meta[name="fishtape-api"]')?.content.replace(/\/$/, '') || '';

for (const b of document.querySelectorAll('[data-service-pick]')) {
  b.addEventListener('click', (e) => {
    const form = document.querySelector('form[data-lead-form]');
    const select = form?.querySelector('[name="service"]');
    if (!form) return;
    e.preventDefault();
    if (select && LEAD_SERVICES.includes(b.dataset.servicePick)) select.value = b.dataset.servicePick;
    form.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    form.querySelector('input[name="name"]')?.focus({ preventScroll: true });
  });
}

for (const form of document.querySelectorAll('form[data-lead-form]')) {
  const errorBox = form.querySelector('[data-error]');
  const done = document.getElementById(form.dataset.done || '');
  const button = form.querySelector('button[type=submit]');
  const label = button?.textContent || 'Send';
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (errorBox) errorBox.hidden = true;
    if (!form.reportValidity()) return;
    const data = Object.fromEntries(new FormData(form).entries());
    if (!LEAD_SERVICES.includes(data.service)) delete data.service;
    if (button) { button.disabled = true; button.textContent = 'Sending…'; }
    const fail = (text) => { if (errorBox) { errorBox.textContent = text; errorBox.hidden = false; } };
    try {
      const res = await fetch(`${API}/api/v1/public/enterprise-leads`, {
        method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Fishtape': '1' },
        body: JSON.stringify(data),
      });
      if (res.status === 202) {
        form.hidden = true;
        if (done) { done.hidden = false; done.focus?.(); }
        return;
      }
      const body = await res.json().catch(() => null);
      const code = body?.error?.code;
      fail(code === 'rate_limited' ? 'Too many messages from here. Please try again in an hour.'
        : code === 'validation_failed' ? 'Please check your name, email and company.'
          : 'Something went wrong. Please try again in a moment.');
    } catch {
      fail('We could not reach Fishtape. Check your connection and try again.');
    } finally {
      if (button) { button.disabled = false; button.textContent = label; }
    }
  });
}

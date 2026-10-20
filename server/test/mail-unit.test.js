// Mail building blocks without a database: the HTML sanitizer against an XSS corpus, SendGrid
// request building and error mapping (fake fetch, no network), signed-webhook verification,
// multipart and MIME parsing, threading keys, the image proxy's address checks and the
// download headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment } from 'parse5';
import { remoteImageUrls, safeHref, sanitizeDeclarations, sanitizeHtml, sanitizeStylesheet, textToSafeHtml, htmlToText } from '../src/email/sanitize.js';
import { mailSendBody, sendMail, testSendgrid } from '../src/integrations/sendgrid.js';
import { setFetch } from '../src/integrations/http.js';
import { normaliseEvent, verifySignedRequest } from '../src/email/events.js';
import { parseMultipart, boundaryOf } from '../src/email/multipart.js';
import { parseMime, parseRefs, safeFilename, subjectKey } from '../src/email/mime.js';
import { isPublicAddress, sniffImage } from '../src/email/image-proxy.js';
import { downloadHeaders } from '../src/routes/hq-mail.js';
import { tokenMatches, createSupportLimiter } from '../src/routes/mail-webhooks.js';
import { readPublicKey } from '../src/email/config.js';
import { redactUrl } from '../src/logger.js';
import { decodeScreenshot, supportPayload } from '../src/email/support.js';
import { SAMPLE_MIME, keys, multipartBody, signWith } from './support/mail.js';

// ---- the sanitizer ---------------------------------------------------------------------------

const XSS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)><circle r=1></circle></svg>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href="JaVaScRiPt:alert(1)">x</a>',
  '<a href="&#106;avascript:alert(1)">x</a>',
  '<a href="java&#x09;script:alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  '<a href="javascript&colon;alert(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="x.swf">',
  '<form action="javascript:alert(1)"><input type=submit value=go></form>',
  '<body onload=alert(1)><p>hi</p></body>',
  '<div style="background:url(javascript:alert(1))">x</div>',
  '<div style="width:expression(alert(1))">x</div>',
  '<div style="behavior:url(x.htc);-moz-binding:url(x.xml#xss)">x</div>',
  '<style>@import \'http://evil.example/x.css\';</style><p>x</p>',
  '<style>body{background:url("http://evil.example/t.gif")} p{color:red}</style><p>x</p>',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<base href="javascript:alert(1)//"><a href="/x">x</a>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  '<svg><style><img src=x onerror=alert(1)></style></svg>',
  '<template><img src=x onerror=alert(1)></template>',
  '<!--<img src=x onerror=alert(1)>-->',
  '<img src="x" style="x:expression(alert(1))">',
  '<a href="https://ok.example" onclick="alert(1)">ok</a>',
  '<details open ontoggle=alert(1)><summary>s</summary></details>',
  '<video><source onerror=alert(1)></video>',
  '<audio src=x onerror=alert(1)></audio>',
  '<link rel=stylesheet href=http://evil.example/x.css>',
  '<xmp><img src=x onerror=alert(1)></xmp>',
  '<p title=""><script>alert(1)</script>">x</p>',
  '<img src=x:alert(1) onerror=eval(src)>',
  '<div data-ft-style="background:url(http://evil.example/)" style="color:blue">x</div>',
  '<img data-ft-blocked=0 src="https://tracker.example/p.gif" width=1 height=1>',
  '<a href="https://ok.example" target="_top">x</a>',
  '<isindex action=javascript:alert(1) type=image>',
  '<keygen autofocus onfocus=alert(1)>',
  '<marquee onstart=alert(1)>x</marquee>',
  '<table background="javascript:alert(1)"><tr><td background="http://evil.example/bg.png">x</td></tr></table>',
  '<img srcset="http://evil.example/x 1x" src="cid:nope">',
  '<svg><a xlink:href="javascript:alert(1)"><text x=1 y=1>x</text></a></svg>',
  '<math><maction actiontype="statusline" xlink:href="javascript:alert(1)">x</maction></math>',
  '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">',
  '<p style="color: red; } body { display:none">x</p>',
  '<a href="https://ok.example/?q=&quot;><script>alert(1)</script>">x</a>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<<script>script>alert(1)<</script>/script>',
  '<img """><script>alert(1)</script>">',
  '<p><img src="https://x.example/a.png" alt="&quot; onerror=&quot;alert(1)"></p>',
  '<textarea><script>alert(1)</script></textarea>',
  '<select><option><img src=x onerror=alert(1)></option></select>',
  '<frameset onload=alert(1)>',
  '<portal src="https://evil.example"></portal>',
  '<dialog open onclose=alert(1)>x</dialog>',
  '<input onfocus=alert(1) autofocus>',
  '<button formaction="javascript:alert(1)">x</button>',
  '<a href="https://ok.example/\u0000javascript:alert(1)">x</a>',
  '<div id="x" name="y" class="ok bad\'class" onmouseover="alert(1)">x</div>',
  '<font face="Arial" color="red" size="3" onmouseover="alert(1)">x</font>',
];

const OUT_TAGS = new Set(['a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code',
  'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small', 'span', 'strike', 'strong',
  'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr']);
const OUT_ATTRS = new Set(['href', 'target', 'rel', 'src', 'alt', 'title', 'width', 'height', 'align', 'valign', 'bgcolor', 'border', 'cellpadding', 'cellspacing',
  'colspan', 'rowspan', 'dir', 'lang', 'nowrap', 'scope', 'abbr', 'span', 'color', 'face', 'size', 'start', 'type', 'reversed', 'value', 'headers', 'datetime',
  'open', 'class', 'data-ft-style', 'data-ft-blocked']);

/** Parse the output the way the browser will and check every element, attribute and URL. */
function assertSafe(html, label) {
  const walk = (node) => {
    for (const c of node.childNodes || []) {
      if (!c.tagName) continue;
      assert.ok(OUT_TAGS.has(c.tagName), `${label}: unexpected <${c.tagName}>`);
      assert.equal(c.namespaceURI, 'http://www.w3.org/1999/xhtml', `${label}: foreign element`);
      for (const a of c.attrs) {
        assert.ok(OUT_ATTRS.has(a.name), `${label}: unexpected attribute ${a.name}`);
        assert.ok(!/^on/i.test(a.name), `${label}: event handler`);
        if (a.name === 'href') assert.match(a.value, /^(https?:|mailto:|tel:)/, `${label}: href scheme`);
        if (a.name === 'src') assert.match(a.value, /^(data:image\/(png|gif|jpeg|webp);base64,|\/api\/hq\/mail\/)/, `${label}: src`);
        if (a.name === 'target') assert.equal(a.value, '_blank');
        if (a.name === 'data-ft-style') assert.ok(!/url\(|expression|javascript|behavio|binding|@import/i.test(a.value), `${label}: style ${a.value}`);
        if (a.name !== 'href') assert.ok(!/javascript:|vbscript:/i.test(a.value), `${label}: script URL in ${a.name}`);
      }
      if (c.tagName === 'a' && c.attrs.some((a) => a.name === 'href')) {
        assert.ok(c.attrs.some((a) => a.name === 'rel' && /noopener/.test(a.value)), `${label}: link without noopener`);
        assert.ok(c.attrs.some((a) => a.name === 'target' && a.value === '_blank'), `${label}: link not in a new tab`);
      }
      walk(c);
    }
  };
  walk(parseFragment(html));
}

test('XSS corpus: output only contains allow-listed elements, attributes and URLs', () => {
  for (const input of XSS) {
    for (const opts of [{}, { images: 'allow', imageUrl: (n) => `/api/hq/mail/messages/x/images/${n}` }]) {
      const r = sanitizeHtml(input, opts);
      assertSafe(r.html, input);
      assert.ok(!/<script|<iframe|<object|<embed|<svg|<math|<style|<meta|<base|<link|<form|<input|<template/i.test(r.html), `${input} -> ${r.html}`);
      assert.ok(!/url\(|@import|expression/i.test(r.css), `${input} css -> ${r.css}`);
    }
    const c = sanitizeHtml(input, { mode: 'compose' });
    assertSafe(c.html, `compose ${input}`);
    assert.ok(!/data-ft-style|class=/.test(c.html), 'compose mode keeps no styles');
  }
});

test('the sanitizer keeps ordinary email formatting', () => {
  const html = '<html><head><style>.hi{color:#c00;font-weight:bold} @media (max-width: 600px){.hi{font-size:14px}}</style></head>'
    + '<body bgcolor="#ffffff" style="margin:0"><table width="100%" cellpadding="4"><tr><td align="center" style="padding:8px;color:#333">'
    + '<p class="hi">Hello <b>Kelvin</b>, see <a href="https://fishtapehq.com/x?a=1&amp;b=2">this</a>.</p><ul><li>one</li></ul></td></tr></table></body></html>';
  const r = sanitizeHtml(html);
  assert.match(r.html, /<table width="100%" cellpadding="4"><tbody><tr><td align="center" data-ft-style="padding: 8px; color: #333">/);
  assert.match(r.html, /<p class="hi">Hello <b>Kelvin<\/b>, see <a href="https:\/\/fishtapehq\.com\/x\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">this<\/a>/);
  assert.equal(r.css, '.hi{color: #c00; font-weight: bold}@media (max-width: 600px){.hi{font-size: 14px}}');
  assert.equal(r.bodyStyle, 'background-color: #ffffff; margin: 0');
});

test('remote images are blocked, tracking pixels stripped, and "Show images" goes through the proxy by index', () => {
  const html = '<p><img src="https://cdn.example/logo.png" alt="Logo"><img src="https://t.example/open.gif" width="1" height="1">'
    + '<img src="https://cdn.example/2.png" style="display:none"><img src="cid:part1@x" alt="inline"></p>';
  const blocked = sanitizeHtml(html, { cid: (id) => (id === 'part1@x' ? 'data:image/png;base64,iVBORw0KGgo=' : null) });
  assert.equal(blocked.blockedImages, 1);
  assert.equal(blocked.trackers, 2);
  assert.ok(!/cdn\.example|t\.example/.test(blocked.html), 'no remote URL reaches the page');
  assert.match(blocked.html, /<img alt="Logo" data-ft-blocked="1">/);
  assert.match(blocked.html, /<img src="data:image\/png;base64,iVBORw0KGgo=" alt="inline">/);
  const allowed = sanitizeHtml(html, { images: 'allow', imageUrl: (n) => `/api/hq/mail/messages/m1/images/${n}` });
  assert.match(allowed.html, /src="\/api\/hq\/mail\/messages\/m1\/images\/0" alt="Logo"/);
  assert.match(allowed.html, /images\/1"/);
  assert.deepEqual(remoteImageUrls(html), ['https://cdn.example/logo.png', 'https://t.example/open.gif', 'https://cdn.example/2.png']);
});

test('CSS: only safe declarations and plain rules survive', () => {
  assert.equal(sanitizeDeclarations('color: red; position: fixed; top: 0; background: url(x); font-size: 12px !important'), 'color: red; top: 0; font-size: 12px');
  assert.equal(sanitizeDeclarations('display: none; display: grid'), 'display: none');
  assert.equal(sanitizeStylesheet('@font-face{src:url(x)} @import "x"; a{color:blue} @keyframes k{from{color:red}} @media screen{b{color:red}} x[y="}"]{color:red}'),
    'a{color: blue}@media screen{b{color: red}}');
  assert.equal(safeHref('  https://x.example/a '), 'https://x.example/a');
  assert.equal(safeHref('java\nscript:alert(1)'), null);
  assert.equal(safeHref('/relative'), null);
});

test('plain text is escaped and linked; HTML converts to text', () => {
  const h = textToSafeHtml('Hi <b>there</b>\nsee https://fishtapehq.com/a?b=1&c=2 ok');
  assert.match(h, /^<div class="ft-text">Hi &lt;b&gt;there&lt;\/b&gt;\nsee <a href="https:\/\/fishtapehq\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">/);
  assert.equal(htmlToText('<p>Hello <a href="https://x.example/">link</a></p><ul><li>a</li><li>b</li></ul><script>bad()</script>'), 'Hello link (https://x.example/)\n\n- a\n- b');
});

// ---- SendGrid Mail Send ---------------------------------------------------------------------

test('Mail Send body: personalization custom_args, text before html, no click tracking, reserved headers dropped', () => {
  const b = mailSendBody({
    from: 'Fishtape <no-reply@fishtapehq.com>', to: ['A <a@example.com>', 'b@example.com'], cc: ['b@example.com', 'c@example.com'], bcc: 'd@example.com',
    replyTo: 'support@inbox.fishtapehq.com', subject: 'Hi\r\nBcc: x@evil.example', text: 'hello', html: '<p>hello</p>',
    headers: { 'Message-ID': '<m1@fishtapehq.com>', 'In-Reply-To': '<x@y>', To: 'evil@example.com', 'Bad Header': 'x', 'X-Evil': 'a\r\nBcc: x@evil.example' },
    attachments: [{ content: 'aGk=', filename: '../../etc/passwd', type: 'text/plain' }], categories: Array.from({ length: 12 }, (_, i) => `c${i}`),
    customArgs: { ft_outbox_id: '7d4c3a1e-0000-4000-8000-000000000001', ft_env: 'test' },
  });
  assert.deepEqual(b.from, { email: 'no-reply@fishtapehq.com', name: 'Fishtape' });
  assert.deepEqual(b.personalizations[0].to, [{ email: 'a@example.com', name: 'A' }, { email: 'b@example.com' }]);
  assert.deepEqual(b.personalizations[0].cc, [{ email: 'c@example.com' }], 'a duplicate recipient is dropped (SendGrid refuses duplicates)');
  assert.deepEqual(b.personalizations[0].custom_args, { ft_outbox_id: '7d4c3a1e-0000-4000-8000-000000000001', ft_env: 'test' });
  assert.equal(b.subject, 'Hi Bcc: x@evil.example', 'no header injection through the subject');
  assert.deepEqual(b.content.map((c) => c.type), ['text/plain', 'text/html']);
  assert.equal(b.tracking_settings.click_tracking.enable, false);
  assert.equal(b.tracking_settings.open_tracking.enable, false);
  assert.deepEqual(Object.keys(b.headers).sort(), ['In-Reply-To', 'Message-ID', 'X-Evil']);
  assert.ok(!/[\r\n]/.test(b.headers['X-Evil']));
  assert.equal(b.categories.length, 10);
  assert.equal(b.attachments[0].filename, '.._.._etc_passwd');
  assert.throws(() => mailSendBody({ from: 'x', to: 'a@example.com', subject: 's' }), /sender/);
  assert.throws(() => mailSendBody({ from: 'a@fishtapehq.com', to: 'nope', subject: 's' }), /recipient/);
});

test('sendMail posts to /v3/mail/send with the key and returns X-Message-Id; errors map to retry or not', async () => {
  const calls = [];
  const reply = { status: 202, body: '', headers: { 'x-message-id': 'abc123XYZ' } };
  setFetch(async (url, init) => {
    calls.push({ url, init });
    return new Response(reply.body || null, { status: reply.status, headers: reply.headers });
  });
  try {
    const r = await sendMail({ apiKey: 'SG.test', from: 'no-reply@fishtapehq.com', to: 'a@example.com', subject: 's', text: 't' });
    assert.equal(r.id, 'abc123XYZ');
    assert.equal(calls[0].url, 'https://api.sendgrid.com/v3/mail/send');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.authorization, 'Bearer SG.test');
    assert.equal(calls[0].init.redirect, 'error');

    const expect = async (status, json, check) => {
      Object.assign(reply, { status, body: JSON.stringify(json), headers: { 'content-type': 'application/json' } });
      await assert.rejects(sendMail({ apiKey: 'SG.test', from: 'no-reply@fishtapehq.com', to: 'a@example.com', subject: 's', text: 't' }), check);
    };
    await expect(401, { errors: [{ message: 'The provided authorization grant is invalid, expired, or revoked' }] }, (e) => e.kind === 'auth' && !e.retry);
    await expect(403, { errors: [{ message: 'The from address does not match a verified Sender Identity.' }] }, (e) => e.kind === 'invalid' && /Sender Authentication/.test(e.message) && !e.retry);
    await expect(403, { errors: [{ message: 'access forbidden' }] }, (e) => e.kind === 'auth' && /Mail Send/.test(e.message));
    await expect(413, { errors: [{ message: 'too big' }] }, (e) => !e.retry && /30 MB/.test(e.message));
    await expect(429, { errors: [{ message: 'too many requests' }] }, (e) => e.retry === true);
    await expect(503, { errors: [] }, (e) => e.retry === true);
    await expect(400, { errors: [{ message: 'Invalid email bob@example.com', field: 'personalizations.0.to' }] }, (e) => !e.retry && !/bob@example\.com/.test(e.message));
  } finally {
    setFetch(null);
  }
});

test('testSendgrid reads /v3/scopes and reports what the key can do', async () => {
  let scopes = ['mail.send'];
  setFetch(async (url) => {
    if (url.endsWith('/v3/scopes')) return Response.json({ scopes });
    if (url.endsWith('/v3/whitelabel/domains')) return Response.json([{ domain: 'tgelectrical.ca', valid: true }]);
    return new Response('', { status: 404 });
  });
  try {
    assert.equal((await testSendgrid({ apiKey: 'SG.x', from: 'TG <office@tgelectrical.ca>' })).status, 'ok');
    scopes = ['mail.send', 'whitelabel.read'];
    assert.match((await testSendgrid({ apiKey: 'SG.x', from: 'TG <office@tgelectrical.ca>' })).message, /authenticated/);
    assert.equal((await testSendgrid({ apiKey: 'SG.x', from: 'office@other.example' })).status, 'warning');
    scopes = ['alerts.read'];
    assert.equal((await testSendgrid({ apiKey: 'SG.x', from: 'office@tgelectrical.ca' })).status, 'error');
  } finally {
    setFetch(null);
  }
});

// ---- signed webhooks ----------------------------------------------------------------------

test('signed event requests: valid passes; forged, altered, unsigned, stale and future requests fail', () => {
  const k = keys();
  const other = keys();
  const pub = readPublicKey(k.publicB64);
  const pem = readPublicKey(`-----BEGIN PUBLIC KEY-----\n${k.publicB64}\n-----END PUBLIC KEY-----`);
  const now = Date.now();
  const ts = String(Math.floor(now / 1000));
  const body = '[{"event":"delivered","sg_event_id":"e1"}]';
  const sig = signWith(k.privateKey, ts, body);
  assert.deepEqual(verifySignedRequest(pub, Buffer.from(body), sig, ts, { now }), { ok: true });
  assert.deepEqual(verifySignedRequest(pem, body, sig, ts, { now }), { ok: true });
  assert.equal(verifySignedRequest(pub, body, signWith(other.privateKey, ts, body), ts, { now }).reason, 'bad_signature');
  assert.equal(verifySignedRequest(pub, body.replace('delivered', 'bounce'), sig, ts, { now }).reason, 'bad_signature');
  assert.equal(verifySignedRequest(pub, body, sig, String(Number(ts) + 1), { now }).reason, 'bad_signature');
  assert.equal(verifySignedRequest(pub, body, undefined, ts, { now }).reason, 'unsigned');
  assert.equal(verifySignedRequest(pub, body, sig, undefined, { now }).reason, 'unsigned');
  assert.equal(verifySignedRequest(pub, body, 'not base64 !!!', ts, { now }).reason, 'bad_signature');
  const old = String(Math.floor(now / 1000) - 3600);
  assert.equal(verifySignedRequest(pub, body, signWith(k.privateKey, old, body), old, { now }).reason, 'stale');
  const future = String(Math.floor(now / 1000) + 3600);
  assert.equal(verifySignedRequest(pub, body, signWith(k.privateKey, future, body), future, { now }).reason, 'stale');
  assert.equal(verifySignedRequest(null, body, sig, ts, { now }).reason, 'not_configured');
  assert.equal(readPublicKey('not a key'), null);
});

test('events: our custom args pick the outbox row; other environments and junk are ignored; reasons carry no addresses', () => {
  const id = '7d4c3a1e-0000-4000-8000-000000000001';
  const e = normaliseEvent({ sg_event_id: 's1', event: 'bounce', type: 'bounce', status: '5.1.1', reason: '550 5.1.1 <bob@example.com>: Recipient address rejected', email: 'Bob@Example.com', timestamp: 1760000000, ft_outbox_id: id, ft_env: 'test' }, { appEnv: 'test' });
  assert.equal(e.outboxId, id);
  assert.equal(e.recipient, 'bob@example.com');
  assert.equal(e.status, 'bounce');
  assert.ok(!e.reason.includes('bob@example.com'));
  assert.equal(e.reason, 'Bounced (5.1.1): 550 5.1.1 <[email]>: Recipient address rejected');
  assert.equal(normaliseEvent({ sg_event_id: 's2', event: 'bounce', type: 'blocked', reason: 'x' }).status, 'blocked');
  assert.deepEqual(normaliseEvent({ sg_event_id: 's3', event: 'delivered', ft_env: 'production' }, { appEnv: 'staging' }), { skip: 'other_environment' });
  assert.equal(normaliseEvent({ event: 'delivered' }), null);
  assert.equal(normaliseEvent({ sg_event_id: 's4', event: 'DROP TABLE' }), null);
  assert.equal(normaliseEvent({ sg_event_id: 's5', event: 'delivered', ft_outbox_id: 'not-a-uuid' }).outboxId, null);
});

// ---- inbound parsing ------------------------------------------------------------------------

test('multipart/form-data: fields by name, first one wins, malformed bodies refused', () => {
  const { body, contentType } = multipartBody({ email: 'raw', spam_score: '1.2', envelope: '{"to":["a@b.c"]}' });
  const f = parseMultipart(body, contentType);
  assert.equal(f.get('email').value.toString(), 'raw');
  assert.equal(f.get('spam_score').value.toString(), '1.2');
  assert.equal(boundaryOf('multipart/form-data; charset=utf-8; boundary="a b"'), 'a b');
  assert.equal(boundaryOf('application/json'), null);
  assert.throws(() => parseMultipart(Buffer.from('--xYzZY\r\nno end'), contentType));
  assert.throws(() => parseMultipart(body, 'text/plain'));
});

test('raw MIME: addresses, threading headers, decoded subject, attachments with safe names', async () => {
  const m = await parseMime(Buffer.from(SAMPLE_MIME));
  assert.equal(m.messageId, 'msg-1@example.com');
  assert.equal(m.inReplyTo, 'out-1@fishtapehq.com');
  assert.deepEqual(m.references, ['root@fishtapehq.com', 'out-1@fishtapehq.com']);
  assert.equal(m.subject, 'Panel question ⚡');
  assert.deepEqual(m.from, { name: 'Bob Builder', address: 'bob@example.com' });
  assert.deepEqual(m.cc, [{ name: '', address: 'carol@example.com' }]);
  assert.equal(m.date, '2026-10-19T16:00:00.000Z');
  assert.match(m.text, /breaker trips/);
  assert.match(m.html, /<b>breaker<\/b>/);
  const names = m.attachments.map((a) => a.filename);
  assert.deepEqual(names, ['logo.png', '_quote.pdf', 'evil.html']);
  assert.equal(m.attachments[0].contentId, 'logo@x');
  assert.equal(m.attachments[0].inline, true);
  assert.equal(m.attachments[1].contentType, 'application/pdf');
  assert.equal(Buffer.from(m.attachments[1].bytes).toString('latin1').slice(0, 8), '%PDF-1.4');
});

test('threading keys and file names', () => {
  assert.equal(subjectKey('RE: Fwd: AW:  [Fishtape] Panel   question'), 'panel question');
  assert.equal(subjectKey('Re[2]: Hello'), 'hello');
  assert.deepEqual(parseRefs('<a@x> <b@y>\r\n <a@x>'), ['a@x', 'b@y']);
  assert.deepEqual(parseRefs('plain@id'), ['plain@id']);
  assert.equal(safeFilename('', 'application/pdf'), 'attachment.pdf');
  assert.equal(safeFilename('a/b\\c:d*e?.txt'), 'a_b_c_d_e_.txt');
  assert.equal(safeFilename('.htaccess'), 'htaccess');
  assert.ok(safeFilename(`${'x'.repeat(300)}.pdf`).endsWith('.pdf'));
});

// ---- image proxy, downloads, tokens, logs ---------------------------------------------------

test('image proxy: only public addresses; only real raster images', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.ok(isPublicAddress(ip), ip);
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::',
    'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a9fe:a9fe', '2001:db8::1', 'ff02::1', 'localhost', '', '203.0.113.5']) {
    assert.ok(!isPublicAddress(ip), ip);
  }
  assert.equal(sniffImage(Buffer.from('89504e470d0a1a0a0000', 'hex')), 'image/png');
  assert.equal(sniffImage(Buffer.from('ffd8ffe0', 'hex')), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(sniffImage(Buffer.from('RIFF0000WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(Buffer.from('<svg onload=alert(1)>')), null);
  assert.equal(sniffImage(Buffer.from('<html>')), null);
});

test('downloads: always an attachment, nosniff, sandboxed, and an inert type', () => {
  const h = downloadHeaders('report "final".pdf', 'application/pdf');
  assert.equal(h['content-type'], 'application/pdf');
  assert.equal(h['content-disposition'], 'attachment; filename="report _final_.pdf"; filename*=UTF-8\'\'report%20_final_.pdf');
  assert.equal(h['x-content-type-options'], 'nosniff');
  assert.match(h['content-security-policy'], /sandbox/);
  for (const t of ['text/html', 'image/svg+xml', 'application/javascript', 'text/xml', 'application/xhtml+xml', 'message/rfc822']) {
    assert.equal(downloadHeaders('x', t)['content-type'], 'application/octet-stream', t);
  }
  assert.match(downloadHeaders('Ölplan ⚡.pdf', 'application/pdf')['content-disposition'], /filename="_lplan _\.pdf"; filename\*=UTF-8''%C3%96lplan%20%E2%9A%A1\.pdf/);
});

test('inbound token comparison, support limits, screenshots and log redaction', () => {
  assert.ok(tokenMatches('s3cret-token', 's3cret-token'));
  assert.ok(!tokenMatches('s3cret-tokeX', 's3cret-token'));
  assert.ok(!tokenMatches('short', 's3cret-token'));
  assert.ok(!tokenMatches('anything', ''));
  assert.ok(!tokenMatches(undefined, 'x'));
  let t = 0;
  const allow = createSupportLimiter({ perHour: 2, perDay: 3, now: () => t });
  assert.ok(allow('u') && allow('u'));
  assert.ok(!allow('u'));
  t += 3_600_001;
  assert.ok(allow('u'));
  assert.ok(!allow('u'), 'the daily cap holds');
  assert.ok(allow('other'));
  assert.equal(redactUrl('/api/v1/webhooks/sendgrid/inbound/abc-123'), '/api/v1/webhooks/sendgrid/inbound/[REDACTED]');
  assert.equal(decodeScreenshot(''), null);
  assert.equal(decodeScreenshot('data:image/png;base64,iVBORw0KGgo=').contentType, 'image/png');
  assert.throws(() => decodeScreenshot('data:text/html;base64,PHA+'), /PNG, JPEG or WebP/);
  const p = supportPayload({
    reference: 'FT-ABCDEF', user: { id: 'u1', name: 'Sam Sparks', email: 'sam@example.com' }, tenant: { id: 't1', name: 'TG Electrical', plan: 'pro' },
    role: 'office', body: { subject: 'Invoice PDF', message: 'It is blank', category: 'problem', appVersion: '1.4.2', page: '#/invoices' },
    userAgent: 'Mozilla/5.0', screenshot: null, domain: 'fishtapehq.com', now: new Date('2026-10-19T00:00:00Z'),
  });
  assert.equal(p.message.subject, '[FT-ABCDEF] Invoice PDF');
  assert.equal(p.message.messageId, 'support-ft-abcdef@fishtapehq.com');
  assert.match(p.message.text, /Company: TG Electrical \(t1\), plan pro/);
  assert.match(p.message.text, /App version: 1\.4\.2/);
  assert.deepEqual(p.message.replyTo, [{ name: 'Sam Sparks', address: 'sam@example.com' }]);
});

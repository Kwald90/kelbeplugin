// Mail test helpers: Inbound Parse form bodies, a sample raw MIME message, and SendGrid-style
// ECDSA keys and signatures for the signed webhooks.
import { generateKeyPairSync, sign } from 'node:crypto';

export function multipartBody(fields, boundary = 'xYzZY') {
  const parts = Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  return { body: Buffer.from(`${parts.join('')}--${boundary}--\r\n`), contentType: `multipart/form-data; boundary=${boundary}` };
}

export const SAMPLE_MIME = [
  'From: "Bob Builder" <bob@example.com>',
  'To: Support <support@inbox.fishtapehq.com>',
  'Cc: carol@example.com',
  'Subject: =?UTF-8?Q?Panel_question_=E2=9A=A1?=',
  'Message-ID: <msg-1@example.com>',
  'In-Reply-To: <out-1@fishtapehq.com>',
  'References: <root@fishtapehq.com> <out-1@fishtapehq.com>',
  'Date: Mon, 19 Oct 2026 10:00:00 -0600',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="MIX"',
  '',
  '--MIX',
  'Content-Type: multipart/related; boundary="REL"',
  '',
  '--REL',
  'Content-Type: multipart/alternative; boundary="ALT"',
  '',
  '--ALT',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello, the breaker trips.',
  '--ALT',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p onclick="x()">Hello, the <b>breaker</b> trips.<img src="cid:logo@x"><img src="https://tracker.example/o.gif" width="1" height="1"></p>',
  '--ALT--',
  '--REL',
  'Content-Type: image/png',
  'Content-ID: <logo@x>',
  'Content-Disposition: inline; filename="logo.png"',
  'Content-Transfer-Encoding: base64',
  '',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  '--REL--',
  '--MIX',
  'Content-Type: application/pdf; name="quote.pdf"',
  'Content-Disposition: attachment; filename="../quote.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  'JVBERi0xLjQKJcfsj6IK',
  '--MIX',
  'Content-Type: text/html; name="evil.html"',
  'Content-Disposition: attachment; filename="evil.html"',
  '',
  '<script>alert(1)</script>',
  '--MIX--',
  '',
].join('\r\n');

/** A P-256 key pair; publicB64 is what SendGrid shows as the verification key (SPKI, base64). */
export function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, publicB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}
export const signWith = (privateKey, ts, body) => sign('sha256', Buffer.concat([Buffer.from(ts), Buffer.from(body)]), privateKey).toString('base64');

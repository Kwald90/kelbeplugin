// A small multipart/form-data reader for SendGrid Inbound Parse posts. The body arrives as one
// Buffer (the route caps its size), because the optional inbound signature covers the exact
// bytes. Only the first part with each name is kept; at most `maxParts` parts are read.

const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');

export class MultipartError extends Error {}

/** The boundary from a Content-Type header, or null. */
export function boundaryOf(contentType) {
  const m = /^multipart\/form-data\s*;(?:.*;)?\s*boundary=(?:"([^"]{1,70})"|([^;\s"]{1,70}))/i.exec(String(contentType || ''));
  return m ? m[1] || m[2] : null;
}

/**
 * @param {Buffer} buf
 * @param {string} contentType
 * @returns {Map<string, { value: Buffer, filename: string|null, contentType: string|null }>}
 */
export function parseMultipart(buf, contentType, { maxParts = 100 } = {}) {
  const b = boundaryOf(contentType);
  if (!b) throw new MultipartError('not multipart/form-data');
  const delim = Buffer.from(`--${b}`);
  const next = Buffer.concat([CRLF, delim]);
  const fields = new Map();
  let pos = buf.indexOf(delim);
  if (pos < 0) throw new MultipartError('no boundary in body');
  let parts = 0;
  for (;;) {
    pos += delim.length;
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // closing "--"
    if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2;
    else throw new MultipartError('malformed boundary line');
    if (++parts > maxParts) throw new MultipartError('too many parts');
    const headerEnd = buf.indexOf(HEADER_END, pos);
    if (headerEnd < 0 || headerEnd - pos > 16 * 1024) throw new MultipartError('malformed part headers');
    const head = buf.subarray(pos, headerEnd).toString('utf8');
    const end = buf.indexOf(next, headerEnd + 4);
    if (end < 0) throw new MultipartError('unterminated part');
    const disposition = /^content-disposition:\s*form-data\s*(;.*)$/im.exec(head)?.[1] || '';
    const name = /;\s*name="([^"]{1,200})"/i.exec(disposition)?.[1] ?? /;\s*name=([^;\s"]{1,200})/i.exec(disposition)?.[1];
    const filename = /;\s*filename="([^"]{0,300})"/i.exec(disposition)?.[1] ?? null;
    const ctype = /^content-type:\s*([^\r\n]{1,200})$/im.exec(head)?.[1]?.trim() || null;
    if (name && !fields.has(name)) fields.set(name, { value: buf.subarray(headerEnd + 4, end), filename, contentType: ctype });
    pos = end + 2;
  }
  return fields;
}

/** A text field as a string (UTF-8), or '' when absent. */
export function textField(fields, name, max = 64 * 1024) {
  const f = fields.get(name);
  return f ? f.value.subarray(0, max).toString('utf8') : '';
}

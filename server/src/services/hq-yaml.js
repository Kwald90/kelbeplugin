// A small YAML reader for compliance/controls.yaml (no dependency). Supports what a
// hand-written config uses: block mappings and sequences (including "- key: value" items
// and sequences at the parent key's indent), flow [lists] and {maps}, single and double
// quoted strings, literal (|) and folded (>) block scalars, comments, numbers, booleans
// and null. Anchors, tags and multi-document files are not supported (they throw).

export class YamlError extends Error {
  constructor(message, line) { super(line ? `line ${line}: ${message}` : message); this.line = line; }
}

/** Strip a trailing comment that is outside quotes. */
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') { i++; continue; }
      if (c === q) { if (q === "'" && s[i + 1] === "'") { i++; continue; } q = null; }
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s[{,:]/.test(s[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s.trimEnd();
}

function unquoteDouble(s, line) {
  try { return JSON.parse(s.replace(/\\'/g, "'").replace(/\t/g, '\\t')); } catch { throw new YamlError('bad double-quoted string', line); }
}

function plainScalar(s) {
  const v = s.trim();
  if (v === '' || v === '~' || /^null$/i.test(v)) return null;
  if (/^(true|yes|on)$/i.test(v)) return /^true$/i.test(v) ? true : v;
  if (/^(false|no|off)$/i.test(v)) return /^false$/i.test(v) ? false : v;
  if (/^[-+]?\d+$/.test(v) && Math.abs(Number(v)) <= Number.MAX_SAFE_INTEGER) return Number(v);
  if (/^[-+]?(\d+\.\d*|\.\d+)([eE][-+]?\d+)?$/.test(v)) return Number(v);
  return v;
}

/** Parse a flow collection or scalar starting at s[i]. Returns [value, nextIndex]. */
function parseFlow(s, i, line) {
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  ws();
  const c = s[i];
  if (c === '[' || c === '{') {
    const close = c === '[' ? ']' : '}';
    const out = c === '[' ? [] : {};
    i++;
    ws();
    if (s[i] === close) return [out, i + 1];
    for (;;) {
      ws();
      if (c === '[') {
        const [v, j] = parseFlow(s, i, line); out.push(v); i = j;
      } else {
        const [k, j] = parseFlow(s, i, line, true); i = j; ws();
        if (s[i] !== ':') throw new YamlError('expected ":" in flow mapping', line);
        i++;
        const [v, j2] = parseFlow(s, i, line); out[String(k)] = v; i = j2;
      }
      ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === close) return [out, i + 1];
      throw new YamlError(`expected "," or "${close}"`, line);
    }
  }
  if (c === '"') {
    let j = i + 1;
    while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
    if (j >= s.length) throw new YamlError('unclosed string', line);
    return [unquoteDouble(s.slice(i, j + 1), line), j + 1];
  }
  if (c === "'") {
    let j = i + 1, out = '';
    for (;;) {
      if (j >= s.length) throw new YamlError('unclosed string', line);
      if (s[j] === "'") { if (s[j + 1] === "'") { out += "'"; j += 2; continue; } break; }
      out += s[j++];
    }
    return [out, j + 1];
  }
  // plain scalar inside flow: up to , ] } or ": "
  let j = i;
  while (j < s.length && !/[,\]}]/.test(s[j]) && !(s[j] === ':' && /[\s,\]}]|$/.test(s[j + 1] ?? ''))) j++;
  return [plainScalar(s.slice(i, j)), j];
}

function scalar(text, line) {
  const t = text.trim();
  if (t.startsWith('[') || t.startsWith('{') || t.startsWith('"') || t.startsWith("'")) {
    const [v, j] = parseFlow(t, 0, line);
    if (t.slice(j).trim()) throw new YamlError('unexpected text after value', line);
    return v;
  }
  if (/^[&*!]/.test(t)) throw new YamlError('anchors, aliases and tags are not supported', line);
  return plainScalar(t);
}

/** Find "key: rest" (key may be quoted). Returns null when the line is not a mapping entry. */
function splitKey(text) {
  let key, rest;
  if (text.startsWith('"') || text.startsWith("'")) {
    const [k, j] = parseFlow(text, 0, 0);
    if (text[j] !== ':' || !(j + 1 >= text.length || /\s/.test(text[j + 1]))) return null;
    key = String(k); rest = text.slice(j + 1);
  } else {
    const m = /^([^\s#][^:]*?)\s*:(\s+|$)(.*)$/.exec(text);
    if (!m || m[1].startsWith('- ') || m[1] === '-') return null;
    if (m[1].startsWith('[') || m[1].startsWith('{')) return null;
    key = m[1]; rest = m[3];
  }
  return { key, rest: rest.trim() };
}

export function parseYaml(src) {
  const raw = String(src).replace(/^﻿/, '').split(/\r?\n/);
  const lines = [];
  for (let n = 0; n < raw.length; n++) {
    const r = raw[n];
    if (/^\t/.test(r)) throw new YamlError('tabs are not allowed for indentation', n + 1);
    const text = stripComment(r);
    const indent = r.length - r.trimStart().length;
    lines.push({ n: n + 1, raw: r, indent, text: text.trim(), blank: text.trim() === '' });
  }
  let pos = 0;
  const skipBlank = () => { while (pos < lines.length && (lines[pos].blank || /^(---|\.\.\.)\s*$/.test(lines[pos].text))) pos++; };

  function blockScalar(header, parentIndent) {
    const style = header[0];
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const body = [];
    let ind = null;
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.raw.trim() === '') { body.push(''); pos++; continue; }
      if (l.indent <= parentIndent) break;
      if (ind == null) ind = l.indent;
      if (l.indent < ind) break;
      body.push(l.raw.slice(ind));
      pos++;
    }
    while (chomp !== 'keep' && body.length && body[body.length - 1] === '') body.pop();
    let out;
    if (style === '|') out = body.join('\n');
    else {
      out = '';
      body.forEach((b, i) => {
        if (i === 0) out = b;
        else if (b === '' || /^\s/.test(b)) out += '\n' + b;
        else out += (out.endsWith('\n') || out === '' ? '' : ' ') + b;
      });
    }
    if (chomp === 'clip' && out) out += '\n';
    return out;
  }

  /** Value after "key:" or "- ": inline text, block scalar, or a nested block. */
  function valueAfter(rest, ownIndent, line, allowSameIndentSeq) {
    if (rest === '' ) {
      skipBlank();
      if (pos >= lines.length) return null;
      const next = lines[pos];
      if (next.indent > ownIndent) return block(next.indent);
      if (allowSameIndentSeq && next.indent === ownIndent && /^-(\s|$)/.test(next.text)) return block(next.indent, true);
      return null;
    }
    if (/^[|>][-+0-9]*$/.test(rest)) return blockScalar(rest, ownIndent);
    // plain multi-line scalars: fold more-indented continuation lines
    let text = rest;
    if (!/^["'[{]/.test(rest)) {
      while (pos < lines.length && !lines[pos].blank && lines[pos].indent > ownIndent && !splitKey(lines[pos].text) && !/^-(\s|$)/.test(lines[pos].text)) {
        text += ' ' + lines[pos].text; pos++;
      }
    }
    return scalar(text, line);
  }

  function block(indent, seqOnly = false) {
    skipBlank();
    const first = lines[pos];
    if (/^-(\s|$)/.test(first.text)) {
      const arr = [];
      while (pos < lines.length) {
        skipBlank();
        const l = lines[pos];
        if (!l || l.indent !== indent || !/^-(\s|$)/.test(l.text)) break;
        const content = l.text.replace(/^-\s*/, '');
        const contentIndent = indent + (l.text.length - content.length);
        pos++;
        if (content === '') { arr.push(valueAfter('', indent, l.n, false)); continue; }
        const kv = splitKey(content);
        if (kv) {
          // "- key: value" starts a mapping whose keys sit at contentIndent
          pos--;
          lines[pos] = { ...l, indent: contentIndent, text: content };
          arr.push(mapping(contentIndent));
        } else if (/^-(\s|$)/.test(content)) {
          pos--;
          lines[pos] = { ...l, indent: contentIndent, text: content };
          arr.push(block(contentIndent));
        } else {
          arr.push(valueAfter(content, indent, l.n, false));
        }
      }
      return arr;
    }
    if (seqOnly) return null;
    return mapping(indent);
  }

  function mapping(indent) {
    const obj = {};
    while (pos < lines.length) {
      skipBlank();
      const l = lines[pos];
      if (!l || l.indent < indent) break;
      if (l.indent > indent) throw new YamlError('unexpected indentation', l.n);
      if (/^-(\s|$)/.test(l.text)) break;
      const kv = splitKey(l.text);
      if (!kv) throw new YamlError('expected "key: value"', l.n);
      if (/^[&*!]/.test(kv.key) || kv.key === '<<') throw new YamlError('anchors, aliases and merge keys are not supported', l.n);
      pos++;
      obj[kv.key] = valueAfter(kv.rest, indent, l.n, true);
    }
    return obj;
  }

  skipBlank();
  if (pos >= lines.length) return null;
  const top = lines[pos];
  if (!/^-(\s|$)/.test(top.text) && !splitKey(top.text)) {
    const v = scalar(lines.slice(pos).filter((l) => !l.blank).map((l) => l.text).join(' '), top.n);
    return v;
  }
  const out = block(top.indent);
  skipBlank();
  if (pos < lines.length) {
    if (/^---/.test(lines[pos].text)) throw new YamlError('only one document is supported', lines[pos].n);
    throw new YamlError('unexpected content', lines[pos].n);
  }
  return out;
}

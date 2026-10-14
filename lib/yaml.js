'use strict';
/**
 * lib/yaml.js — dependency-free YAML subset parser used as a fallback when the
 * `yaml` package is not installed. Supports everything config.yml uses:
 *  - nested maps (indentation), lists ("- item", list of maps), comments (#)
 *  - inline lists [a, "b", 3] and inline maps {a: 1, b: two}
 *  - single/double quoted strings (with \n \t \" \\ \uXXXX escapes in double quotes)
 *  - booleans (true/false/yes/no/on/off), null (~ / null), ints, floats, hex (0x..)
 *  - block scalars "|" and ">" (literal / folded)
 * Integers bigger than Number.MAX_SAFE_INTEGER are kept as strings (Discord IDs!).
 */

function stripComment(line) {
  let inS = false, inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !inS && line[i - 1] !== '\\') inD = !inD;
    else if (c === "'" && !inD) inS = !inS;
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function scalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s[0] === '"' && s[s.length - 1] === '"' && s.length >= 2) {
    return s.slice(1, -1).replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, e) => {
      if (e[0] === 'u') return String.fromCharCode(parseInt(e.slice(1), 16));
      return { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '0': '\0', '/': '/' }[e] ?? e;
    });
  }
  if (s[0] === "'" && s[s.length - 1] === "'" && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s[0] === '[' && s[s.length - 1] === ']') return splitFlow(s.slice(1, -1)).map(scalar);
  if (s[0] === '{' && s[s.length - 1] === '}') {
    const o = {};
    for (const part of splitFlow(s.slice(1, -1))) {
      const k = part.indexOf(':');
      if (k < 0) continue;
      o[unquoteKey(part.slice(0, k))] = scalar(part.slice(k + 1));
    }
    return o;
  }
  if (/^(true|yes|on)$/i.test(s)) return true;
  if (/^(false|no|off)$/i.test(s)) return false;
  if (/^[-+]?\d+$/.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : s.replace(/^\+/, '');
  }
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  return s;
}

function splitFlow(body) {
  const out = []; let depth = 0, cur = '', inS = false, inD = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' && !inS && body[i - 1] !== '\\') inD = !inD;
    else if (c === "'" && !inD) inS = !inS;
    if (!inS && !inD) {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) { if (cur.trim() !== '') out.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

function unquoteKey(k) {
  const t = k.trim();
  if ((t[0] === '"' && t[t.length - 1] === '"') || (t[0] === "'" && t[t.length - 1] === "'")) return t.slice(1, -1);
  return t;
}

function findColon(content) {
  let inS = false, inD = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '"' && !inS) inD = !inD;
    else if (c === "'" && !inD) inS = !inS;
    else if (c === ':' && !inS && !inD && (i === content.length - 1 || content[i + 1] === ' ' || content[i + 1] === '\t')) return i;
  }
  return -1;
}

function parse(text) {
  const rawLines = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const lines = [];
  for (let idx = 0; idx < rawLines.length; idx++) {
    const raw = rawLines[idx];
    if (/^\s*(---|\.\.\.)\s*$/.test(raw)) continue;
    const noTab = raw.replace(/\t/g, '  ');
    const indent = noTab.length - noTab.trimStart().length;
    const content = stripComment(noTab).trimEnd().trimStart();
    lines.push({ indent, content, raw: noTab, n: idx + 1 });
  }
  let i = 0;

  const skipEmpty = () => { while (i < lines.length && lines[i].content === '') i++; };
  const isItem = (c) => c === '-' || c.startsWith('- ');

  function blockScalar(style, parentIndent) {
    const buf = []; let ind = -1;
    while (i < lines.length) {
      const L = lines[i];
      if (L.raw.trim() === '') { buf.push(''); i++; continue; }
      if (L.indent <= parentIndent) break;
      if (ind < 0) ind = L.indent;
      buf.push(L.raw.slice(ind)); i++;
    }
    while (buf.length && buf[buf.length - 1] === '') buf.pop();
    return style === '|' ? buf.join('\n') : buf.join(' ').replace(/\s+\n/g, '\n');
  }

  function value(rest, indent) {
    const r = rest.trim();
    if (r === '|' || r === '>' || r === '|-' || r === '>-') { i++; return blockScalar(r[0], indent); }
    i++;
    if (r !== '') return scalar(r);
    skipEmpty();
    if (i >= lines.length) return null;
    const nx = lines[i];
    if (nx.indent > indent) return block(nx.indent);
    if (nx.indent === indent && isItem(nx.content)) return block(indent);
    return null;
  }

  function block(indent) {
    skipEmpty();
    if (i >= lines.length) return null;
    if (isItem(lines[i].content)) {
      const arr = [];
      while (i < lines.length) {
        skipEmpty();
        if (i >= lines.length) break;
        const L = lines[i];
        if (L.indent !== indent || !isItem(L.content)) break;
        const rest = L.content === '-' ? '' : L.content.slice(2);
        if (rest.trim() === '') {
          i++; skipEmpty();
          arr.push(i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : null);
        } else if (findColon(rest) > 0 && !/^["'[{]/.test(rest.trim())) {
          const col = L.indent + 2 + (rest.length - rest.trimStart().length);
          lines[i] = { indent: col, content: rest.trim(), raw: ' '.repeat(col) + rest.trim(), n: L.n };
          arr.push(block(col));
        } else { i++; arr.push(scalar(rest)); }
      }
      return arr;
    }
    const obj = {};
    while (i < lines.length) {
      skipEmpty();
      if (i >= lines.length) break;
      const L = lines[i];
      if (L.indent < indent) break;
      if (L.indent > indent) throw new Error(`YAML: unexpected indentation at line ${L.n}`);
      if (isItem(L.content)) break;
      const c = findColon(L.content);
      if (c <= 0) throw new Error(`YAML: expected "key: value" at line ${L.n}`);
      const key = unquoteKey(L.content.slice(0, c));
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') { i++; continue; }
      obj[key] = value(L.content.slice(c + 1), indent);
    }
    return obj;
  }

  skipEmpty();
  if (i >= lines.length) return {};
  return block(lines[i].indent);
}

module.exports = { parse };

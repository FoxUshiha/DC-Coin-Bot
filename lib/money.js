'use strict';
/**
 * lib/money.js — exact integer money math.
 *
 * Every balance / amount in the system is an INTEGER number of "sats"
 * (1 coin = 100 000 000 sats). Values are always JavaScript safe integers
 * (< 2^53), so no floating point is ever used for money: no coin can be
 * created or destroyed by rounding.  Conversions to text use only integer
 * division/remainder; user input is parsed character by character.
 */
const crypto = require('crypto');

const SATS = 100000000;
const MAX_SATS = Number.MAX_SAFE_INTEGER; // ~90 million coins

/** Throws-free parser. Returns a positive/zero safe integer of sats, or null when invalid. */
function parse(input, { allowZero = false } = {}) {
  let s;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0 || input > MAX_SATS / SATS) return null;
    // 10 digits then truncate to 8: removes binary noise (0.1+0.2 -> 0.30000000)
    s = input.toFixed(10);
    s = s.slice(0, s.length - 2);
  } else if (typeof input === 'string') {
    s = input.trim().replace(/^\+/, '').replace(/[_\s]/g, '');
    if (/^\d*\.?\d+e[-+]?\d+$/i.test(s)) return parse(Number(s), { allowZero });
    if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
  } else if (typeof input === 'bigint') {
    s = input.toString();
  } else return null;

  const m = /^(\d{0,9})(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === '' && !m[2])) return null;
  const intPart = m[1] === '' ? 0 : Number(m[1]);
  const frac = Number(((m[2] || '') + '00000000').slice(0, 8));
  const sats = intPart * SATS + frac;
  if (!Number.isSafeInteger(sats)) return null;
  if (sats === 0 && !allowZero) return null;
  return sats;
}

/** Parses an integer number of sats ("123", 123). */
function parseSats(input) {
  if (typeof input === 'number') return Number.isSafeInteger(input) && input >= 0 ? input : null;
  if (typeof input === 'string' && /^\d{1,16}$/.test(input.trim())) {
    const n = Number(input.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** Integer sats -> "123.45678900" (always 8 decimals, no float math). */
function format(sats) {
  const v = Number(sats) || 0;
  const neg = v < 0;
  const a = Math.abs(Math.trunc(v));
  const frac = a % SATS;
  const int = (a - frac) / SATS;
  return (neg ? '-' : '') + int + '.' + String(frac).padStart(8, '0');
}

/** Like format() but trims useless trailing zeros (for chart labels): "1.5" */
function short(sats) {
  const s = format(sats);
  return s.replace(/\.?0+$/, '') || '0';
}

/** Human format with thousands separators: "1,234.00000012" (en) / "1.234,00000012" (pt). */
function pretty(sats, lang = 'en') {
  const s = format(sats);
  const neg = s[0] === '-';
  const [i, f] = (neg ? s.slice(1) : s).split('.');
  const sep = lang === 'pt' ? '.' : ',';
  const dec = lang === 'pt' ? ',' : '.';
  return (neg ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, sep) + dec + f;
}

/** Safe integer add/sub that refuses to overflow. */
function add(a, b) { const r = a + b; if (!Number.isSafeInteger(r)) throw Object.assign(new Error('AMOUNT_OVERFLOW'), { code: 'AMOUNT_OVERFLOW' }); return r; }
function sub(a, b) { const r = a - b; if (!Number.isSafeInteger(r)) throw Object.assign(new Error('AMOUNT_OVERFLOW'), { code: 'AMOUNT_OVERFLOW' }); return r; }

// ── JSON helpers: emit coin values as JSON *number literals* with exactly 8 decimals
//    ("coins": 1.00000012) without ever creating a float on the server.
const NONCE = crypto.randomBytes(6).toString('hex');
const RAW_RE = new RegExp(`"@@N${NONCE}@(-?\\d+\\.\\d{8})@@"`, 'g');
class RawCoin {
  constructor(sats) { this.v = format(sats); }
  toJSON() { return `@@N${NONCE}@${this.v}@@`; }
}
const coinNumber = (sats) => new RawCoin(sats);
function stringify(obj) {
  const s = JSON.stringify(obj);
  return s.indexOf('@@N' + NONCE) === -1 ? s : s.replace(RAW_RE, '$1');
}

module.exports = { SATS, MAX_SATS, parse, parseSats, format, short, pretty, add, sub, coinNumber, stringify };

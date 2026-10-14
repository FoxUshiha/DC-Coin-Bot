'use strict';
/**
 * api.js — public HTTP API + website server (pure node:http, zero framework overhead).
 *
 *  • every legacy endpoint (same request/response shapes the site, plugins and extension use)
 *  • the endpoints the new website needed: /api/stats, /api/stats/history, /api/stats/recent,
 *    /tx/:id, receipts (PNG/PDF/SVG), balance & network charts, /api/me, /api/bill/:id
 *  • security: strict input validation, 16 KB bodies, scrypt passwords, hashed 24h sessions,
 *    security headers, IPv6 /64 grouping, anti brute-force on logins and card codes
 *  • Cloudflare aware: real client IP from CF-Connecting-IP only when the request really comes
 *    from Cloudflare (official ranges) or from cloudflared on this machine; anonymous device
 *    cookie for account-creation limits
 *  • throughput: per-IP token bucket + *fair async queue* (round-robin between IPs, requests
 *    wait instead of failing), write batching in database.js, in-memory caches,
 *    pre-compressed static files (br/gzip + ETag), gzip/br for big JSON
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const money = require('./lib/money');
const { LRU } = require('./lib/cache');
const logic = require('./logic');
const log = require('./lib/log').scope('api');

let cfg = null;
let server = null;
const started = Date.now();
const metrics = { requests: 0, api: 0, static: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, rateLimited: 0, queueFull: 0, queueTimeout: 0 };

/* ═══════════════════════════════ CLOUDFLARE / CLIENT IP ═══════════════════════════════ */
const CF_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'
];
const cfList = new net.BlockList();
for (const r of CF_RANGES) { const [a, p] = r.split('/'); cfList.addSubnet(a, Number(p), net.isIPv6(a) ? 'ipv6' : 'ipv4'); }
let trusted = new Set();

const stripMapped = (ip) => (ip && ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip || '');
const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
function inCloudflare(ip) {
  const fam = net.isIP(ip);
  if (!fam) return false;
  try { return cfList.check(ip, fam === 6 ? 'ipv6' : 'ipv4'); } catch { return false; }
}

/** Real client IP (never trusts spoofable headers from unknown sources). */
function clientIp(req) {
  const remote = stripMapped(req.socket.remoteAddress);
  const cf = cfg.cloudflare;
  if (cf.enabled) {
    const fromCf = inCloudflare(remote) || (cf.trust_loopback && isLoopback(remote));
    const h = req.headers['cf-connecting-ip'];
    if (fromCf && typeof h === 'string' && net.isIP(h.trim())) return stripMapped(h.trim());
  }
  if (trusted.has(remote)) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string') {
      const hops = xff.split(',').map((s) => stripMapped(s.trim())).filter((s) => net.isIP(s));
      for (let i = hops.length - 1; i >= 0; i--) if (!trusted.has(hops[i])) return hops[i];
    }
    const xr = req.headers['x-real-ip'];
    if (typeof xr === 'string' && net.isIP(xr.trim())) return stripMapped(xr.trim());
  }
  return remote || '0.0.0.0';
}
function isHttps(req) {
  if (req.socket.encrypted) return true;
  const remote = stripMapped(req.socket.remoteAddress);
  const fromProxy = trusted.has(remote) || isLoopback(remote) || inCloudflare(remote);
  if (!fromProxy) return false;
  const v = req.headers['cf-visitor'];
  if (typeof v === 'string' && v.includes('https')) return true;
  return req.headers['x-forwarded-proto'] === 'https';
}

/* ═══════════════════════════════ COOKIES ═══════════════════════════════ */
function parseCookies(h) {
  const out = {};
  if (typeof h !== 'string' || h.length > 8192) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (k.length > 64) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ }
  }
  return out;
}

/* ═══════════════════════════════ RATE LIMIT (token buckets, memory only) ═══════════════════════════════ */
let buckets, renderBuckets, cardFails, idem;
function take(store, key, rate, burst, cost = 1) {
  const now = Date.now();
  let b = store.get(key);
  if (!b) { b = { t: burst, ts: now }; store.set(key, b); }
  else { b.t = Math.min(burst, b.t + ((now - b.ts) / 1000) * rate); b.ts = now; }
  if (b.t >= cost) { b.t -= cost; return 0; }
  return Math.ceil(((cost - b.t) / rate) * 1000); // ms until allowed
}
function cardLocked(ipk) { const f = cardFails.get(ipk); return f && f.until > Date.now() ? f.until - Date.now() : 0; }
function cardFailed(ipk) {
  const c = cfg.api.card; const f = cardFails.get(ipk) || { n: 0, until: 0 };
  f.n++; if (f.n >= c.max_failures) { f.until = Date.now() + c.lock_seconds * 1000; f.n = 0; }
  cardFails.set(ipk, f, c.lock_seconds * 1000 * 2);
}

/* ═══════════════════════════════ FAIR ASYNC QUEUE ═══════════════════════════════ */
/**
 * Runs at most `maxConcurrent` handlers at once. Extra requests wait in per-IP FIFO
 * queues served round-robin, so one heavy client cannot starve the others. A request
 * only fails if it waits longer than `wait_timeout_ms` or the queue is completely full.
 */
class FairGate {
  constructor(o) { this.o = o; this.active = 0; this.waiting = 0; this.queues = new Map(); this.ring = []; this.rr = 0; }
  run(key, fn) {
    if (this.active < this.o.max_concurrent && this.waiting === 0) return this._exec(fn);
    if (this.waiting >= this.o.max_waiting) return Promise.reject(Object.assign(new Error('QUEUE_FULL'), { code: 'QUEUE_FULL', status: 429 }));
    let q = this.queues.get(key);
    if (q && q.length >= this.o.max_waiting_per_ip) return Promise.reject(Object.assign(new Error('QUEUE_FULL'), { code: 'QUEUE_FULL', status: 429 }));
    return new Promise((resolve, reject) => {
      if (!q) { q = []; this.queues.set(key, q); this.ring.push(key); }
      const item = { fn, resolve, reject, done: false };
      item.timer = setTimeout(() => {
        if (item.done) return;
        item.done = true; this.waiting--;
        const qq = this.queues.get(key);
        if (qq) {
          const ix = qq.indexOf(item); if (ix >= 0) qq.splice(ix, 1);
          if (!qq.length) { this.queues.delete(key); const r = this.ring.indexOf(key); if (r >= 0) { this.ring.splice(r, 1); if (this.rr > r) this.rr--; } }
        }
        reject(Object.assign(new Error('QUEUE_TIMEOUT'), { code: 'QUEUE_TIMEOUT', status: 504 }));
      }, this.o.wait_timeout_ms);
      q.push(item); this.waiting++;
      this._pump();
    });
  }
  _exec(fn) {
    this.active++;
    let p;
    try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
    return p.finally(() => { this.active--; this._pump(); });
  }
  _pump() {
    while (this.active < this.o.max_concurrent && this.waiting > 0 && this.ring.length) {
      if (this.rr >= this.ring.length) this.rr = 0;
      const key = this.ring[this.rr];
      const q = this.queues.get(key);
      let item;
      while (q && q.length && !item) { const it = q.shift(); if (!it.done) item = it; }
      if (!q || !q.length) { this.queues.delete(key); this.ring.splice(this.rr, 1); } else this.rr++;
      if (!item) continue;
      item.done = true; clearTimeout(item.timer); this.waiting--;
      this._exec(item.fn).then(item.resolve, item.reject);
    }
  }
  info() { return { active: this.active, waiting: this.waiting, clients: this.queues.size }; }
}
let gate;

/* ═══════════════════════════════ RESPONSES ═══════════════════════════════ */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'X-DNS-Prefetch-Control': 'off'
};
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'";

function baseHeaders(req, res) {
  for (const k in SEC_HEADERS) res.setHeader(k, SEC_HEADERS[k]);
  if (req._https) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  const c = cfg.api.cors;
  if (c.enabled && req.url.startsWith('/api/')) {
    const origin = req.headers.origin;
    const list = c.origins || ['*'];
    if (list.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
    else if (origin && list.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Idempotency-Key');
    res.setHeader('Access-Control-Expose-Headers', 'Retry-After, Idempotent-Replay');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

function pickEncoding(req) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(ae)) return 'br';
  if (/\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

function endBody(req, res, status, body, type, extra = {}) {
  if (res.headersSent || res.writableEnded) return;
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = { 'Content-Type': type, ...extra };
  const cc = cfg.api.compression;
  if (cc.enabled && buf.length >= cc.min_bytes && /json|text|javascript|svg|xml/.test(type)) {
    const enc = pickEncoding(req);
    if (enc === 'br') { buf = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }); headers['Content-Encoding'] = 'br'; }
    else if (enc === 'gzip') { buf = zlib.gzipSync(buf, { level: 5 }); headers['Content-Encoding'] = 'gzip'; }
    headers.Vary = headers.Vary ? headers.Vary + ', Accept-Encoding' : 'Accept-Encoding';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
  const s = String(status)[0]; metrics['s' + s + 'xx'] = (metrics['s' + s + 'xx'] || 0) + 1;
}
function json(req, res, status, obj, extra = {}) {
  endBody(req, res, status, money.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store', ...extra });
}

/** Marker objects handlers may return. */
const R = {
  json: (status, body, headers) => ({ __r: 'json', status, body, headers }),
  file: (buf, type, { name, inline = true, cache = 'private, max-age=300' } = {}) => ({ __r: 'file', buf, type, name, inline, cache })
};

/* ═══════════════════════════════ ERRORS ═══════════════════════════════ */
const KNOWN_STATUS = {
  INVALID_AMOUNT: 400, AMOUNT_TOO_SMALL: 400, INVALID_TARGET: 400, SELF_TRANSFER: 400, SAME_CARD: 400, INVALID_TIME: 400,
  INSUFFICIENT_FUNDS: 402, TRANSFER_COOLDOWN: 429, COOLDOWN_ACTIVE: 429, MAX_SUPPLY_REACHED: 409, BILL_NOT_FOUND: 404,
  BILL_EXPIRED: 410, CARD_NOT_FOUND: 404, FROM_CARD_NOT_FOUND: 404, TO_CARD_NOT_FOUND: 404, BACKUP_NOT_FOUND: 404,
  BACKUP_SAME_ACCOUNT: 400, BACKUP_EMPTY: 400, EMPTY_WALLET: 400, INVALID_USERNAME: 400, INVALID_PASSWORD: 400,
  INVALID_TRANSACTION: 404, PAYREQ_NOT_FOUND: 404, PAYREQ_PAID: 409, PAYREQ_CANCELLED: 409, PAYREQ_CLOSED: 409, PAYREQ_EXPIRED: 410, AMOUNT_REQUIRED: 400, TOO_MANY_REQUESTS: 429, RENDER_UNAVAILABLE: 503, QUEUE_FULL: 429, QUEUE_TIMEOUT: 504, DB_WRITE_FAILED: 503, ID_TAKEN: 409
};
function errorBody(e) {
  const code = e && (e.code || e.message) ? String(e.code || e.message) : 'Internal error';
  const internal = /^(ERR_|SQLITE|E[A-Z]+$)/.test(code) && !KNOWN_STATUS[code];
  const status = e && e.status ? e.status : KNOWN_STATUS[code] || (internal ? 500 : code.startsWith('Block:') ? 429 : /^[A-Z_]+$/.test(code) || code === 'Invalid parameters' || code.startsWith('Missing') ? 400 : 500);
  const body = { error: status >= 500 && !KNOWN_STATUS[code] ? 'Internal error' : code };
  for (const k of ['nextClaimInMs', 'retryAfterMs', 'lastClaimTs', 'min']) if (e && e[k] !== undefined) body[k] = e[k];
  if (e && typeof e.message === 'string' && e.message !== code && status < 500) body.message = e.message;
  return { status, body };
}

/* ═══════════════════════════════ BODY / QUERY ═══════════════════════════════ */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const limit = cfg.api.body_limit_kb * 1024;
    const len = Number(req.headers['content-length'] || 0);
    if (len > limit) return reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { code: 'PAYLOAD_TOO_LARGE', status: 413 }));
    const chunks = []; let size = 0, done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { code: 'PAYLOAD_TOO_LARGE', status: 413 })); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return; done = true;
      if (!size) return resolve({});
      const txt = Buffer.concat(chunks, size).toString('utf8').trim();
      if (!txt) return resolve({});
      try {
        const v = JSON.parse(txt);
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        if (/application\/x-www-form-urlencoded/.test(String(req.headers['content-type']))) {
          const o = {}; for (const [k, val] of new URLSearchParams(txt)) if (k !== '__proto__') o[k] = val; return resolve(o);
        }
        reject(Object.assign(new Error('INVALID_JSON'), { code: 'INVALID_JSON', status: 400 }));
      }
    });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}
function parseQuery(qs) {
  const o = {};
  if (!qs) return o;
  for (const [k, v] of new URLSearchParams(qs.slice(0, 2048))) if (k !== '__proto__' && !(k in o)) o[k] = v.slice(0, 256);
  return o;
}
const str = (v, max = 128) => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
const amountIn = (v) => (typeof v === 'number' || typeof v === 'string' ? v : null);
const langOf = (ctx) => {
  const q = str(ctx.query.lang, 5).toLowerCase();
  if (q.startsWith('pt')) return 'pt';
  if (q.startsWith('en')) return 'en';
  const c = ctx.cookies.coin_lang;
  if (c === 'pt' || c === 'en') return c;
  return /^pt/i.test(String(ctx.req.headers['accept-language'] || '')) ? 'pt' : 'en';
};

/* ═══════════════════════════════ ROUTES ═══════════════════════════════ */
const routes = []; // { method, re, keys, handler, opts }
/**
 * opts: auth: 'required' | 'optional' (Bearer token, cookie allowed when `cookie: true`)
 *       render: true → strict per-IP render limit; card: true → anti brute-force for card codes
 */
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const src = pattern.replace(/[.+*?^${}()|[\]\\]/g, '\\$&').replace(/\//g, '\\/').replace(/:(\w+)/g, (m, k) => { keys.push(k); return '([^\\/]+?)'; });
  const re = new RegExp('^' + src + '\\/?$');
  routes.push({ method, re, keys, handler, opts, pattern });
}
const AUTH = { auth: 'required' };
const IDEM_T = { auth: 'required', idem: true };

// ── health / meta
route('GET', '/health', () => ({ ok: true, uptime: process.uptime(), version: 2, time: new Date().toISOString() }));
route('GET', '/api/health', () => ({ ok: true, uptime: process.uptime(), version: 2, time: new Date().toISOString() }));

// ── auth & accounts
route('POST', '/api/login', async (ctx) => {
  const { username, password } = ctx.body;
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') return R.json(400, { sessionCreated: false, passwordCorrect: false });
  const r = await logic.login(username, password, { ip: ctx.ip });
  if (r.error === 'IP_LOCKED') return R.json(429, { sessionCreated: false, passwordCorrect: false, error: `IP blocked. Try again in ${Math.ceil(r.retryAfterMs / 1000)} seconds.` });
  return r;
});
route('POST', '/api/register', async (ctx) => {
  const { username, password } = ctx.body;
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') return R.json(400, { success: false, error: 'Username and password required.' });
  try {
    return await logic.register(username, password, { ip: ctx.ip, device: ctx.device });
  } catch (e) {
    const { status, body } = errorBody(e);
    return R.json(status, { success: false, ...body });
  }
});
route('POST', '/api/logout', AUTH, (ctx) => logic.logout(ctx.token));
route('POST', '/api/account/change', AUTH, async (ctx) => {
  const { username, password } = ctx.body;
  if (!password || typeof password !== 'string') return R.json(400, { error: 'Missing password' });
  return logic.changeAccount(ctx.userId, { username: typeof username === 'string' ? username : undefined, password });
});
route('POST', '/api/account/update', AUTH, async (ctx) => {
  const { username, passwordHash } = ctx.body;
  if (!username || !passwordHash) return R.json(400, { error: 'Missing parameters' });
  return logic.accountUpdate(ctx.userId, str(username, 64), str(passwordHash, 64));
});
route('POST', '/api/account/unregister', AUTH, (ctx) => logic.unregister(ctx.userId));
route('GET', '/api/me', AUTH, (ctx) => {
  const s = logic.accountSummary(ctx.userId);
  return { ...s, coins: money.coinNumber(s.sats), coinsStr: s.coins, rank: logic.rankPosition(ctx.userId), claim: logic.claimStatus(ctx.userId) };
});

// ── balance / transfers / claims
route('GET', '/api/user/:userId/balance', AUTH, (ctx) => {
  const sats = logic.balance(ctx.userId);
  return { coins: money.coinNumber(sats), sats, coinsStr: money.format(sats), userId: ctx.userId };
});
route('POST', '/api/transfer', IDEM_T, async (ctx) => {
  const toId = logic.cleanId(ctx.body.toId);
  const amount = amountIn(ctx.body.amount);
  if (!toId || amount === null) return R.json(400, { error: 'Invalid parameters' });
  const r = await logic.transfer(ctx.userId, toId, amount, { source: 'api' });
  return { success: true, txId: r.txId, date: r.date, amount: r.amount, amountSats: r.amountSats };
});
route('POST', '/api/claim', AUTH, async (ctx) => {
  try { return await logic.claim(ctx.userId, { source: 'api' }); }
  catch (e) {
    if (e.code === 'COOLDOWN_ACTIVE') return R.json(429, { error: 'Cooldown active', nextClaimInMs: e.nextClaimInMs, cooldownMs: logic.claimStatus(ctx.userId).cooldownMs, lastClaimTs: e.lastClaimTs });
    throw e;
  }
});
route('GET', '/api/claim/status', AUTH, (ctx) => logic.claimStatus(ctx.userId));

// ── cards
const cardErr = (e) => { const { status, body } = errorBody(e); return R.json(status, { success: false, ...body }); };
route('POST', '/api/card', AUTH, async (ctx) => ({ cardCode: await logic.getCard(ctx.userId) }));
route('POST', '/api/card/reset', AUTH, async (ctx) => ({ newCode: await logic.resetCard(ctx.userId) }));
route('POST', '/api/card/info', { card: true }, (ctx) => {
  const code = str(ctx.body.cardCode, 128);
  if (!code) return R.json(400, { success: false, error: 'Missing cardCode' });
  const r = logic.cardInfo(code);
  if (!r.found) { ctx.cardFail(); return R.json(404, { success: false, error: 'Card not found' }); }
  return { success: true, userId: r.userId, coins: r.coins, sats: r.sats, totalTransactions: r.totalTransactions, lastClaimTs: r.lastClaimTs, cooldownRemainingMs: r.cooldownRemainingMs, cooldownMs: r.cooldownMs };
});
route('POST', '/api/card/claim', { card: true }, async (ctx) => {
  const code = str(ctx.body.cardCode, 128);
  if (!code) return R.json(400, { success: false, error: 'Missing cardCode' });
  try { const r = await logic.claimByCard(code); return { success: true, claimed: r.claimed, claimedSats: r.claimedSats, txId: r.txId, date: r.date }; }
  catch (e) {
    if (e.code === 'CARD_NOT_FOUND') ctx.cardFail();
    if (e.code === 'COOLDOWN_ACTIVE') return R.json(429, { success: false, error: 'COOLDOWN_ACTIVE', nextClaimInMs: e.nextClaimInMs });
    return cardErr(e);
  }
});
route('POST', '/api/card/pay', { card: true }, async (ctx) => {
  const fromCard = str(ctx.body.fromCard, 128), toCard = str(ctx.body.toCard, 128), amount = amountIn(ctx.body.amount);
  if (!fromCard || !toCard || amount === null) return R.json(400, { success: false, error: 'Invalid parameters' });
  try { const r = await logic.payBetweenCards(fromCard, toCard, amount); return { success: true, txId: r.txId, date: r.date, amount: r.amount, amountSats: r.amountSats }; }
  catch (e) { if (/CARD_NOT_FOUND/.test(e.code)) ctx.cardFail(); return cardErr(e); }
});
route('POST', '/api/transfer/card', { card: true }, async (ctx) => {
  const cardCode = str(ctx.body.cardCode, 128), toId = logic.cleanId(ctx.body.toId), amount = amountIn(ctx.body.amount);
  if (!cardCode || !toId || amount === null) return R.json(400, { success: false, error: 'Invalid parameters' });
  try { const r = await logic.transferByCard(cardCode, toId, amount); return { success: true, txId: r.txId, date: r.date, amount: r.amount, amountSats: r.amountSats }; }
  catch (e) { if (e.code === 'CARD_NOT_FOUND') ctx.cardFail(); return cardErr(e); }
});

// ── bills
route('POST', '/api/bill/list', AUTH, (ctx) => logic.listBills(ctx.userId, ctx.body.page));
route('POST', '/api/bill/list/from', AUTH, (ctx) => { const r = logic.listBills(ctx.userId, ctx.body.page); return { toPay: r.toPay, page: r.page }; });
route('POST', '/api/bill/list/to', AUTH, (ctx) => { const r = logic.listBills(ctx.userId, ctx.body.page); return { toReceive: r.toReceive, page: r.page }; });
route('POST', '/api/bill/create', AUTH, async (ctx) => {
  const { fromId, toId, amount, time } = ctx.body;
  if (!toId || amountIn(amount) === null) return R.json(400, { error: 'Invalid parameters' });
  return logic.createBill({ fromId, toId, amount, time });
});
route('POST', '/api/bill/pay', IDEM_T, async (ctx) => {
  const billId = str(ctx.body.billId, 64);
  if (!billId) return R.json(400, { error: 'Missing billId' });
  return logic.payBill(ctx.userId, billId, { source: 'api' });
});
route('POST', '/api/bill/create/card', { card: true }, async (ctx) => {
  const { fromCard, toCard, amount, time } = ctx.body;
  if ((!fromCard && !toCard) || amountIn(amount) === null) return R.json(400, { error: 'Invalid parameters' });
  try { return await logic.createBillByCard({ fromCard: str(fromCard, 128) || null, toCard: str(toCard, 128) || null, amount, time }); }
  catch (e) { if (/CARD_NOT_FOUND/.test(e.code)) ctx.cardFail(); throw e; }
});
route('POST', '/api/bill/pay/card', { card: true }, async (ctx) => {
  const cardCode = str(ctx.body.cardCode, 128), billId = str(ctx.body.billId, 64);
  if (!cardCode || !billId) return R.json(400, { error: 'Missing parameters' });
  try { return await logic.payBillByCard(cardCode, billId); }
  catch (e) { if (e.code === 'CARD_NOT_FOUND') ctx.cardFail(); throw e; }
});
route('GET', '/api/bill/:billId', (ctx) => {
  const b = logic.getBill(ctx.params.billId);
  return b ? { success: true, bill: b } : R.json(404, { success: false, error: 'BILL_NOT_FOUND' });
});

// ── backups
route('POST', '/api/backup/create', AUTH, async (ctx) => { const codes = await logic.createBackups(ctx.userId); return { success: true, count: codes.length }; });
route('POST', '/api/backup/list', AUTH, (ctx) => ({ backups: logic.listBackups(ctx.userId) }));
route('POST', '/api/backup/restore', AUTH, async (ctx) => {
  const code = str(ctx.body.backupId || ctx.body.code, 64);
  if (!code) return R.json(400, { error: 'Missing backupId' });
  return logic.restoreBackup(ctx.userId, code);
});

// ── ledger
route('GET', '/api/transactions', AUTH, (ctx) => {
  const page = Math.max(1, parseInt(ctx.query.page, 10) || 1);
  return { transactions: logic.listTransactions(ctx.userId, page), page };
});
// link público do comprovante (para copiar e mandar): página /tx/:id + imagem/PDF gerados pela API
const publicBase = (ctx) => {
  const u = cfg.api.public_url ? String(cfg.api.public_url).replace(/\/+$/, '') : '';
  if (u) return u;
  const h = String(ctx.req.headers.host || '').replace(/[^\w.:\-\[\]]/g, '');
  return (ctx.req._https ? 'https://' : 'http://') + (h || 'localhost');
};
route('GET', '/api/tx/:txid/link', (ctx) => {
  const tx = logic.getTransaction(ctx.params.txid);
  if (!tx) return R.json(404, { error: 'INVALID_TRANSACTION', message: 'Transaction not found' });
  const b = publicBase(ctx), id = encodeURIComponent(tx.id);
  return { success: true, id: tx.id, url: `${b}/tx/${id}`, png: `${b}/api/tx/${id}/receipt.png`, pdf: `${b}/api/tx/${id}/receipt.pdf`, svg: `${b}/api/tx/${id}/receipt.svg`, json: `${b}/api/tx/${id}`, tx };
});
route('GET', '/api/tx/:txid', (ctx) => {
  const tx = logic.getTransaction(ctx.params.txid);
  if (!tx) return R.json(404, { error: 'INVALID_TRANSACTION', message: 'Transaction not found' });
  return { success: true, tx };
});
for (const fmt of ['png', 'pdf', 'svg']) {
  route('GET', `/api/tx/:txid/receipt.${fmt}`, { render: true }, async (ctx) => {
    const buf = await logic.receipt(ctx.params.txid, { lang: langOf(ctx), format: fmt });
    return R.file(buf, fmt === 'png' ? 'image/png' : fmt === 'pdf' ? 'application/pdf' : 'image/svg+xml; charset=utf-8', { name: `receipt-${ctx.params.txid}.${fmt}`, inline: ctx.query.download !== '1', cache: 'public, max-age=3600' });
  });
}
route('GET', '/api/tx/:txid/receipt', { render: true }, async (ctx) => {
  const fmt = ['pdf', 'svg'].includes(ctx.query.format) ? ctx.query.format : 'png';
  const buf = await logic.receipt(ctx.params.txid, { lang: langOf(ctx), format: fmt });
  return R.file(buf, fmt === 'png' ? 'image/png' : fmt === 'pdf' ? 'application/pdf' : 'image/svg+xml; charset=utf-8', { name: `receipt-${ctx.params.txid}.${fmt}`, inline: ctx.query.download !== '1', cache: 'public, max-age=3600' });
});

// ── charts
const chartRoute = (fmt) => async (ctx) => {
  const days = Math.max(2, Math.min(365, parseInt(ctx.query.days, 10) || 30));
  const u = logic.accountSummary(ctx.userId);
  const buf = await logic.userChart(ctx.userId, { days, lang: langOf(ctx), format: fmt, name: u.username || undefined });
  return R.file(buf, fmt === 'png' ? 'image/png' : fmt === 'pdf' ? 'application/pdf' : 'image/svg+xml; charset=utf-8', { name: `balance-${ctx.userId}.${fmt}`, inline: ctx.query.download !== '1', cache: 'private, max-age=60' });
};
for (const fmt of ['png', 'pdf', 'svg']) {
  route('GET', `/api/user/graph.${fmt}`, { auth: 'required', cookie: true, render: true }, chartRoute(fmt));
  route('GET', `/api/user/:userId/graph.${fmt}`, { auth: 'required', cookie: true, render: true }, chartRoute(fmt));
  route('GET', `/api/stats/chart.${fmt}`, { render: true }, async (ctx) => {
    const days = Math.max(2, Math.min(90, parseInt(ctx.query.days, 10) || 14));
    const buf = await logic.networkChart({ days, lang: langOf(ctx), format: fmt });
    return R.file(buf, fmt === 'png' ? 'image/png' : fmt === 'pdf' ? 'application/pdf' : 'image/svg+xml; charset=utf-8', { name: `network.${fmt}`, cache: 'public, max-age=60' });
  });
}
route('GET', '/api/user/graph', AUTH, (ctx) => {
  const days = Math.max(2, Math.min(365, parseInt(ctx.query.days, 10) || 30));
  const s = logic.balanceSeries(ctx.userId, days);
  return { days: s.labels.map((d, i) => ({ date: d, balance: money.format(s.balances[i]), balanceSats: s.balances[i], in: money.format(s.in[i]), out: money.format(s.out[i]) })) };
});

// ── QR payments (mobile app) ─────────────────────────────────────────────
const IDEM = { auth: 'required', idem: true };
const fileType = (fmt) => (fmt === 'png' ? 'image/png' : fmt === 'pdf' ? 'application/pdf' : 'image/svg+xml; charset=utf-8');
route('POST', '/api/pay/request', IDEM, async (ctx) => {
  const { amount, memo, expires, reusable } = ctx.body;
  if (amount !== undefined && amount !== null && amount !== '' && amountIn(amount) === null) return R.json(400, { error: 'Invalid parameters' });
  return logic.createPayRequest(ctx.userId, { amount, memo: typeof memo === 'string' ? memo : undefined, expires: typeof expires === 'string' || typeof expires === 'number' ? expires : undefined, reusable: reusable === true || reusable === 'true' });
});
route('GET', '/api/pay/requests', AUTH, (ctx) => logic.listPayRequests(ctx.userId, { status: str(ctx.query.status, 12), page: parseInt(ctx.query.page, 10) || 1 }));
route('GET', '/api/pay/request/:id', { noGate: true }, async (ctx) => {
  const wait = Math.max(0, Math.min(25, parseInt(ctx.query.wait, 10) || 0)) * 1000;
  const since = parseInt(ctx.query.since, 10);
  const r = wait && Number.isFinite(since) ? await logic.waitPayRequest(ctx.params.id, since, wait) : logic.getPayRequest(ctx.params.id);
  return r ? { success: true, request: r } : R.json(404, { success: false, error: 'PAYREQ_NOT_FOUND' });
});
route('POST', '/api/pay/request/:id/pay', IDEM, async (ctx) => {
  const amount = ctx.body.amount;
  if (amount !== undefined && amount !== null && amount !== '' && amountIn(amount) === null) return R.json(400, { error: 'Invalid parameters' });
  return logic.payPayRequest(ctx.userId, ctx.params.id, { amount, source: 'api' });
});
route('POST', '/api/pay/request/:id/pay/card', { card: true, idem: true }, async (ctx) => {
  const code = str(ctx.body.cardCode, 128);
  if (!code) return R.json(400, { success: false, error: 'Missing cardCode' });
  try { return await logic.payPayRequestByCard(code, ctx.params.id, { amount: ctx.body.amount }); }
  catch (e) { if (e.code === 'CARD_NOT_FOUND') ctx.cardFail(); return cardErr(e); }
});
route('POST', '/api/pay/request/:id/cancel', AUTH, (ctx) => logic.cancelPayRequest(ctx.userId, ctx.params.id));
route('GET', '/api/pay/me', AUTH, (ctx) => ({ success: true, ...logic.userPayInfo(ctx.userId, ctx.query.amount || undefined) }));
route('GET', '/api/pay/user/:userId', (ctx) => ({ success: true, ...logic.userPayInfo(ctx.params.userId, ctx.query.amount || undefined) }));
route('POST', '/api/pay/scan', (ctx) => ({ success: true, ...logic.parseScan(str(ctx.body.data, 600)) }));
for (const fmt of ['png', 'svg', 'pdf']) {
  route('GET', `/api/pay/request/:id/qr.${fmt}`, { render: true }, async (ctx) => R.file(await logic.payRequestQr(ctx.params.id, { format: fmt, lang: langOf(ctx) }), fileType(fmt), { name: `pay-${ctx.params.id}.${fmt}`, cache: 'public, max-age=30' }));
  route('GET', `/api/qr/user/:userId.${fmt}`, { render: true }, async (ctx) => R.file(await logic.userQr(ctx.params.userId, { amount: ctx.query.amount || undefined, format: fmt, lang: langOf(ctx) }), fileType(fmt), { name: `user-${ctx.params.userId}.${fmt}`, cache: 'public, max-age=300' }));
  route('GET', `/api/qr/me.${fmt}`, { auth: 'required', cookie: true, render: true }, async (ctx) => R.file(await logic.userQr(ctx.userId, { amount: ctx.query.amount || undefined, format: fmt, lang: langOf(ctx) }), fileType(fmt), { name: `me.${fmt}`, cache: 'private, max-age=300' }));
}

// ── public stats
route('GET', '/api/totalusers', () => logic.totalUsers());
route('GET', '/api/stats', () => logic.stats());
route('GET', '/api/stats/history', (ctx) => logic.statsHistory(parseInt(ctx.query.days, 10) || 30));
route('GET', '/api/stats/recent', (ctx) => logic.statsRecent(parseInt(ctx.query.limit, 10) || 10));
route('GET', '/api/rank', AUTH, (ctx) => logic.rank(parseInt(ctx.query.page, 10) || 1, parseInt(ctx.query.size, 10) || 25));
route('GET', '/api/verify/:id', (ctx) => ({ id: ctx.params.id, valid: logic.verifyId(ctx.params.id) }));

// ── internals (opt-in)
route('GET', '/api/queue/info', { internal: true }, () => ({
  gate: gate.info(), metrics, db: require('./database').info(), dm: logic.dmStats(), memory: require('./lib/memory').stats(), uptime: process.uptime()
}));

/* ═══════════════════════════════ STATIC SITE (pre-compressed, in memory) ═══════════════════════════════ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.webmanifest': 'application/manifest+json', '.pdf': 'application/pdf', '.map': 'application/json'
};
let SITE_DIR = null;
const staticCache = new Map(); // abs path → entry

function loadStatic(abs) {
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile() || st.size > 8 * 1024 * 1024) return null;
  const old = staticCache.get(abs);
  if (old && old.mtime === st.mtimeMs && old.size === st.size) { old.checked = Date.now(); return old; }
  const raw = fs.readFileSync(abs);
  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const e = { raw, type, mtime: st.mtimeMs, size: st.size, checked: Date.now(), etag: '"' + crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 20) + '"' };
  if (/text|javascript|json|svg|xml|icon|manifest/.test(type) && raw.length > 512) {
    e.br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
    e.gz = zlib.gzipSync(raw, { level: 9 });
  }
  staticCache.set(abs, e);
  return e;
}
function getStatic(abs) {
  const e = staticCache.get(abs);
  if (e && Date.now() - e.checked < 10000) return e;
  return loadStatic(abs);
}
function serveStatic(req, res, rel) {
  if (!SITE_DIR) return false;
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return false; }
  if (decoded.includes('\0')) return false;
  let abs = path.normalize(path.join(SITE_DIR, decoded));
  if (abs !== SITE_DIR && !abs.startsWith(SITE_DIR + path.sep)) return false;
  try { if (fs.statSync(abs).isDirectory()) abs = path.join(abs, fs.existsSync(path.join(abs, 'index.html')) ? 'index.html' : (path.basename(abs) === 'terms' ? 'terms.html' : 'index.html')); } catch { /* not found below */ }
  const e = getStatic(abs);
  if (!e) return false;
  const isHtml = e.type.startsWith('text/html');
  const headers = { 'Content-Type': e.type, ETag: e.etag, 'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=86400', Vary: 'Accept-Encoding' };
  if (isHtml) headers['Content-Security-Policy'] = CSP;
  if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, headers); res.end(); metrics.s3xx++; return true; }
  let body = e.raw;
  const enc = pickEncoding(req);
  if (enc === 'br' && e.br) { body = e.br; headers['Content-Encoding'] = 'br'; }
  else if (enc && e.gz) { body = e.gz; headers['Content-Encoding'] = 'gzip'; }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  metrics.s2xx++;
  return true;
}
function preloadSite() {
  if (!SITE_DIR || !fs.existsSync(SITE_DIR)) return 0;
  let n = 0;
  const walk = (dir, depth) => {
    if (depth > 4) return;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p, depth + 1);
      else if (n < 1000 && loadStatic(p)) n++;
    }
  };
  walk(SITE_DIR, 0);
  return n;
}
/** Página do comprovante embutida na API (funciona mesmo sem a pasta site/): imagem + baixar + copiar link. */
const escH = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function txPageHtml(req, id) {
  const tx = logic.getTransaction(id);
  const pt = /^pt/i.test(String(req.headers['accept-language'] || '')) || /coin_lang=pt/.test(String(req.headers.cookie || ''));
  const t = (a, b) => (pt ? a : b);
  if (!tx) return { status: 404, html: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404 · Coin Bank</title><body style="font:16px system-ui;background:#101113;color:#e8eaed;display:grid;place-items:center;min-height:100vh;margin:0"><div style="text-align:center"><h1>404</h1><p>${t('Comprovante não encontrado.', 'Receipt not found.')}</p><a style="color:#d6a94b" href="/">Coin Bank</a></div>` };
  const e = encodeURIComponent(tx.id), lang = pt ? 'pt' : 'en';
  const date = new Date(tx.date);
  const rows = [
    [t('Valor', 'Amount'), `<b class="g">${escH(tx.amountCoins)}</b> coins`],
    [t('Tipo', 'Type'), tx.type === 'claim' ? t('Resgate', 'Claim') : t('Transferência', 'Transfer')],
    [t('De', 'From'), `<code>${escH(tx.from)}</code>`], [t('Para', 'To'), `<code>${escH(tx.to)}</code>`],
    [t('Data', 'Date'), escH(isNaN(date) ? tx.date : date.toLocaleString(pt ? 'pt-BR' : 'en-US', { timeZone: 'UTC' }) + ' UTC')], ['ID', `<code>${escH(tx.id)}</code>`]
  ].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t('Comprovante', 'Receipt')} · Coin Bank</title><meta property="og:title" content="${t('Comprovante', 'Receipt')} · ${escH(tx.amountCoins)} coins"><meta property="og:image" content="/api/tx/${e}/receipt.png?lang=${lang}">
<link rel="icon" href="/favicon.ico"><style>:root{color-scheme:light dark}body{margin:0;font:15px/1.55 Inter,system-ui,Roboto,sans-serif;background:#eceef1;color:#14161a}
@media(prefers-color-scheme:dark){body{background:#101113;color:#e8eaed}.c{background:#191b1e!important;border-color:#2a2d33!important}th{color:#a1a7b0!important}.b.s{background:#212328!important;color:#e8eaed!important}}
main{max-width:620px;margin:0 auto;padding:26px 16px 50px}h1{font-size:22px;margin:0 0 4px}.c{background:#fff;border:1px solid #dfe2e7;border-radius:16px;padding:16px;margin:14px 0}
img{width:100%;border-radius:12px;display:block}table{width:100%;border-collapse:collapse}th{text-align:left;color:#5b616b;font-weight:600;padding:6px 0;width:34%;vertical-align:top}td{padding:6px 0;word-break:break-all}
.g{color:#a9802a}code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}.r{display:flex;flex-wrap:wrap;gap:8px}.b{flex:1;min-width:120px;text-align:center;padding:11px 14px;border-radius:12px;background:#23272d;color:#fff;text-decoration:none;font-weight:700;border:0;font-size:14px;cursor:pointer}.b.s{background:#f4f5f7;color:#14161a}
small{color:#8b919b}</style></head><body><main><h1>✓ ${t('Comprovante Coin Bank', 'Coin Bank receipt')}</h1><small>${t('Coins não têm valor real.', 'Coins have no real-world value.')}</small>
<div class="c"><img src="/api/tx/${e}/receipt.png?lang=${lang}" alt="" onerror="this.style.display='none'"><table>${rows}</table></div>
<div class="r"><a class="b" href="/api/tx/${e}/receipt.png?lang=${lang}&download=1">${t('Baixar imagem', 'Download image')}</a><a class="b" href="/api/tx/${e}/receipt.pdf?lang=${lang}&download=1">PDF</a>
<button class="b s" id="cp">${t('Copiar link', 'Copy link')}</button></div><p><small>${t('Link verificável', 'Verifiable link')}: <code id="u"></code></small></p></main>
<script>document.getElementById('u').textContent=location.href;document.getElementById('cp').onclick=function(){var b=this;(navigator.clipboard?navigator.clipboard.writeText(location.href):Promise.reject()).then(function(){b.textContent=${JSON.stringify(t('Link copiado', 'Link copied'))}}).catch(function(){prompt('',location.href)})};</script></body></html>`;
  return { status: 200, html };
}

const NOT_FOUND_HTML = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404 · Coin Bank</title><style>body{font:16px system-ui,sans-serif;background:#101113;color:#e8eaed;display:grid;place-items:center;min-height:100vh;margin:0}a{color:#f1c40f}</style><div style="text-align:center"><h1>404</h1><p>Page not found · Página não encontrada</p><a href="/">Coin Bank</a></div>';

/* ═══════════════════════════════ REQUEST PIPELINE ═══════════════════════════════ */
async function handleApi(req, res, pathname, query) {
  metrics.api++;
  let match = null, allowed = [];
  for (const r of routes) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) { allowed.push(r.method); continue; }
    match = { r, m };
    break;
  }
  if (!match) {
    if (allowed.length) return json(req, res, 405, { error: 'METHOD_NOT_ALLOWED' }, { Allow: [...new Set(allowed)].join(', ') });
    return json(req, res, 404, { error: 'NOT_FOUND' });
  }
  const { r, m } = match;
  if (r.opts.internal && !cfg.api.expose_internals) return json(req, res, 404, { error: 'NOT_FOUND' });

  const ip = clientIp(req);
  const ipk = logic.normalizeIp(ip);
  const rl = cfg.api.rate_limit;
  const wait = take(buckets, ipk, rl.per_ip_per_sec, rl.burst);
  if (wait) { metrics.rateLimited++; return json(req, res, 429, { error: 'RATE_LIMIT_EXCEEDED', retryAfterMs: wait }, { 'Retry-After': String(Math.ceil(wait / 1000)) }); }
  if (r.opts.render) {
    const per = rl.render_per_ip_per_min;
    const w2 = take(renderBuckets, ipk, per / 60, Math.max(2, Math.ceil(per / 2)));
    if (w2) { metrics.rateLimited++; return json(req, res, 429, { error: 'RATE_LIMIT_EXCEEDED', retryAfterMs: w2 }, { 'Retry-After': String(Math.ceil(w2 / 1000)) }); }
  }
  if (r.opts.card) {
    const lockMs = cardLocked(ipk);
    if (lockMs) return json(req, res, 429, { success: false, error: 'CARD_LOCKED', retryAfterMs: lockMs }, { 'Retry-After': String(Math.ceil(lockMs / 1000)) });
  }

  const cookies = parseCookies(req.headers.cookie);
  const ctx = {
    req, ip, ipk, query, cookies, body: {}, params: {},
    device: /^[A-Za-z0-9_-]{16,64}$/.test(cookies.cb_dev || '') ? cookies.cb_dev : null,
    cardFail: () => cardFailed(ipk)
  };
  r.keys.forEach((k, i) => { try { ctx.params[k] = decodeURIComponent(m[i + 1]).slice(0, 128); } catch { ctx.params[k] = ''; } });
  if (!ctx.device) {
    ctx.device = crypto.randomBytes(18).toString('base64url');
    res.setHeader('Set-Cookie', `cb_dev=${ctx.device}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${req._https ? '; Secure' : ''}`);
  }
  if (req.method === 'POST') ctx.body = await readBody(req);

  if (r.opts.auth) {
    const h = String(req.headers.authorization || '');
    const mm = h.match(/^Bearer\s+([A-Za-z0-9]{16,128})$/i);
    ctx.token = mm ? mm[1] : (r.opts.cookie ? cookies.coin_sid : null);
    ctx.userId = ctx.token ? logic.authenticate(ctx.token) : null;
    if (!ctx.userId && r.opts.auth === 'required') return json(req, res, 403, { error: 'operation failed' });
  }

  let out;
  try {
    const exec = () => (r.opts.noGate ? r.handler(ctx) : gate.run(ipk, () => r.handler(ctx)));
    const ik = r.opts.idem ? String(req.headers['idempotency-key'] || '') : '';
    if (ik && /^[A-Za-z0-9_.:-]{8,80}$/.test(ik)) {
      // retries with the same Idempotency-Key never execute a payment twice
      const key = `${r.pattern}|${ctx.userId || ctx.ipk}|${ik}`;
      let p = idem.get(key);
      if (p) res.setHeader('Idempotent-Replay', 'true');
      else { p = exec(); idem.set(key, p); p.catch(() => idem.delete(key)); }
      out = await p;
    } else out = await exec();
  } catch (e) {
    if (e && e.code === 'QUEUE_FULL') metrics.queueFull++;
    if (e && e.code === 'QUEUE_TIMEOUT') metrics.queueTimeout++;
    const { status, body } = errorBody(e);
    if (status >= 500 && !KNOWN_STATUS[e && e.code]) log.error(`${req.method} ${pathname} failed:`, e);
    const extra = status === 429 && body.retryAfterMs ? { 'Retry-After': String(Math.ceil(body.retryAfterMs / 1000)) } : {};
    return json(req, res, status, body, extra);
  }
  if (out && out.__r === 'json') return json(req, res, out.status, out.body, out.headers || {});
  if (out && out.__r === 'file') {
    const headers = { 'Cache-Control': out.cache };
    if (out.name) headers['Content-Disposition'] = `${out.inline ? 'inline' : 'attachment'}; filename="${out.name.replace(/[^\w.\-]/g, '_')}"`;
    return endBody(req, res, 200, out.buf, out.type, headers);
  }
  return json(req, res, 200, out === undefined ? { success: true } : out);
}

async function onRequest(req, res) {
  metrics.requests++;
  req._https = isHttps(req);
  try {
    baseHeaders(req, res);
    const url = req.url || '/';
    if (url.length > 4096) return json(req, res, 414, { error: 'URI_TOO_LONG' });
    const qi = url.indexOf('?');
    let pathname = qi >= 0 ? url.slice(0, qi) : url;
    const query = parseQuery(qi >= 0 ? url.slice(qi + 1) : '');
    if (pathname.includes('//')) pathname = pathname.replace(/\/{2,}/g, '/');

    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Content-Length': 0 }); return res.end(); }
    if (pathname === '/health' || pathname.startsWith('/api/')) return await handleApi(req, res, pathname, query);
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, res, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (/^\/(tx|receipt)\/[^/]+\/?$/.test(pathname)) {
      // site/tx.html quando existe; senão a página embutida (a API sozinha também entrega o comprovante pelo link)
      if (pathname.startsWith('/tx/') && serveStatic(req, res, 'tx.html')) return;
      let id = ''; try { id = decodeURIComponent(pathname.split('/')[2] || '').slice(0, 64); } catch { id = ''; }
      const pg = txPageHtml(req, id);
      return endBody(req, res, pg.status, pg.html, 'text/html; charset=utf-8', { 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP });
    }
    if (!cfg.api.site_enabled) return json(req, res, 404, { error: 'NOT_FOUND' });

    metrics.static++;
    // pretty routes
    if (/^\/pay\/(u\/)?[^/]+\/?$/.test(pathname)) { if (serveStatic(req, res, 'pay.html')) return; }
    if (pathname === '/terms' || pathname === '/terms/') { if (serveStatic(req, res, 'terms/terms.html')) return; }
    let rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (rel.startsWith('site/')) rel = rel.slice(5) || 'index.html';
    if (serveStatic(req, res, rel)) return;
    if (!path.extname(rel) && serveStatic(req, res, rel + '.html')) return;
    endBody(req, res, 404, NOT_FOUND_HTML, 'text/html; charset=utf-8', { 'Cache-Control': 'no-cache' });
  } catch (e) {
    const { status, body } = errorBody(e);
    if (status >= 500) log.error('request failed:', e);
    if (!res.headersSent) json(req, res, status, body);
    else try { res.end(); } catch {}
  }
}

/* ═══════════════════════════════ LIFECYCLE ═══════════════════════════════ */
function init(config) {
  cfg = config;
  trusted = new Set((cfg.cloudflare.trusted_proxies || []).map(String));
  const rl = cfg.api.rate_limit;
  buckets = new LRU({ name: 'api.buckets', max: rl.max_tracked_ips || 200000, ttl: 10 * 60e3 });
  renderBuckets = new LRU({ name: 'api.renderBuckets', max: 50000, ttl: 10 * 60e3 });
  cardFails = new LRU({ name: 'api.cardFails', max: 100000, ttl: 30 * 60e3, soft: false });
  idem = new LRU({ name: 'api.idempotency', max: 100000, ttl: 24 * 3600e3, soft: false });
  gate = new FairGate(cfg.api.queue);
  SITE_DIR = cfg.api.site_enabled ? path.resolve(__dirname, 'site') : null;
}

function start(config) {
  if (server) return Promise.resolve(server);
  init(config);
  const n = preloadSite();
  return new Promise((resolve, reject) => {
    server = http.createServer({ maxHeaderSize: 16384, noDelay: true, requestTimeout: 30000, headersTimeout: 15000, keepAliveTimeout: 5000 }, (req, res) => { onRequest(req, res); });
    server.maxHeadersCount = 64;
    server.maxRequestsPerSocket = 1000;
    server.on('clientError', (e, socket) => { try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); else socket.destroy(); } catch {} });
    server.once('error', (e) => { server = null; reject(e); });
    server.listen(cfg.api.port, cfg.api.host, () => {
      server.removeAllListeners('error');
      server.on('error', (e) => log.error('server error:', e.message));
      log.info(`listening on http://${cfg.api.host}:${cfg.api.port} (${routes.length} routes, ${n} static files cached)`);
      resolve(server);
    });
  });
}

function stop() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const s = server; server = null;
    s.close(() => resolve());
    try { s.closeIdleConnections(); } catch {}
    setTimeout(() => { try { s.closeAllConnections(); } catch {} resolve(); }, 3000).unref();
  });
}

module.exports = { start, stop, init, onRequest, metrics, routes: () => routes.map((r) => `${r.method} ${r.pattern}`), getServer: () => server, FairGate, clientIp };

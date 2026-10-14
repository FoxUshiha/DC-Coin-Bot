'use strict';
/**
 * logic.js — the whole Coin Bank system logic, shared by the HTTP API and the Discord bot.
 *
 *   accounts & sessions (scrypt, 24h tokens) · transfers · claims · bills · cards · wallet backups
 *   statistics & rankings (cached) · DM outbox queue (only active while the bot is online)
 *   balance / network charts and transaction receipts (PNG + PDF, QR verified)
 *   periodic jobs (expired bills, temp files)
 *
 * Everything that touches the disk goes through database.js. Money is always integer sats.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const money = require('./lib/money');
const qr = require('./lib/qr');
const { LRU, SingleFlight, Semaphore } = require('./lib/cache');
const db = require('./database');
const log = require('./lib/log').scope('logic');

const events = new EventEmitter();
events.setMaxListeners(50);

let cfg = null;
let E = null;             // parsed economy settings
let ipSecret = null;
const timers = [];
const caches = {};
const flight = new SingleFlight();
let scryptSem = null;
const renderSem = new Semaphore(2, 300);

const err = (code, status = 400, extra) => db.err(code, status, extra);
const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const iso = (ms) => new Date(ms).toISOString();

/* ═══════════════════════════════ PARSERS / VALIDATION ═══════════════════════════════ */
const ID_RE = /^\d{1,32}$/;
const USERNAME_RE = /^[A-Za-z0-9_.\-]{3,24}$/;
const isId = (v) => typeof v === 'string' ? ID_RE.test(v) : (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
function cleanId(v) {
  if (v === undefined || v === null) return null;
  let s = String(v).trim();
  const m = s.match(/^<@!?(\d+)>$/); if (m) s = m[1];
  return ID_RE.test(s) ? s : null;
}

/** "30d" / "2h" / "45m" / "10s" / number(ms) → milliseconds (null when invalid). */
function parseDuration(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  const m = /^\s*(\d{1,6})\s*([smhdw])\s*$/i.exec(String(v || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return n * { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[m[2].toLowerCase()];
}

function amountOrThrow(input) {
  const sats = money.parse(input);
  if (sats === null) throw err('INVALID_AMOUNT');
  if (sats < E.minSats) throw err('AMOUNT_TOO_SMALL', 400, { min: money.format(E.minSats) });
  return sats;
}

function fmtDuration(ms, lang = 'en') {
  ms = Math.max(0, Math.round(ms));
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const parts = [];
  if (d) parts.push(d + 'd'); if (h) parts.push(h + 'h'); if (m && !d) parts.push(m + 'm'); if (!d && !h && (sec || !parts.length)) parts.push(sec + 's');
  return parts.join(' ') || (lang === 'pt' ? 'agora' : 'now');
}

function fmtDate(v, lang = 'en', withTz = true) {
  const d = new Date(v);
  if (isNaN(d)) return '—';
  const opt = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
  if (cfg && cfg.system.timezone) opt.timeZone = cfg.system.timezone;
  if (withTz) opt.timeZoneName = 'short';
  try { return d.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US', opt); } catch { return d.toISOString(); }
}

/* ═══════════════════════════════ PRIVACY-PRESERVING IP KEYS ═══════════════════════════════ */
/** Normalizes an IP (IPv4-mapped → IPv4, IPv6 → /64 prefix so one host can't rotate addresses). */
function normalizeIp(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7);
  if (s === '::1') return '127.0.0.1';
  if (s.includes(':')) {
    const [head, tail = ''] = s.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const full = s.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
    return full.slice(0, 4).map((x) => x || '0').join(':') + '::/64';
  }
  return s;
}
/** HMAC of the IP: lets us count requests per IP without ever storing who it is. */
function ipKey(ip) { return crypto.createHmac('sha256', ipSecret).update(normalizeIp(ip)).digest('hex').slice(0, 32); }
function deviceKey(id) { return id ? crypto.createHmac('sha256', ipSecret).update('dev:' + id).digest('hex').slice(0, 32) : null; }
const LIMIT_REGISTER_IP = 2, LIMIT_REGISTER_DEVICE = 3;

/* ═══════════════════════════════ PASSWORDS ═══════════════════════════════ */
function scryptAsync(pw, salt, N) {
  return new Promise((res, rej) => crypto.scrypt(pw, salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 + 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
}
/** Hashes the SHA-256 hex digest of a password (keeps the legacy "passwordHash" API working). */
async function hashPassword(shaHex) {
  const N = cfg.api.scrypt_cost;
  const salt = crypto.randomBytes(16);
  const key = await scryptSem.run(() => scryptAsync(shaHex, salt, N));
  return `s2$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(stored, shaHex) {
  if (!stored || !shaHex) return { ok: false };
  if (stored.startsWith('s2$')) {
    const [, n, saltB64, keyB64] = stored.split('$');
    const N = Number(n); if (!N) return { ok: false };
    const key = await scryptSem.run(() => scryptAsync(shaHex, Buffer.from(saltB64, 'base64'), N));
    const want = Buffer.from(keyB64, 'base64');
    return { ok: want.length === key.length && crypto.timingSafeEqual(want, key), upgrade: N !== cfg.api.scrypt_cost };
  }
  if (/^[a-f0-9]{64}$/i.test(stored)) { // legacy unsalted sha256 (old database) → upgraded on login
    const a = Buffer.from(stored.toLowerCase(), 'hex'), b = Buffer.from(String(shaHex).toLowerCase(), 'hex');
    return { ok: a.length === b.length && crypto.timingSafeEqual(a, b), upgrade: true };
  }
  return { ok: false };
}

/* ═══════════════════════════════ SESSIONS ═══════════════════════════════ */
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.createSession({ tokenHash: sha256hex(token), userId, ttlMs: cfg.api.session_ttl_hours * 3600e3, maxPerUser: cfg.api.max_sessions_per_user });
  return token;
}
/** Bearer token → userId or null. */
function authenticate(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) return null;
  const s = db.getSession(sha256hex(token.toLowerCase()));
  return s ? s.user_id : null;
}
async function logout(token) {
  if (typeof token === 'string' && /^[a-f0-9]{64}$/i.test(token)) await db.deleteSession(sha256hex(token.toLowerCase()));
  return { success: true };
}

/* ═══════════════════════════════ ACCOUNTS ═══════════════════════════════ */
function newCardCode() { return crypto.randomBytes(E.cardBytes).toString('hex'); }

async function generateUserId() {
  for (let i = 0; i < 50; i++) {
    let id = String(crypto.randomInt(1, 10));
    while (id.length < 18) id += crypto.randomInt(0, 10);
    if (!db.userExists(id)) return id;
  }
  throw err('ID_GENERATION_FAILED', 500);
}

/** register(username, password, { ip, device }) → { success, userId, sessionId } */
async function register(username, password, { ip, device } = {}) {
  username = String(username || '').trim();
  password = String(password || '');
  if (!USERNAME_RE.test(username)) throw err('INVALID_USERNAME', 400, { message: 'Username must be 3-24 chars: letters, numbers, _ . -' });
  if (password.length < 4 || password.length > 128) throw err('INVALID_PASSWORD');
  const rc = cfg.api.register;
  const windowMs = rc.window_hours * 3600e3;
  const ik = ip ? ipKey(ip) : null, dk = deviceKey(device);
  if (db.usernameTaken(username)) throw err('Username already taken', 409);
  // count the attempt atomically BEFORE the slow work (parallel requests cannot bypass the limit)
  if (ik && (await db.hitLimit(ik, LIMIT_REGISTER_IP, windowMs)) > rc.per_ip) throw err(`Block: max ${rc.per_ip} account(s) per IP every ${rc.window_hours}h.`, 429);
  if (dk && (await db.hitLimit(dk, LIMIT_REGISTER_DEVICE, windowMs)) > rc.per_ip) throw err(`Block: max ${rc.per_ip} account(s) per device every ${rc.window_hours}h.`, 429);
  const userId = await generateUserId();
  const passwordHash = await hashPassword(sha256hex(password));
  if (db.usernameTaken(username)) throw err('Username already taken', 409);
  await db.createAccount({ id: userId, username, passwordHash, cardCode: newCardCode() });
  const sessionId = await createSession(userId);
  events.emit('register', { userId, username });
  return { success: true, userId, sessionId };
}

/** login(username, password, { ip }) → legacy response shape used by the website / clients. */
async function login(username, password, { ip } = {}) {
  username = String(username || '').trim();
  password = String(password || '');
  const fail = { sessionCreated: false, passwordCorrect: false };
  if (!username || !password || username.length > 64 || password.length > 256) return fail;
  const k = ip ? ipKey(ip) : 'none';
  const lock = caches.loginFails.get(k);
  const now = Date.now();
  if (lock && lock.until > now) return { ...fail, error: 'IP_LOCKED', retryAfterMs: lock.until - now };
  const user = db.getUserByUsername(username);
  const v = user && user.password ? await verifyPassword(user.password, sha256hex(password)) : { ok: false };
  if (!v.ok) {
    const n = (lock && lock.until <= now && lock.n >= cfg.api.login.max_failures ? 0 : (lock ? lock.n : 0)) + 1;
    const until = n >= cfg.api.login.max_failures ? now + cfg.api.login.lock_seconds * 1000 : 0;
    caches.loginFails.set(k, { n, until }, Math.max(cfg.api.login.lock_seconds * 1000, 60e3));
    return fail;
  }
  caches.loginFails.delete(k);
  if (v.upgrade) hashPassword(sha256hex(password)).then((h) => db.setPassword(user.id, h)).catch(() => {});
  if (!db.getCardByOwner(user.id)) await db.setCard(user.id, newCardCode());
  const sessionId = await createSession(user.id);
  const st = claimStatus(user.id);
  return {
    sessionCreated: true, passwordCorrect: true, userId: user.id, sessionId,
    saldo: money.format(user.coins), sats: user.coins, cooldownRemainingMs: st.cooldownRemainingMs
  };
}

function validNewUsername(username, userId) {
  if (!USERNAME_RE.test(username)) throw err('INVALID_USERNAME', 400, { message: 'Username must be 3-24 chars: letters, numbers, _ . -' });
  if (db.usernameTaken(username, userId)) throw err('Username already taken', 409);
}

/** Changes username (optional) + password; revokes every session (forces a new login). */
async function changeAccount(userId, { username, password }) {
  password = String(password || '');
  if (password.length < 4 || password.length > 128) throw err('INVALID_PASSWORD');
  const u = db.getUser(userId);
  let name = username !== undefined && username !== null && String(username).trim() !== '' ? String(username).trim() : (u && u.username);
  if (!name) throw err('Missing parameters');
  if (!u || name !== u.username) validNewUsername(name, userId);
  await db.changeCredentials(userId, name, await hashPassword(sha256hex(password)));
  return { success: true };
}
/** Legacy /api/account/update: receives the SHA-256 hex of the new password. */
async function accountUpdate(userId, username, passwordHash) {
  username = String(username || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(String(passwordHash || ''))) throw err('Missing parameters');
  const u = db.getUser(userId);
  if (!u || username !== u.username) validNewUsername(username, userId);
  await db.changeCredentials(userId, username, await hashPassword(String(passwordHash).toLowerCase()));
  return { success: true };
}
/** Removes login credentials (balance and Discord account stay intact). */
async function unregister(userId) {
  await db.changeCredentials(userId, null, null);
  return { success: true };
}
/** Discord /user modal: create or update site credentials for a Discord account. */
async function setDiscordCredentials(userId, username, password) {
  username = String(username || '').trim();
  const u = db.getUser(userId);
  if (!u || username !== u.username) validNewUsername(username, userId);
  if (String(password || '').length < 4) throw err('INVALID_PASSWORD');
  await db.changeCredentials(userId, username, await hashPassword(sha256hex(password)));
  if (!db.getCardByOwner(userId)) await db.setCard(userId, newCardCode());
  return { success: true, created: !u || !u.username };
}

/* ═══════════════════════════════ BALANCES / TRANSFERS / CLAIMS ═══════════════════════════════ */
const balance = (userId) => db.getBalance(String(userId));

function txView(r) {
  if (!r) return null;
  const sats = Number(r.amount);
  return { id: r.id, date: r.date, from: r.from_id, to: r.to_id, amountSats: sats, amountCoins: money.format(sats), type: r.from_id === E.systemId ? 'claim' : 'transfer' };
}

async function notifyTransfer(tx, source) {
  if (!cfg.dm_queue.notify_transfers || tx.to === E.systemId) return;
  enqueueDM(tx.to, dmEmbed({
    color: 0x2ECC71, titleEn: '💸 Coins received', titlePt: '💸 Coins recebidos',
    en: [`You received **${money.format(tx.amount)}** coins from \`${tx.from}\`.`, `Transaction: \`${tx.txId}\``],
    pt: [`Você recebeu **${money.format(tx.amount)}** coins de \`${tx.from}\`.`, `Transação: \`${tx.txId}\``],
    footer: source
  }), { receipt: tx.txId });
}

/** transfer(from, to, amount) → { success, txId, date, amount, amountSats } */
async function transfer(from, to, amount, { source = 'api' } = {}) {
  from = cleanId(from); to = cleanId(to);
  if (!from || !to) throw err('INVALID_TARGET');
  if (to === E.systemId) throw err('INVALID_TARGET');
  if (from === to) throw err('SELF_TRANSFER');
  const sats = amountOrThrow(amount);
  const tx = await db.transfer({ from, to, sats, cooldownMs: E.transferCooldown });
  events.emit('transfer', { ...tx, source });
  notifyTransfer(tx, source).catch(() => {});
  return { success: true, txId: tx.txId, date: tx.date, from, to, amount: money.format(sats), amountSats: sats };
}

function claimStatus(userId) {
  const u = db.getUser(String(userId));
  const last = u ? Number(u.cooldown || 0) : 0;
  const remaining = last ? Math.max(0, last + E.claimCooldown - Date.now()) : 0;
  return { cooldownRemainingMs: remaining, lastClaimTimestamp: last, cooldownMs: E.claimCooldown, claimAmount: money.format(E.claimSats), claimAmountSats: E.claimSats };
}

/** claim(userId) → { success, claimed, txId, date } — throws COOLDOWN_ACTIVE (429). */
async function claim(userId, { source = 'api' } = {}) {
  userId = cleanId(userId);
  if (!userId || userId === E.systemId) throw err('INVALID_TARGET');
  const r = await db.claim({ userId, sats: E.claimSats, cooldownMs: E.claimCooldown, maxSupply: E.maxSupply, systemId: E.systemId });
  events.emit('claim', { userId, ...r, source });
  return { success: true, claimed: money.format(r.amount), claimedSats: r.amount, txId: r.txId, date: r.date, nextClaimInMs: E.claimCooldown };
}

/* ═══════════════════════════════ CARDS ═══════════════════════════════ */
async function getCard(userId) {
  let code = db.getCardByOwner(String(userId));
  if (!code) code = await db.setCard(String(userId), newCardCode());
  return code;
}
const resetCard = (userId) => db.setCard(String(userId), newCardCode());
const cardOwner = (code) => (typeof code === 'string' ? db.getCardOwner(code.trim()) : null);
const cardOwnerByHash = (hash) => db.getCardOwnerByHash(hash);

function txCount(userId) {
  const v = caches.txCount.get(userId);
  return v !== undefined ? v : caches.txCount.set(userId, db.countTransactions(userId));
}

function accountSummary(userId) {
  userId = String(userId);
  const u = db.getUser(userId);
  const sats = u ? u.coins : 0;
  const st = claimStatus(userId);
  return {
    userId, username: u ? u.username || null : null, sats, coins: money.format(sats),
    totalTransactions: txCount(userId), lastClaimTs: st.lastClaimTimestamp, cooldownRemainingMs: st.cooldownRemainingMs, cooldownMs: st.cooldownMs,
    registered: !!(u && u.username), createdAt: u ? u.created_at || null : null
  };
}

function cardInfo(code) {
  const owner = cardOwner(code);
  if (!owner) return { found: false };
  return { found: true, ...accountSummary(owner) };
}
async function claimByCard(code) {
  const owner = cardOwner(code);
  if (!owner) throw err('CARD_NOT_FOUND', 404);
  return claim(owner, { source: 'card' });
}
async function transferByCard(code, toId, amount) {
  const owner = cardOwner(code);
  if (!owner) throw err('CARD_NOT_FOUND', 404);
  return transfer(owner, toId, amount, { source: 'card' });
}
async function payBetweenCards(fromCard, toCard, amount) {
  if (!fromCard || !toCard) throw err('Invalid parameters');
  if (String(fromCard).trim() === String(toCard).trim()) throw err('SAME_CARD');
  const from = cardOwner(fromCard); if (!from) throw err('FROM_CARD_NOT_FOUND', 404);
  const to = cardOwner(toCard); if (!to) throw err('TO_CARD_NOT_FOUND', 404);
  return transfer(from, to, amount, { source: 'card' });
}

/* ═══════════════════════════════ BILLS ═══════════════════════════════ */
function billExpiry(time) {
  let ms = time === undefined || time === null || time === '' ? E.billDefault : parseDuration(time);
  if (ms === null) throw err('INVALID_TIME', 400, { message: 'Use 30d, 12h, 45m or 30s' });
  // absolute timestamp support (old clients sent a ms timestamp)
  if (ms > 1e12) ms = ms - Date.now();
  return Date.now() + Math.min(E.billMax, Math.max(E.billMin, ms));
}

/** createBill({ fromId (payer, optional), toId (receiver), amount, time }) */
async function createBill({ fromId, toId, amount, time }) {
  const to = cleanId(toId);
  if (!to || to === E.systemId) throw err('Invalid parameters');
  const from = fromId === undefined || fromId === null || String(fromId).trim() === '' ? '' : cleanId(fromId);
  if (from === null) throw err('Invalid parameters');
  const sats = amountOrThrow(amount);
  const expiresAt = billExpiry(time);
  const billId = await db.createBill({ from, to, sats, expiresAt });
  events.emit('bill.created', { billId, from, to, sats });
  return { success: true, billId, from: from || null, to, amount: money.format(sats), amountSats: sats, expiresAt };
}
async function createBillByCard({ fromCard, toCard, amount, time }) {
  const to = toCard ? cardOwner(toCard) : null;
  if (!to) throw err(toCard ? 'TO_CARD_NOT_FOUND' : 'Invalid parameters', toCard ? 404 : 400);
  let from = '';
  if (fromCard) { from = cardOwner(fromCard); if (!from) throw err('FROM_CARD_NOT_FOUND', 404); }
  return createBill({ fromId: from, toId: to, amount, time });
}

function billView(b) {
  const sats = Number(b.amount);
  return { id: b.id || b.bill_id, from_id: b.from_id || null, to_id: b.to_id, amount: money.format(sats), amountSats: sats, date: b.date, expiresAt: b.expires_at || null };
}
const getBill = (id) => { const b = db.getBill(String(id || '')); return b ? billView(b) : null; };

/** payBill(payerId, billId) → { success, billId, txId, toId, amount, date, self } */
async function payBill(payerId, billId, { source = 'api' } = {}) {
  payerId = cleanId(payerId);
  if (!payerId || !billId || typeof billId !== 'string' || billId.length > 64) throw err('Missing billId');
  const r = await db.payBill({ billId: billId.trim(), payer: payerId, cooldownMs: E.transferCooldown });
  const amt = money.format(r.amount);
  events.emit('bill.paid', { ...r, source });
  if (cfg.dm_queue.notify_bills) {
    if (r.self) {
      enqueueDM(payerId, dmEmbed({ color: 0x95A5A6, titleEn: '🏦 Bill cancelled', titlePt: '🏦 Cobrança cancelada',
        en: [`Bill \`${r.bill.id}\` (**${amt}** coins) was closed by yourself — no coins moved.`], pt: [`A cobrança \`${r.bill.id}\` (**${amt}** coins) foi encerrada por você — nenhum coin foi movido.`] }));
    } else {
      enqueueDM(r.to, dmEmbed({ color: 0x2ECC71, titleEn: '🏦 Bill paid', titlePt: '🏦 Cobrança paga',
        en: [`You received **${amt}** coins from \`${payerId}\`.`, `Bill ID: \`${r.bill.id}\``], pt: [`Você recebeu **${amt}** coins de \`${payerId}\`.`, `ID da cobrança: \`${r.bill.id}\``] }), { receipt: r.txId });
      if (r.bill.from_id && r.bill.from_id !== payerId && r.bill.from_id !== r.to) {
        enqueueDM(r.bill.from_id, dmEmbed({ color: 0x3498DB, titleEn: '🏦 A bill addressed to you was paid', titlePt: '🏦 Uma cobrança para você foi paga',
          en: [`Bill \`${r.bill.id}\` (**${amt}** coins) was paid by \`${payerId}\`.`], pt: [`A cobrança \`${r.bill.id}\` (**${amt}** coins) foi paga por \`${payerId}\`.`] }));
      }
    }
  }
  return { success: true, billId: r.bill.id, txId: r.txId, toId: r.to, amount: amt, amountSats: r.amount, date: r.date, self: r.self };
}
async function payBillByCard(code, billId) {
  const owner = cardOwner(code);
  if (!owner) throw err('CARD_NOT_FOUND', 404);
  return payBill(owner, billId, { source: 'card' });
}

/** bills where the user must pay (from_id = user) and bills the user will receive (to_id = user). */
function listBills(userId, page = 1, size = 10) {
  page = Math.max(1, Math.min(10000, Number(page) || 1));
  const off = (page - 1) * size;
  return {
    toPay: db.listBillsFrom(String(userId), size, off).map(billView),
    toReceive: db.listBillsTo(String(userId), size, off).map(billView),
    page
  };
}

/* ═══════════════════════════════ WALLET BACKUPS ═══════════════════════════════ */
async function createBackups(userId) {
  userId = String(userId);
  if (balance(userId) <= 0) throw err('EMPTY_WALLET');
  const codes = db.listBackupCodes(userId).slice(0, E.backupCodes);
  const fresh = [];
  while (codes.length + fresh.length < E.backupCodes) fresh.push(crypto.randomBytes(12).toString('hex'));
  if (fresh.length) await db.addBackupCodes(userId, fresh);
  return db.listBackupCodes(userId).slice(0, E.backupCodes);
}
const listBackups = (userId) => db.listBackupCodes(String(userId));
async function restoreBackup(userId, code) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(code.trim())) throw err('BACKUP_NOT_FOUND', 404);
  const r = await db.restoreBackup({ code: code.trim(), userId: String(userId) });
  events.emit('transfer', { ...r, source: 'restore' });
  return { success: true, txId: r.txId, date: r.date, from: r.fromUser, amount: money.format(r.amount), amountSats: r.amount };
}

/* ═══════════════════════════════ LEDGER QUERIES ═══════════════════════════════ */
function getTransaction(id) {
  if (typeof id !== 'string' || id.length < 1 || id.length > 64) return null;
  return txView(db.getTransaction(id.trim()));
}
/** website history: 20 per page, amount as 8-decimal string (+ amountSats). */
function listTransactions(userId, page = 1, size = 20) {
  page = Math.max(1, Math.min(100000, Number(page) || 1));
  return db.listTransactions(String(userId), size, (page - 1) * size).map((r) => ({
    id: r.id, date: r.date, from_id: r.from_id, to_id: r.to_id, amount: money.format(r.amount), amountSats: Number(r.amount)
  }));
}
function verifyId(id) {
  if (!id || typeof id !== 'string') return false;
  if (db.getBill(id)) return false;
  return !!db.getTransaction(id);
}

/* ═══════════════════════════════ STATS / RANK (cached) ═══════════════════════════════ */
function stats() {
  return caches.stats.get('s') || caches.stats.set('s', (() => {
    const s = db.stats(Date.now(), E.systemId);
    return {
      totalUsers: s.totalUsers, newUsers24h: s.newUsers24h, holders: s.holders,
      totalCoins: money.format(s.totalCoins), totalSats: s.totalCoins,
      totalMinted: money.format(s.totalMinted), maxSupply: E.maxSupply ? money.format(E.maxSupply) : null,
      totalTransactions: s.totalTransactions, transactions24h: s.transactions24h,
      volume24h: money.format(s.volume24h), volume24hSats: s.volume24h,
      activeUsers24h: s.activeUsers24h, totalCards: s.totalCards, openBills: s.openBills,
      totalClaims: s.totalClaims, claims24h: s.claims24h,
      claimAmount: money.format(E.claimSats), claimCooldownMs: E.claimCooldown,
      updatedAt: new Date().toISOString()
    };
  })());
}
function totalUsers() { return { totalUsers: stats().totalUsers }; }

function statsHistory(days = 30) {
  days = Math.max(1, Math.min(365, Number(days) || 30));
  return caches.history.get(days) || caches.history.set(days, (() => {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - (days - 1));
    const rows = db.historyDays(start.toISOString(), E.systemId);
    const map = new Map(rows.map((r) => [r.d, r]));
    const out = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start.getTime() + i * 864e5).toISOString().slice(0, 10);
      const r = map.get(d);
      out.push({ date: d, transactions: r ? r.n : 0, volume: money.format(r ? r.v : 0), volumeSats: r ? Number(r.v) : 0, claims: r ? r.c : 0 });
    }
    return { days: out };
  })());
}
function statsRecent(limit = 10) {
  limit = Math.max(1, Math.min(50, Number(limit) || 10));
  return caches.recent.get(limit) || caches.recent.set(limit, { transactions: db.recentTransactions(limit).map((r) => ({ ...txView(r), amount: money.format(r.amount) })) });
}
function rank(page = 1, size = 25) {
  page = Math.max(1, Math.min(100000, Number(page) || 1));
  size = Math.max(1, Math.min(100, Number(size) || 25));
  const key = page + ':' + size;
  return caches.rank.get(key) || caches.rank.set(key, (() => {
    const rows = db.topUsers(size, (page - 1) * size, E.systemId);
    const total = db.totalCoins();
    const holders = db.holderCount();
    return {
      totalCoins: money.format(total), totalSats: total, totalHolders: holders, page, pages: Math.max(1, Math.ceil(holders / size)),
      rankings: rows.map((u, i) => ({ position: (page - 1) * size + i + 1, id: u.id, username: u.username || 'none', coins: money.format(u.coins), sats: u.coins }))
    };
  })());
}
function rankPosition(userId) {
  const b = balance(userId);
  return b > 0 ? db.rankOf(b, E.systemId) : null;
}

/* ═══════════════════════════════ PERMISSIONS / GUILD SETTINGS ═══════════════════════════════ */
function staffSet() {
  return caches.staff.get('s') || caches.staff.set('s', new Set([...cfg.discord.staff, ...db.listStaff().map((r) => r.user_id)]));
}
const isOwner = (id) => cfg.discord.owners.includes(String(id));
const isStaff = (id) => isOwner(id) || staffSet().has(String(id));
async function addStaff(id, by) { await db.addStaff(id, by); caches.staff.clear(); }
async function removeStaff(id) { await db.removeStaff(id); caches.staff.clear(); }
const listStaff = () => ({ config: cfg.discord.staff, runtime: db.listStaff() });
const getGuild = (gid) => db.getServer(gid) || { server_id: String(gid), api_channel: null, atm_channel: null, lang: null, cmds_purged: 0 };
const setGuild = (gid, fields) => db.setServer(gid, fields);

/* ═══════════════════════════════ DM OUTBOX QUEUE ═══════════════════════════════ */
/**
 * The queue persists DMs in the database. It only *runs* while a sender is attached
 * (the Discord bot attaches it on "ready" and detaches it when it goes offline).
 * If the bot is disabled in config.yml nothing is queued at all.
 */
const dm = { sender: null, running: false, timer: null, sent: 0, failed: 0, wake: null, gen: 0 };

function dmEmbed({ titleEn, titlePt, en = [], pt = [], color = 0xF1C40F, footer, fields }) {
  const embed = {
    color,
    title: titleEn === titlePt || !titlePt ? titleEn : `${titleEn} · ${titlePt}`,
    description: ['🇺🇸 ' + en.join('\n'), '', '🇧🇷 ' + pt.join('\n')].join('\n').slice(0, 4000),
    timestamp: new Date().toISOString(),
    footer: { text: 'Coin Bank' + (footer ? ' • ' + footer : '') }
  };
  if (fields) embed.fields = fields;
  return { embeds: [embed] };
}

/** enqueueDM(userId, payload, meta) — payload is a discord message body ({ embeds, components }). */
function enqueueDM(userId, payload, meta) {
  if (!cfg.discord.enabled || !cfg.dm_queue.enabled) return Promise.resolve(false);
  const id = cleanId(userId);
  if (!id || id === E.systemId) return Promise.resolve(false);
  const body = Buffer.from(JSON.stringify(meta ? { ...payload, _meta: meta } : payload));
  return db.enqueueDM(id, zlib.deflateRawSync(body)).then(() => { if (dm.wake) dm.wake(); return true; }).catch((e) => { log.warn('enqueueDM failed:', e.message); return false; });
}

function attachDMSender(fn) {
  dm.sender = fn;
  if (!cfg.dm_queue.enabled || dm.running) return;
  dm.running = true;
  log.info('DM queue active (bot online)');
  dmLoop(++dm.gen);
}
function detachDMSender() {
  if (dm.running) log.info('DM queue paused (bot offline)');
  dm.sender = null; dm.running = false; dm.gen++;
  if (dm.timer) clearTimeout(dm.timer);
  if (dm.wake) dm.wake();
}

function sleepWake(ms) {
  return new Promise((res) => {
    dm.timer = setTimeout(() => { dm.wake = null; res(); }, ms);
    dm.wake = () => { clearTimeout(dm.timer); dm.wake = null; res(); };
  });
}

async function dmLoop(gen) {
  const alive = () => dm.running && dm.sender && gen === dm.gen;
  while (alive()) {
    let jobs = [];
    try { jobs = db.dueDMs(Date.now(), 10); } catch (e) { log.warn('dm queue read failed:', e.message); }
    if (!jobs.length) { await sleepWake(5000); continue; }
    for (const job of jobs) {
      if (!alive()) break;
      if ((await db.holdDM(job.id, Date.now() + 120000)) !== 1) continue; // another worker owns it
      let payload;
      try { payload = JSON.parse(zlib.inflateRawSync(job.payload).toString('utf8')); } catch { await db.deleteDM(job.id); continue; }
      try {
        await dm.sender(job.user_id, payload);
        dm.sent++;
        await db.deleteDM(job.id);
      } catch (e) {
        const code = e && (e.code || e.rawError && e.rawError.code);
        const permanent = [50007, 10013, 50033, 10003].includes(Number(code)) || e.status === 403 || e.status === 404;
        dm.failed++;
        if (permanent || job.attempts + 1 >= cfg.dm_queue.max_attempts) await db.deleteDM(job.id);
        else await db.retryDM(job.id, Date.now() + Math.min(3600e3, 30e3 * Math.pow(2, job.attempts)));
        log.debug(`DM to ${job.user_id} failed (${code || e.message})${permanent ? ' — dropped' : ''}`);
      }
      await new Promise((r) => setTimeout(r, cfg.dm_queue.interval_ms));
    }
  }
}

/* ═══════════════════════════════ RENDERING (charts / receipts) ═══════════════════════════════ */
let sharpMod; // undefined = not tried, null = unavailable
function sharp() {
  if (sharpMod !== undefined) return sharpMod;
  try {
    sharpMod = require('sharp');
    sharpMod.cache(false);           // no libvips cache (low RAM)
    sharpMod.concurrency(1);
    sharpMod.simd(true);
  } catch (e) {
    sharpMod = null;
    log.warn('sharp not installed — PNG/PDF rendering disabled (npm i sharp). SVG still available.');
  }
  return sharpMod;
}
const canRender = () => !!sharp();
const xmlEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FONT = `Inter, 'Segoe UI', 'DejaVu Sans', Arial, Helvetica, sans-serif`;
const MONO = `'DejaVu Sans Mono', Consolas, Menlo, 'Courier New', monospace`;

let logoUri = null;
async function logo() {
  if (logoUri !== null) return logoUri;
  const file = path.join(__dirname, 'assets', 'icon.png');
  try {
    const s = sharp();
    const buf = s ? await s(file).resize(192, 192, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer() : fs.readFileSync(file);
    logoUri = 'data:image/png;base64,' + buf.toString('base64');
  } catch { logoUri = ''; }
  return logoUri;
}

const RT = {
  en: { company: 'Coin Bank', desc: 'Digital financial system · Coin System', title: 'TRANSFER RECEIPT', titleClaim: 'REWARD RECEIPT', status: 'TRANSACTION CONFIRMED',
    amount: 'Amount', sats: 'Amount in sats', from: 'Source (ID)', to: 'Destination (ID)', id: 'Transaction ID', date: 'Date & time', type: 'Type',
    typeT: 'Coin transfer', typeC: 'Daily reward (claim)', verify: 'Verify at:', foot: 'Automatically generated document. Authenticity can be checked with the QR code.', gen: 'Generated on', coins: 'coins' },
  pt: { company: 'Coin Bank', desc: 'Sistema financeiro digital · Coin System', title: 'COMPROVANTE DE TRANSFERÊNCIA', titleClaim: 'COMPROVANTE DE RECOMPENSA', status: 'TRANSAÇÃO CONFIRMADA',
    amount: 'Valor', sats: 'Valor em sats', from: 'Origem (ID)', to: 'Destino (ID)', id: 'ID da transação', date: 'Data e hora', type: 'Tipo',
    typeT: 'Transferência de coins', typeC: 'Recompensa diária (claim)', verify: 'Verifique em:', foot: 'Documento gerado automaticamente. A autenticidade pode ser conferida pelo QR code.', gen: 'Gerado em', coins: 'coins' }
};

const publicUrl = () => String(cfg.api.public_url || '').replace(/\/+$/, '');
const txUrl = (id) => `${publicUrl()}/tx/${encodeURIComponent(id)}`;

async function receiptSvg(tx, lang = 'en') {
  const T = RT[lang] || RT.en; const W = 1000, H = 1400;
  const claimTx = tx.from === E.systemId;
  const url = txUrl(tx.id);
  const host = publicUrl().replace(/^https?:\/\//, '');
  const lg = await logo();
  const status = T.status;
  const bw = Math.max(320, Math.round(status.length * 14.5 + 90));
  const fields = [
    [T.amount, `${money.pretty(tx.amountSats, lang)} ${T.coins}`, false],
    [T.sats, `${tx.amountSats.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US')} sats`, false],
    [T.type, claimTx ? T.typeC : T.typeT, false],
    [T.from, tx.from, true], [T.to, tx.to, true], [T.id, tx.id, true],
    [T.date, fmtDate(tx.date, lang), false]
  ];
  let y = 400; let body = '';
  for (const [label, value, mono] of fields) {
    const v = String(value == null || value === '' ? '—' : value);
    body += `<text x="80" y="${y}" font-family="${FONT}" font-size="14" fill="#888" letter-spacing="0.6">${xmlEsc(label.toUpperCase())}</text>`;
    body += `<text x="80" y="${y + 28}" font-family="${mono ? MONO : FONT}" font-size="${mono ? 19 : 21}" font-weight="700" fill="#111">${xmlEsc(v.length > 70 ? v.slice(0, 67) + '...' : v)}</text>`;
    y += 66;
  }
  y += 24;
  const qs = 240, mod = qr.encode(url, 'M'), cell = qs / (mod.size + 2);
  const q = qr.svgPath(url, (W - qs) / 2 + cell, y + cell, cell, 'M');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#ffffff"/>
${lg ? `<image x="${W - 160}" y="40" width="100" height="100" xlink:href="${lg}" href="${lg}"/>` : ''}
<text x="60" y="90" font-family="${FONT}" font-size="32" font-weight="800" fill="#111">${xmlEsc(T.company)}</text>
<text x="60" y="118" font-family="${FONT}" font-size="16" fill="#666">${xmlEsc(T.desc)}</text>
<text x="60" y="140" font-family="${FONT}" font-size="13" fill="#999">${xmlEsc(host)}</text>
<rect x="60" y="179" width="${W - 120}" height="2" fill="#111"/>
<text x="${W / 2}" y="240" text-anchor="middle" font-family="${FONT}" font-size="28" font-weight="800" fill="#111" letter-spacing="0.5">${xmlEsc(claimTx ? T.titleClaim : T.title)}</text>
<rect x="${(W - bw) / 2}" y="268" width="${bw}" height="62" rx="10" fill="#0ecb81"/>
<text x="${W / 2}" y="308" text-anchor="middle" font-family="${FONT}" font-size="22" font-weight="800" fill="#fff" letter-spacing="1">${xmlEsc(status)}</text>
${body}
<rect x="${(W - qs) / 2}" y="${y}" width="${qs}" height="${qs}" fill="#fff"/>
<path d="${q.d}" fill="#000"/>
<text x="${W / 2}" y="${y + qs + 30}" text-anchor="middle" font-family="${FONT}" font-size="14" fill="#666">${xmlEsc(T.verify)}</text>
<text x="${W / 2}" y="${y + qs + 54}" text-anchor="middle" font-family="${FONT}" font-size="15" font-weight="700" fill="#0ecb81">${xmlEsc(url.length > 90 ? url.slice(0, 87) + '...' : url)}</text>
<text x="${W / 2}" y="${H - 60}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="#aaa">${xmlEsc(T.foot)}</text>
<text x="${W / 2}" y="${H - 40}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="#aaa">${xmlEsc(`${T.gen} ${fmtDate(Date.now(), lang)}`)}</text>
</svg>`;
}

/** Generic dark chart: line (balance/volume) + bars (in/out or count). */
const shortL = (sats, lang) => (lang === 'pt' ? money.short(sats).replace('.', ',') : money.short(sats));
function chartSvg({ title, subtitle, big, bigSub, labels, line, up, down, lang = 'en', lineFmt = (v) => shortL(v, lang), barsLabel }) {
  const W = 1000, H = 540, padL = 40, padR = 120, top = 150, lineH = 250, volTop = 425, volH = 70;
  const n = Math.max(1, line.length), pw = W - padL - padR, step = pw / n, xAt = (i) => padL + (i + 0.5) * step;
  let mn = Math.min(...line), mx = Math.max(...line);
  if (mx === mn) { const d = Math.max(Math.abs(mx) * 0.1, 100); mn -= d; mx += d; } else { const d = (mx - mn) * 0.12; mn -= d; mx += d; }
  if (Math.min(...line) >= 0 && mn < 0) mn = 0;
  const yAt = (v) => top + lineH - ((v - mn) / (mx - mn || 1)) * lineH;
  let grid = '';
  for (let k = 0; k <= 4; k++) {
    const v = mn + (mx - mn) * (k / 4), y = yAt(v).toFixed(1);
    grid += `<line x1="${padL}" y1="${y}" x2="${padL + pw}" y2="${y}" stroke="#ffffff" stroke-opacity="0.07" stroke-dasharray="3 5"/>`;
    grid += `<text x="${padL + pw + 12}" y="${(+y + 4).toFixed(1)}" font-family="${FONT}" font-size="13" fill="#b5bac1">${xmlEsc(lineFmt(Math.round(v)))}</text>`;
  }
  const pts = line.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`);
  if (n === 1) pts.unshift(`${padL},${yAt(line[0]).toFixed(1)}`), pts.push(`${padL + pw},${yAt(line[0]).toFixed(1)}`);
  const area = `M${pts[0]} L${pts.slice(1).join(' L')} L${pts[pts.length - 1].split(',')[0]},${top + lineH} L${pts[0].split(',')[0]},${top + lineH} Z`;
  const vmax = Math.max(1, ...(up || [0]), ...(down || [0]));
  const bw = Math.max(2, Math.min(18, step * 0.6));
  const mid = down ? volTop + volH / 2 : volTop + volH, half = down ? volH / 2 : volH;
  let bars = `<line x1="${padL}" y1="${mid}" x2="${padL + pw}" y2="${mid}" stroke="#ffffff" stroke-opacity="0.12"/>`;
  for (let i = 0; i < n; i++) {
    const x = (xAt(i) - bw / 2).toFixed(1);
    const hu = up ? (up[i] / vmax) * half : 0, hd = down ? (down[i] / vmax) * half : 0;
    if (hu > 0.3) bars += `<rect x="${x}" y="${(mid - hu).toFixed(1)}" width="${bw.toFixed(1)}" height="${hu.toFixed(1)}" rx="2" fill="#23a55a" fill-opacity="0.9"/>`;
    if (hd > 0.3) bars += `<rect x="${x}" y="${mid.toFixed(1)}" width="${bw.toFixed(1)}" height="${hd.toFixed(1)}" rx="2" fill="#f23f43" fill-opacity="0.9"/>`;
  }
  let xl = '';
  const ticks = Math.min(n, 7);
  for (let k = 0; k < ticks; k++) {
    const i = ticks === 1 ? n - 1 : Math.round((k * (n - 1)) / (ticks - 1));
    const d = new Date(labels[i] + 'T12:00:00Z');
    const lbl = isNaN(d) ? labels[i] : d.toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US', { day: '2-digit', month: 'short', timeZone: 'UTC' });
    xl += `<text x="${xAt(i).toFixed(1)}" y="${H - 18}" text-anchor="middle" font-family="${FONT}" font-size="13" fill="#949ba4">${xmlEsc(lbl)}</text>`;
  }
  const last = pts[pts.length - 1].split(',');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f1c40f" stop-opacity="0.35"/><stop offset="1" stop-color="#f1c40f" stop-opacity="0"/></linearGradient></defs>
<rect width="${W}" height="${H}" rx="18" fill="#1e1f22"/>
<text x="${padL}" y="52" font-family="${FONT}" font-size="22" font-weight="800" fill="#f2f3f5">${xmlEsc(title)}</text>
<text x="${padL}" y="78" font-family="${FONT}" font-size="14" fill="#949ba4">${xmlEsc(subtitle || '')}</text>
<text x="${W - 40}" y="56" text-anchor="end" font-family="${FONT}" font-size="30" font-weight="800" fill="#f1c40f">${xmlEsc(big || '')}</text>
<text x="${W - 40}" y="82" text-anchor="end" font-family="${FONT}" font-size="14" fill="${bigSub && /^-/.test(bigSub) ? '#f23f43' : '#23a55a'}">${xmlEsc(bigSub || '')}</text>
${grid}
<path d="${area}" fill="url(#g)"/>
<polyline points="${pts.join(' ')}" fill="none" stroke="#f1c40f" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${last[0]}" cy="${last[1]}" r="8" fill="#f1c40f" fill-opacity="0.25"/><circle cx="${last[0]}" cy="${last[1]}" r="4.5" fill="#f1c40f"/>
${bars}
${barsLabel ? `<text x="${padL}" y="${volTop - 8}" font-family="${FONT}" font-size="12" fill="#949ba4">${xmlEsc(barsLabel)}</text>` : ''}
${xl}
</svg>`;
}

/** Balance series (end-of-day, UTC) for the last `days` days, computed from the ledger. */
function balanceSeries(userId, days = 30) {
  days = Math.max(2, Math.min(365, Number(days) || 30));
  const start = new Date(); start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() - (days - 1));
  const flow = db.dailyFlow(String(userId), start.toISOString());
  const labels = [], inn = [], out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 864e5).toISOString().slice(0, 10);
    labels.push(d); inn.push(flow[d] ? flow[d].in : 0); out.push(flow[d] ? flow[d].out : 0);
  }
  const bal = new Array(days).fill(0);
  let run = balance(userId);
  for (let i = days - 1; i >= 0; i--) { bal[i] = Math.max(0, run); run = run - inn[i] + out[i]; }
  return { labels, balances: bal, in: inn, out, current: balance(userId) };
}

async function userChartSvg(userId, days = 30, lang = 'en', displayName) {
  const s = balanceSeries(userId, days);
  const first = s.balances[0], lastV = s.balances[s.balances.length - 1];
  const diff = lastV - first;
  const pct = first > 0 ? ((diff / first) * 100).toFixed(2) + '%' : '';
  const tIn = s.in.reduce((a, b) => a + b, 0), tOut = s.out.reduce((a, b) => a + b, 0);
  return chartSvg({
    title: lang === 'pt' ? `Saldo · últimos ${s.labels.length} dias` : `Balance · last ${s.labels.length} days`,
    subtitle: `${displayName ? displayName + ' · ' : ''}ID ${userId}  •  ${lang === 'pt' ? 'Entradas' : 'In'} +${shortL(tIn, lang)}  •  ${lang === 'pt' ? 'Saídas' : 'Out'} -${shortL(tOut, lang)}`,
    big: `${money.pretty(s.current, lang)} coins`,
    bigSub: `${diff >= 0 ? '+' : '-'}${shortL(Math.abs(diff), lang)}${pct ? ` (${diff >= 0 ? '+' : ''}${pct})` : ''}`,
    labels: s.labels, line: s.balances, up: s.in, down: s.out, lang,
    barsLabel: lang === 'pt' ? 'Entradas / Saídas' : 'Incoming / Outgoing'
  });
}

async function networkChartSvg(days = 14, lang = 'en') {
  const h = statsHistory(days).days;
  const st = stats();
  return chartSvg({
    title: lang === 'pt' ? `Rede · volume diário (${h.length} dias)` : `Network · daily volume (${h.length} days)`,
    subtitle: `${lang === 'pt' ? 'Transações' : 'Transactions'} 24h: ${st.transactions24h}  •  ${lang === 'pt' ? 'Usuários ativos' : 'Active users'} 24h: ${st.activeUsers24h}`,
    big: `${money.pretty(st.totalSats, lang)} coins`, bigSub: lang === 'pt' ? `${st.totalUsers} usuários` : `${st.totalUsers} users`,
    labels: h.map((d) => d.date), line: h.map((d) => d.volumeSats), up: h.map((d) => d.transactions), lang,
    barsLabel: lang === 'pt' ? 'Transações por dia' : 'Transactions per day'
  });
}

/** Minimal single-page A4 PDF embedding a JPEG (DCTDecode). */
function pdfFromJpeg(jpg, w, h, title = 'Coin Bank') {
  const PW = 595.28, PH = 841.89, r = w / h;
  let iw = PW - 40, ih = iw / r; if (ih > PH - 40) { ih = PH - 40; iw = ih * r; }
  const ox = (PW - iw) / 2, oy = (PH - ih) / 2;
  const parts = []; const offs = []; let len = 0;
  const push = (p) => { const b = typeof p === 'string' ? Buffer.from(p, 'latin1') : p; parts.push(b); len += b.length; };
  const content = `q ${iw.toFixed(2)} 0 0 ${ih.toFixed(2)} ${ox.toFixed(2)} ${oy.toFixed(2)} cm /Im0 Do Q`;
  const safeTitle = String(title).replace(/[()\\]/g, '').replace(/[^\x20-\x7e]/g, '?');
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  offs[1] = len; push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  offs[2] = len; push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  offs[3] = len; push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);
  offs[4] = len; push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`); push(jpg); push('\nendstream\nendobj\n');
  offs[5] = len; push(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  offs[6] = len; push(`6 0 obj\n<< /Title (${safeTitle}) /Producer (Coin Bank) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>\nendobj\n`);
  const xref = len; let xr = 'xref\n0 7\n0000000000 65535 f \n';
  for (let i = 1; i <= 6; i++) xr += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  push(xr + `trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts, len);
}

async function rasterize(svg, fmt, title) {
  const s = sharp();
  if (!s) throw err('RENDER_UNAVAILABLE', 503);
  return renderSem.run(async () => {
    const img = s(Buffer.from(svg), { density: 96, limitInputPixels: 4e6 });
    if (fmt === 'pdf') {
      const { data, info } = await img.flatten({ background: '#ffffff' }).jpeg({ quality: 90, mozjpeg: true }).toBuffer({ resolveWithObject: true });
      return pdfFromJpeg(data, info.width, info.height, title);
    }
    return img.png({ compressionLevel: 9, adaptiveFiltering: true, palette: false }).toBuffer();
  });
}

function renderCached(key, producer) {
  const hit = caches.render.get(key);
  if (hit) return Promise.resolve(hit);
  return flight.run('r:' + key, async () => { const b = await producer(); caches.render.set(key, b); return b; });
}

/** receipt(txId, { lang, format: 'png'|'pdf'|'svg' }) → Buffer (throws TX_NOT_FOUND) */
async function receipt(txId, { lang = 'en', format = 'png' } = {}) {
  const tx = getTransaction(txId);
  if (!tx) throw err('INVALID_TRANSACTION', 404);
  lang = lang === 'pt' ? 'pt' : 'en';
  const key = `rc:${tx.id}:${lang}:${format}`;
  return renderCached(key, async () => {
    const svg = await receiptSvg(tx, lang);
    return format === 'svg' ? Buffer.from(svg) : rasterize(svg, format, `Coin Bank receipt ${tx.id}`);
  });
}
/** userChart(userId, { days, lang, format, name }) → Buffer */
async function userChart(userId, { days = 30, lang = 'en', format = 'png', name } = {}) {
  lang = lang === 'pt' ? 'pt' : 'en';
  const key = `uc:${userId}:${days}:${lang}:${format}:${balance(userId)}:${new Date().toISOString().slice(0, 10)}:${name || ''}`;
  return renderCached(key, async () => {
    const svg = await userChartSvg(userId, days, lang, name);
    return format === 'svg' ? Buffer.from(svg) : rasterize(svg, format, `Coin Bank balance ${userId}`);
  });
}
async function networkChart({ days = 14, lang = 'en', format = 'png' } = {}) {
  lang = lang === 'pt' ? 'pt' : 'en';
  const key = `nc:${days}:${lang}:${format}:${Math.floor(Date.now() / 60e3)}`;
  return renderCached(key, async () => {
    const svg = await networkChartSvg(days, lang);
    return format === 'svg' ? Buffer.from(svg) : rasterize(svg, format, 'Coin Bank network');
  });
}

/* ═══════════════════════════════ QR PAYMENTS (mobile app / site / bot) ═══════════════════════════════ */
/**
 * Payment request = "charge QR". The receiver creates it (fixed amount or payer-chooses),
 * shows the QR, the payer scans it and pays. Payment + request state change happen in ONE
 * database transaction (single-use requests can never be paid twice). Reusable requests
 * (e.g. a shop counter QR) stay open and count every payment.
 * Static user QR = "send me coins": encodes the account ID (optionally an amount) and is paid
 * with the normal transfer endpoint.
 */
const payUrl = (id) => `${publicUrl()}/pay/${encodeURIComponent(id)}`;
const userPayUrl = (userId, sats) => `${publicUrl()}/pay/u/${encodeURIComponent(userId)}${sats ? '?amount=' + money.format(sats) : ''}`;
const MEMO_RE = /[\u0000-\u001f\u007f<>]/g;
const PAYREQ_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

function payReqView(r) {
  if (!r) return null;
  const u = db.getUser(r.to_id);
  const amt = r.amount === null || r.amount === undefined ? null : Number(r.amount);
  const base = publicUrl();
  return {
    id: r.id, to: r.to_id, toName: u && u.username ? u.username : null,
    amount: amt === null ? null : money.format(amt), amountSats: amt, open: amt === null,
    memo: r.memo || null, reusable: !!r.reusable, status: r.status,
    createdAt: r.created_at, expiresAt: r.expires_at,
    paidCount: Number(r.paid_count || 0), paidTotal: money.format(Number(r.paid_total || 0)), paidTotalSats: Number(r.paid_total || 0),
    lastTx: r.last_tx || null, lastPayer: r.last_payer || null, paidAt: r.paid_at || null,
    url: payUrl(r.id), uri: `coinbank://pay/${r.id}`,
    qr: { png: `${base}/api/pay/request/${r.id}/qr.png`, svg: `${base}/api/pay/request/${r.id}/qr.svg` }
  };
}

/** createPayRequest(userId, { amount?, memo?, expires?, reusable? }) */
async function createPayRequest(userId, { amount, memo, expires, reusable } = {}) {
  userId = cleanId(userId);
  if (!userId || userId === E.systemId) throw err('INVALID_TARGET');
  const sats = amount === undefined || amount === null || String(amount).trim() === '' ? null : amountOrThrow(amount);
  const m = memo === undefined || memo === null ? null : String(memo).replace(MEMO_RE, '').trim().slice(0, 140) || null;
  let ms = expires === undefined || expires === null || expires === '' ? E.payreqDefault : parseDuration(expires);
  if (ms === null) throw err('INVALID_TIME', 400, { message: 'Use 10m, 1h, 1d, 30d' });
  ms = Math.min(E.payreqMax, Math.max(60e3, ms));
  const open = db.listPayRequests(userId, 'open', E.payreqMaxOpen + 1, 0).filter((r) => r.expires_at >= Date.now()).length;
  if (open >= E.payreqMaxOpen) throw err('TOO_MANY_REQUESTS', 429, { message: `Max ${E.payreqMaxOpen} open payment requests` });
  const id = crypto.randomBytes(12).toString('base64url');
  const r = await db.createPayRequest({ id, to: userId, sats, memo: m, reusable: !!reusable, expiresAt: Date.now() + ms });
  events.emit('payreq.update', r.id);
  return { success: true, request: payReqView(r) };
}

function getPayRequest(id) {
  if (typeof id !== 'string' || !PAYREQ_ID_RE.test(id)) return null;
  const r = db.getPayRequest(id);
  if (r && r.status === 'open' && r.expires_at < Date.now()) return payReqView({ ...r, status: 'expired' });
  return payReqView(r);
}

/** Long-poll helper: resolves when the request changes (paid/cancelled) or after timeoutMs. */
const payWaiters = { n: 0 };
function waitPayRequest(id, sinceCount, timeoutMs) {
  const cur = getPayRequest(id);
  if (!cur || cur.status !== 'open' || cur.paidCount !== sinceCount || timeoutMs <= 0 || payWaiters.n >= 5000) return Promise.resolve(cur);
  payWaiters.n++;
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); events.removeListener('payreq.update', on); payWaiters.n--; resolve(getPayRequest(id)); };
    const on = (rid) => { if (rid === id) done(); };
    const t = setTimeout(done, timeoutMs);
    events.on('payreq.update', on);
  });
}

async function payPayRequest(payerId, id, { amount, source = 'api' } = {}) {
  payerId = cleanId(payerId);
  if (!payerId) throw err('INVALID_TARGET');
  if (typeof id !== 'string' || !PAYREQ_ID_RE.test(id)) throw err('PAYREQ_NOT_FOUND', 404);
  const sats = amount === undefined || amount === null || String(amount).trim() === '' ? null : amountOrThrow(amount);
  const r = await db.payPayRequest({ id, payer: payerId, sats, cooldownMs: E.transferCooldown });
  events.emit('transfer', { ...r, source: 'payreq:' + source });
  events.emit('payreq.update', id);
  const req = payReqView(r.request);
  if (cfg.dm_queue.notify_payments !== false) {
    const amt = money.format(r.amount);
    enqueueDM(r.to, dmEmbed({
      color: 0x2ECC71, titleEn: '📲 QR payment received', titlePt: '📲 Pagamento por QR recebido',
      en: [`You received **${amt}** coins from \`${payerId}\`.`, req.memo ? `Memo: ${req.memo}` : '', `Request: \`${id}\``].filter(Boolean),
      pt: [`Você recebeu **${amt}** coins de \`${payerId}\`.`, req.memo ? `Descrição: ${req.memo}` : '', `Pedido: \`${id}\``].filter(Boolean)
    }), { receipt: r.txId });
  }
  return { success: true, txId: r.txId, date: r.date, from: payerId, to: r.to, amount: money.format(r.amount), amountSats: r.amount, request: req };
}
async function payPayRequestByCard(code, id, opts) {
  const owner = cardOwner(code);
  if (!owner) throw err('CARD_NOT_FOUND', 404);
  return payPayRequest(owner, id, { ...opts, source: 'card' });
}
async function cancelPayRequest(userId, id) {
  if (typeof id !== 'string' || !PAYREQ_ID_RE.test(id)) throw err('PAYREQ_NOT_FOUND', 404);
  const r = await db.cancelPayRequest(id, String(userId));
  events.emit('payreq.update', id);
  return { success: true, request: payReqView(r) };
}
function listPayRequests(userId, { status, page = 1 } = {}) {
  page = Math.max(1, Math.min(10000, Number(page) || 1));
  const st = ['open', 'paid', 'cancelled', 'expired'].includes(status) ? status : null;
  return { requests: db.listPayRequests(String(userId), st, 20, (page - 1) * 20).map(payReqView), page };
}

/** Static "pay me" QR payload for an account. */
function userPayInfo(userId, amount) {
  const id = cleanId(userId);
  if (!id || id === E.systemId) throw err('INVALID_TARGET');
  const sats = amount === undefined || amount === null || amount === '' ? null : amountOrThrow(amount);
  const u = db.getUser(id);
  return { type: 'user', userId: id, name: u && u.username ? u.username : null, amount: sats === null ? null : money.format(sats), amountSats: sats, url: userPayUrl(id, sats), uri: `coinbank://user/${id}${sats ? '?amount=' + money.format(sats) : ''}` };
}

/**
 * parseScan(text) — tells the app what a scanned QR is, so it can show the right confirm screen.
 * Accepts site URLs, coinbank:// URIs and bare IDs. Card codes are never accepted (they are secrets).
 */
function parseScan(text) {
  const s = String(text || '').trim().slice(0, 600);
  if (!s) return { type: 'unknown' };
  let path = s, query = '';
  const m = s.match(/^(?:https?:\/\/[^/]+|coinbank:\/)(\/[^?#]*)(?:\?([^#]*))?/i);
  if (m) { path = decodeURIComponent(m[1]); query = m[2] || ''; }
  const q = new URLSearchParams(query);
  let x;
  if ((x = path.match(/^\/pay\/u\/(\d{1,32})\/?$/)) || (x = path.match(/^\/user\/(\d{1,32})\/?$/))) {
    try { return userPayInfo(x[1], q.get('amount') || undefined); } catch (e) { return { type: 'invalid', error: e.code }; }
  }
  if ((x = path.match(/^\/pay\/([A-Za-z0-9_-]{8,40})\/?$/))) {
    const r = getPayRequest(x[1]);
    return r ? { type: 'request', request: r } : { type: 'invalid', error: 'PAYREQ_NOT_FOUND' };
  }
  if ((x = path.match(/^\/tx\/([^/]{1,64})\/?$/)) || (x = path.match(/^\/tx\.html$/) && q.get('id') ? [0, q.get('id')] : null)) {
    const tx = getTransaction(x[1]);
    return tx ? { type: 'transaction', tx } : { type: 'invalid', error: 'INVALID_TRANSACTION' };
  }
  if (/^\d{5,32}$/.test(s)) { try { return userPayInfo(s); } catch (e) { return { type: 'invalid', error: e.code }; } }
  if (/^[0-9a-f-]{36}$/i.test(s)) {
    const b = getBill(s); if (b) return { type: 'bill', bill: b };
    const tx = getTransaction(s); if (tx) return { type: 'transaction', tx };
  }
  if (PAYREQ_ID_RE.test(s)) { const r = getPayRequest(s); if (r) return { type: 'request', request: r }; }
  return { type: 'unknown' };
}

/** QR card image (SVG/PNG/PDF): logo, QR, title and caption lines. */
async function qrCardSvg(text, { title, lines = [] } = {}) {
  const W = 640, qs = 480, top = 130;
  const mod = qr.encode(text, 'M'); const cell = qs / (mod.size + 4);
  const q = qr.svgPath(text, (W - qs) / 2 + cell * 2, top + cell * 2, cell, 'M');
  const lg = await logo();
  const H = top + qs + 60 + lines.length * 34 + 40;
  const cap = lines.map((l, i) => `<text x="${W / 2}" y="${top + qs + 56 + i * 34}" text-anchor="middle" font-family="${FONT}" font-size="${i === 0 ? 28 : 18}" font-weight="${i === 0 ? 800 : 500}" fill="${i === 0 ? '#111' : '#555'}">${xmlEsc(String(l).slice(0, 60))}</text>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" rx="28" fill="#ffffff"/>
${lg ? `<image x="40" y="34" width="64" height="64" xlink:href="${lg}" href="${lg}"/>` : ''}
<text x="118" y="64" font-family="${FONT}" font-size="26" font-weight="800" fill="#111">Coin Bank</text>
<text x="118" y="90" font-family="${FONT}" font-size="16" fill="#777">${xmlEsc(title || 'Scan to pay · Escaneie para pagar')}</text>
<rect x="${(W - qs) / 2}" y="${top}" width="${qs}" height="${qs}" rx="18" fill="#fff" stroke="#e5e7eb" stroke-width="2"/>
<path d="${q.d}" fill="#111"/>
${cap}
</svg>`;
}

async function payRequestQr(id, { format = 'png', lang = 'en' } = {}) {
  const r = getPayRequest(id);
  if (!r) throw err('PAYREQ_NOT_FOUND', 404);
  const key = `pq:${r.id}:${r.status}:${format}:${lang}`;
  return renderCached(key, async () => {
    const who = r.toName || r.to;
    const lines = [
      r.amount ? `${money.pretty(r.amountSats, lang)} coins` : (lang === 'pt' ? 'Valor livre' : 'Any amount'),
      `${lang === 'pt' ? 'Para' : 'To'}: ${who}`,
      r.memo ? r.memo : null,
      r.status !== 'open' ? (lang === 'pt' ? `Status: ${r.status}` : `Status: ${r.status}`) : null
    ].filter(Boolean);
    const svg = await qrCardSvg(r.url, { title: lang === 'pt' ? 'Escaneie para pagar' : 'Scan to pay', lines });
    return format === 'svg' ? Buffer.from(svg) : rasterize(svg, format, `Coin Bank payment ${r.id}`);
  });
}
async function userQr(userId, { amount, format = 'png', lang = 'en' } = {}) {
  const info = userPayInfo(userId, amount);
  const key = `uq:${info.userId}:${info.amountSats || 0}:${info.name || ''}:${format}:${lang}`;
  return renderCached(key, async () => {
    const lines = [info.amount ? `${money.pretty(info.amountSats, lang)} coins` : (info.name || info.userId), info.amount ? `${lang === 'pt' ? 'Para' : 'To'}: ${info.name || info.userId}` : `ID ${info.userId}`];
    const svg = await qrCardSvg(info.url, { title: lang === 'pt' ? 'Envie coins para mim' : 'Send me coins', lines });
    return format === 'svg' ? Buffer.from(svg) : rasterize(svg, format, `Coin Bank user ${info.userId}`);
  });
}

/* ═══════════════════════════════ PERIODIC JOBS ═══════════════════════════════ */
async function sweepExpiredBills() {
  const now = Date.now();
  let total = 0;
  for (let round = 0; round < 50; round++) {
    const rows = db.expiredBills(now, 500);
    if (!rows.length) break;
    for (const b of rows) {
      await db.deleteBill(b.bill_id);
      total++;
      const amt = money.format(b.amount);
      if (cfg.dm_queue.notify_bills && b.to_id) {
        enqueueDM(b.to_id, dmEmbed({ color: 0xE67E22, titleEn: '⚠️ Your bill expired', titlePt: '⚠️ Sua cobrança expirou',
          en: [`Bill \`${b.bill_id}\` worth **${amt}** coins expired without payment.`, 'Create a new bill if you still want to charge it.'],
          pt: [`A cobrança \`${b.bill_id}\` de **${amt}** coins expirou sem pagamento.`, 'Crie uma nova cobrança se ainda quiser cobrar.'] }));
      }
    }
    if (rows.length < 500) break;
  }
  if (total) log.info(`removed ${total} expired bills`);
  return total;
}

function cleanTemp() {
  const dir = require('./lib/config').resolvePath(cfg.system.temp_dir || 'temp');
  try {
    const maxAge = (cfg.retention.temp_files_minutes || 30) * 60e3, now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { const st = fs.statSync(p); if (st.isFile() && now - st.mtimeMs > maxAge) fs.unlinkSync(p); } catch {}
    }
  } catch { /* folder may not exist */ }
}

function every(ms, fn) {
  const t = setInterval(() => { Promise.resolve().then(fn).catch((e) => log.warn('job failed:', e.message)); }, ms);
  t.unref(); timers.push(t);
}

/* ═══════════════════════════════ INIT ═══════════════════════════════ */
function init(config) {
  if (cfg) return module.exports;
  cfg = config;
  const ec = cfg.economy;
  const claimSats = money.parse(ec.claim_amount);
  if (claimSats === null) throw new Error('config economy.claim_amount is invalid');
  E = {
    claimSats,
    claimCooldown: Number(ec.claim_cooldown_ms),
    transferCooldown: Number(ec.transfer_cooldown_ms),
    maxSupply: money.parse(ec.max_supply, { allowZero: true }) || 0,
    minSats: money.parse(ec.min_amount) || 1,
    systemId: String(ec.system_id),
    billDefault: parseDuration(ec.bill_default_expiry) || 90 * 864e5,
    billMin: parseDuration(ec.bill_min_expiry) || 36e5,
    billMax: parseDuration(ec.bill_max_expiry) || 182 * 864e5,
    backupCodes: Number(ec.backup_codes) || 12,
    payreqDefault: parseDuration(ec.payment_request_default_expiry) || 864e5,
    payreqMax: parseDuration(ec.payment_request_max_expiry) || 30 * 864e5,
    payreqMaxOpen: Math.max(1, Number(ec.payment_request_max_open) || 100),
    cardBytes: Number(ec.card_bytes) || 6
  };
  ipSecret = Buffer.from(db.kvGet('ip_secret') || crypto.randomBytes(32).toString('hex'), 'hex');
  scryptSem = new Semaphore(4, 5000);
  const c = cfg.api.cache;
  caches.stats = new LRU({ name: 'logic.stats', max: 2, ttl: c.stats_ttl_ms });
  caches.history = new LRU({ name: 'logic.history', max: 32, ttl: c.history_ttl_ms });
  caches.recent = new LRU({ name: 'logic.recent', max: 50, ttl: c.recent_ttl_ms });
  caches.rank = new LRU({ name: 'logic.rank', max: 200, ttl: c.rank_ttl_ms });
  caches.txCount = new LRU({ name: 'logic.txcount', max: 20000, ttl: 15000 });
  caches.loginFails = new LRU({ name: 'logic.loginFails', max: 100000, ttl: 600e3, soft: false });
  caches.staff = new LRU({ name: 'logic.staff', max: 1, ttl: 60e3 });
  caches.render = new LRU({ name: 'logic.render', max: c.render_entries || 64, ttl: 10 * 60e3 });
  const tempDir = require('./lib/config').resolvePath(cfg.system.temp_dir || 'temp');
  fs.mkdirSync(tempDir, { recursive: true });
  every((cfg.retention.cleanup_minutes || 10) * 60e3, sweepExpiredBills);
  every(Math.max(5, cfg.retention.temp_files_minutes || 30) * 60e3, cleanTemp);
  setTimeout(() => { sweepExpiredBills().catch(() => {}); cleanTemp(); }, 20000).unref();
  // invalidate per-user tx counters when money moves
  events.on('transfer', (t) => { caches.txCount.delete(t.from); caches.txCount.delete(t.to); caches.recent.clear(); });
  events.on('claim', (t) => { caches.txCount.delete(t.userId); caches.recent.clear(); });
  events.on('bill.paid', (t) => { caches.txCount.delete(t.from); caches.txCount.delete(t.to); caches.recent.clear(); });
  log.info(`economy: claim ${money.format(E.claimSats)} every ${fmtDuration(E.claimCooldown)}, max supply ${E.maxSupply ? money.format(E.maxSupply) : 'unlimited'}`);
  return module.exports;
}

function stop() {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  detachDMSender();
}

module.exports = {
  init, stop, events,
  // helpers
  money, cleanId, isId, parseDuration, fmtDuration, fmtDate, normalizeIp, ipKey, txUrl, publicUrl, economy: () => E, config: () => cfg,
  // accounts
  register, login, logout, authenticate, changeAccount, accountUpdate, unregister, setDiscordCredentials,
  // money
  balance, transfer, claim, claimStatus, accountSummary, rankPosition,
  // cards
  getCard, resetCard, cardOwner, cardOwnerByHash, cardInfo, claimByCard, transferByCard, payBetweenCards,
  // bills
  createBill, createBillByCard, payBill, payBillByCard, listBills, getBill,
  // backups
  createBackups, listBackups, restoreBackup,
  // ledger / stats
  getTransaction, listTransactions, verifyId, stats, totalUsers, statsHistory, statsRecent, rank,
  // permissions / guilds
  isOwner, isStaff, addStaff, removeStaff, listStaff, getGuild, setGuild,
  meta: { get: (k) => db.kvGet(k), set: (k, v) => db.kvSet(k, v) }, purgedGuildIds: () => db.purgedGuildIds(), dbInfo: () => db.info(),
  // dm queue
  enqueueDM, dmEmbed, attachDMSender, detachDMSender, dmStats: () => ({ running: dm.running, sent: dm.sent, failed: dm.failed, pending: db.countDMs() }),
  // rendering
  canRender, receipt, userChart, networkChart, balanceSeries,
  // QR payments
  createPayRequest, getPayRequest, payPayRequest, payPayRequestByCard, cancelPayRequest, listPayRequests, waitPayRequest,
  userPayInfo, parseScan, payRequestQr, userQr, payUrl, userPayUrl
};

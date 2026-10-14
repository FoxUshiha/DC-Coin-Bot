'use strict';
/**
 * database.js — the ONLY module that touches the disk database.
 *
 *  • Driver: better-sqlite3 (preferred) or Node's built-in node:sqlite (fallback, Node ≥ 22.13).
 *  • Every write goes through an async *group-commit queue*: thousands of operations
 *    are committed in a single transaction, each one isolated by its own SAVEPOINT
 *    (one failing operation never affects the others). Callers get a Promise.
 *  • Money is stored as INTEGER sats. Balance changes are done with guarded SQL
 *    (UPDATE ... WHERE coins >= ?) inside the same transaction as the ledger insert,
 *    so a transfer either fully happens or not at all — coins are never created or lost.
 *  • Write-through LRU caches (users, sessions, transactions, guild settings) keep
 *    reads in memory; caches are only updated *after* a successful COMMIT.
 *  • Automatic migration from the previous schema (playerList/database.db).
 *  • Maintenance: retention cleanup in small chunks, WAL checkpoint, PRAGMA optimize,
 *    online backups, ledger audit (SUM(balances) == total minted), shrink_memory.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LRU } = require('./lib/cache');
const money = require('./lib/money');
const log = require('./lib/log').scope('database');

let D = null;          // driver wrapper
let S = null;          // prepared statements
let cfg = null;        // full config
let dbFile = null;
const timers = [];
const C = {};          // caches

/* ═══════════════════════════════ DRIVER ═══════════════════════════════ */
function openDriver(file) {
  try {
    const Better = require('better-sqlite3');
    const raw = new Better(file);
    return {
      kind: 'better-sqlite3', raw,
      exec: (s) => raw.exec(s),
      prepare: (s) => raw.prepare(s),
      close: () => raw.close(),
      backup: (dest) => raw.backup(dest)
    };
  } catch (e) {
    const missing = e && (e.code === 'MODULE_NOT_FOUND' || /Cannot find module|NODE_MODULE_VERSION|was compiled against|invalid ELF|not a valid Win32|bindings/i.test(e.message));
    if (!missing) throw e;
    log.warn('better-sqlite3 not available, using built-in node:sqlite');
  }
  const origEmit = process.emitWarning;
  process.emitWarning = function (w, ...a) { if (String(w && w.message ? w.message : w).includes('SQLite')) return; return origEmit.call(process, w, ...a); };
  let sqlite;
  try { sqlite = require('node:sqlite'); } finally { process.emitWarning = origEmit; }
  const raw = new sqlite.DatabaseSync(file);
  return {
    kind: 'node:sqlite', raw,
    exec: (s) => raw.exec(s),
    prepare: (s) => raw.prepare(s),
    close: () => raw.close(),
    backup: typeof sqlite.backup === 'function' ? (dest) => sqlite.backup(raw, dest) : null
  };
}

const all = (sql, ...p) => D.prepare(sql).all(...p);
const one = (sql, ...p) => D.prepare(sql).get(...p);
const tableExists = (t) => !!one(`SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?`, t);
const columns = (t) => (tableExists(t) ? all(`PRAGMA table_info(${t})`).map((c) => c.name) : []);
const iso = (ms) => new Date(ms).toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const err = (code, status = 400, extra) => Object.assign(new Error(code), { code, status }, extra || {});
const keepErr = (code, status, extra) => Object.assign(err(code, status, extra), { keep: true });

/* ═══════════════════════════════ MIGRATIONS ═══════════════════════════════ */
function migrate() {
  const t0 = Date.now();
  D.exec('BEGIN IMMEDIATE');
  try {
    D.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)`);
    const version = Number((one(`SELECT value FROM kv WHERE key='schema_version'`) || {}).value || 0);

    // users
    D.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, coins INTEGER NOT NULL DEFAULT 0, cooldown INTEGER DEFAULT 0, notified INTEGER DEFAULT 0,
      username TEXT, password TEXT, created_at INTEGER, last_tx INTEGER DEFAULT 0)`);
    const uc = columns('users');
    for (const [c, def] of [['username', 'TEXT'], ['password', 'TEXT'], ['created_at', 'INTEGER'], ['last_tx', 'INTEGER DEFAULT 0'], ['notified', 'INTEGER DEFAULT 0'], ['cooldown', 'INTEGER DEFAULT 0']]) {
      if (!uc.includes(c)) D.exec(`ALTER TABLE users ADD COLUMN ${c} ${def}`);
    }
    D.exec(`UPDATE users SET coins = CAST(ROUND(coins) AS INTEGER) WHERE typeof(coins) != 'integer'`);
    D.exec(`UPDATE users SET coins = 0 WHERE coins IS NULL OR coins < 0`);
    D.exec(`CREATE INDEX IF NOT EXISTS idx_users_coins ON users(coins)`);
    D.exec(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`);
    D.exec(`DROP INDEX IF EXISTS idx_users_username_nc`);
    try { D.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_unique ON users(username COLLATE NOCASE) WHERE username IS NOT NULL`); }
    catch (e) { D.exec(`CREATE INDEX IF NOT EXISTS idx_users_username_nc ON users(username COLLATE NOCASE)`); log.warn('duplicate usernames exist in the old database — uniqueness enforced by the application only'); }
    D.exec(`CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at)`);

    // servers (guild settings)
    D.exec(`CREATE TABLE IF NOT EXISTS servers (server_id TEXT PRIMARY KEY, api_channel TEXT)`);
    const sc = columns('servers');
    for (const [c, def] of [['atm_channel', 'TEXT'], ['lang', 'TEXT'], ['cmds_purged', 'INTEGER DEFAULT 0'], ['updated_at', 'INTEGER']]) {
      if (!sc.includes(c)) D.exec(`ALTER TABLE servers ADD COLUMN ${c} ${def}`);
    }

    // cards
    D.exec(`CREATE TABLE IF NOT EXISTS cards (code TEXT PRIMARY KEY, owner_id TEXT NOT NULL, card_hash TEXT)`);
    if (!columns('cards').includes('card_hash')) D.exec(`ALTER TABLE cards ADD COLUMN card_hash TEXT`);
    const noHash = all(`SELECT code FROM cards WHERE card_hash IS NULL OR card_hash = ''`);
    if (noHash.length) {
      const up = D.prepare(`UPDATE cards SET card_hash = ? WHERE code = ?`);
      for (const r of noHash) up.run(sha256(r.code), r.code);
      log.info(`migration: hashed ${noHash.length} card codes`);
    }
    D.exec(`CREATE INDEX IF NOT EXISTS idx_cards_owner ON cards(owner_id)`);
    D.exec(`CREATE INDEX IF NOT EXISTS idx_cards_hash ON cards(card_hash)`);

    // transactions (ledger)
    D.exec(`CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, date TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, amount INTEGER NOT NULL)`);
    D.exec(`DROP INDEX IF EXISTS idx_transactions_from`);
    D.exec(`DROP INDEX IF EXISTS idx_transactions_to`);
    D.exec(`CREATE INDEX IF NOT EXISTS idx_tx_from_date ON transactions(from_id, date)`);
    D.exec(`CREATE INDEX IF NOT EXISTS idx_tx_to_date ON transactions(to_id, date)`);
    D.exec(`CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date)`);
    if (version < 2) {
      // old versions logged some transfers twice (ATM modal / restore). Remove exact duplicates once.
      const r = D.prepare(`DELETE FROM transactions WHERE rowid NOT IN (SELECT MIN(rowid) FROM transactions GROUP BY date, from_id, to_id, amount)`).run();
      if (r.changes) log.info(`migration: removed ${r.changes} duplicated ledger rows`);
      D.exec(`UPDATE transactions SET amount = CAST(ROUND(amount) AS INTEGER) WHERE typeof(amount) != 'integer'`);
    }

    // bills
    D.exec(`CREATE TABLE IF NOT EXISTS bills (bill_id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT NOT NULL, amount INTEGER NOT NULL, date INTEGER NOT NULL, expires_at INTEGER)`);
    if (!columns('bills').includes('expires_at')) {
      D.exec(`ALTER TABLE bills ADD COLUMN expires_at INTEGER`);
    }
    // old bots stored "date = expiry - 90 days"; keep the same expiry moment
    D.exec(`UPDATE bills SET expires_at = date + ${90 * 864e5} WHERE expires_at IS NULL`);
    D.exec(`CREATE INDEX IF NOT EXISTS idx_bills_from ON bills(from_id, date)`);
    D.exec(`CREATE INDEX IF NOT EXISTS idx_bills_to ON bills(to_id, date)`);
    D.exec(`CREATE INDEX IF NOT EXISTS idx_bills_exp ON bills(expires_at)`);

    // wallet backups
    D.exec(`CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, userId TEXT NOT NULL)`);
    D.exec(`CREATE INDEX IF NOT EXISTS idx_backups_user ON backups(userId)`);

    // sessions: only the SHA-256 of the token is stored (a DB leak does not leak logins)
    D.exec(`CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
    D.exec(`CREATE INDEX IF NOT EXISTS idx_auth_user ON auth_sessions(user_id, created_at)`);
    D.exec(`CREATE INDEX IF NOT EXISTS idx_auth_exp ON auth_sessions(expires_at)`);
    if (tableExists('sessions')) D.exec(`DROP TABLE sessions`);

    // anonymous rate-limit counters (keys are HMACs, never raw IPs)
    D.exec(`CREATE TABLE IF NOT EXISTS ip_limits (key TEXT NOT NULL, kind INTEGER NOT NULL, count INTEGER NOT NULL, window_start INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (key, kind))`);
    D.exec(`CREATE INDEX IF NOT EXISTS idx_iplim_exp ON ip_limits(expires_at)`);
    if (tableExists('ips')) D.exec(`DROP TABLE ips`);

    // DM outbox (payload = deflated JSON)
    D.exec(`CREATE TABLE IF NOT EXISTS dm_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, payload BLOB NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, next_at INTEGER NOT NULL)`);
    D.exec(`CREATE INDEX IF NOT EXISTS idx_dm_next ON dm_outbox(next_at)`);
    if (tableExists('dm_queue')) {
      const zlib = require('zlib');
      const rows = all(`SELECT user_id, embed_json, created_at FROM dm_queue ORDER BY id LIMIT 5000`);
      const ins = D.prepare(`INSERT INTO dm_outbox (user_id, payload, attempts, created_at, next_at) VALUES (?, ?, 0, ?, ?)`);
      for (const r of rows) {
        try {
          const e = JSON.parse(r.embed_json || '{}');
          const embed = { title: e.title || undefined, description: e.description || e.content || undefined, color: 0xF1C40F };
          if (!embed.title && !embed.description) continue;
          ins.run(String(r.user_id), zlib.deflateRawSync(Buffer.from(JSON.stringify({ embeds: [embed] }))), Date.now(), Date.now());
        } catch { /* skip broken legacy row */ }
      }
      D.exec(`DROP TABLE dm_queue`);
      if (rows.length) log.info(`migration: moved ${rows.length} pending DMs to the new outbox`);
    }

    // QR payment requests (mobile app / site / bot): "scan and pay"
    D.exec(`CREATE TABLE IF NOT EXISTS pay_requests (
      id TEXT PRIMARY KEY, to_id TEXT NOT NULL, amount INTEGER, memo TEXT, reusable INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      paid_count INTEGER NOT NULL DEFAULT 0, paid_total INTEGER NOT NULL DEFAULT 0, last_tx TEXT, last_payer TEXT, paid_at INTEGER)`);
    D.exec(`CREATE INDEX IF NOT EXISTS idx_payreq_to ON pay_requests(to_id, created_at)`);
    D.exec(`CREATE INDEX IF NOT EXISTS idx_payreq_status ON pay_requests(status, expires_at)`);

    // bot staff
    D.exec(`CREATE TABLE IF NOT EXISTS staff (user_id TEXT PRIMARY KEY, added_by TEXT, added_at INTEGER)`);

    // derived graph table from the old version is no longer needed (graphs are computed from the ledger)
    if (tableExists('user_grafic')) D.exec(`DROP TABLE user_grafic`);

    // ledger audit baseline
    if (!one(`SELECT 1 AS x FROM kv WHERE key='total_minted'`)) {
      const sum = one(`SELECT IFNULL(SUM(coins),0) AS s FROM users`).s;
      D.prepare(`INSERT INTO kv (key, value) VALUES ('total_minted', ?)`).run(String(sum));
    }
    if (!one(`SELECT 1 AS x FROM kv WHERE key='ip_secret'`)) {
      D.prepare(`INSERT INTO kv (key, value) VALUES ('ip_secret', ?)`).run(crypto.randomBytes(32).toString('hex'));
    }
    D.prepare(`INSERT INTO kv (key, value) VALUES ('schema_version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    D.exec('COMMIT');
    if (version < 2) log.info(`schema ready (v2) in ${Date.now() - t0} ms`);
  } catch (e) {
    try { D.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

/* ═══════════════════════════════ STATEMENTS ═══════════════════════════════ */
function prepareAll() {
  const p = (s) => D.prepare(s);
  S = {
    // users
    getUser: p(`SELECT id, coins, cooldown, username, password, created_at, last_tx FROM users WHERE id = ?`),
    userExists: p(`SELECT 1 AS x FROM users WHERE id = ?`),
    byUsername: p(`SELECT id, coins, cooldown, username, password, created_at, last_tx FROM users WHERE username = ? LIMIT 1`),
    byUsernameNC: p(`SELECT id FROM users WHERE username = ? COLLATE NOCASE LIMIT 1`),
    ensureUser: p(`INSERT OR IGNORE INTO users (id, coins, cooldown, notified, created_at, last_tx) VALUES (?, 0, 0, 0, ?, 0)`),
    insertAccount: p(`INSERT INTO users (id, coins, cooldown, notified, username, password, created_at, last_tx) VALUES (?, 0, 0, 0, ?, ?, ?, 0)`),
    setCreds: p(`UPDATE users SET username = ?, password = ? WHERE id = ?`),
    setPassword: p(`UPDATE users SET password = ? WHERE id = ?`),
    debit: p(`UPDATE users SET coins = coins - ?, last_tx = ? WHERE id = ? AND coins >= ?`),
    credit: p(`UPDATE users SET coins = coins + ? WHERE id = ?`),
    setCooldown: p(`UPDATE users SET cooldown = ?, notified = 0 WHERE id = ?`),
    zeroUser: p(`UPDATE users SET coins = 0 WHERE id = ?`),
    // ledger
    insTx: p(`INSERT INTO transactions (id, date, from_id, to_id, amount) VALUES (?, ?, ?, ?, ?)`),
    getTx: p(`SELECT id, date, from_id, to_id, amount FROM transactions WHERE id = ?`),
    txPage: p(`SELECT id, date, from_id, to_id, amount FROM (
                 SELECT * FROM (SELECT id, date, from_id, to_id, amount FROM transactions WHERE from_id = ? ORDER BY date DESC LIMIT ?)
                 UNION
                 SELECT * FROM (SELECT id, date, from_id, to_id, amount FROM transactions WHERE to_id = ? ORDER BY date DESC LIMIT ?)
               ) ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`),
    txCountFrom: p(`SELECT COUNT(*) AS n FROM transactions WHERE from_id = ?`),
    txCountTo: p(`SELECT COUNT(*) AS n FROM transactions WHERE to_id = ?`),
    txCountSelf: p(`SELECT COUNT(*) AS n FROM transactions WHERE from_id = ? AND to_id = ?`),
    txRecent: p(`SELECT id, date, from_id, to_id, amount FROM transactions ORDER BY date DESC LIMIT ?`),
    flowFrom: p(`SELECT substr(date,1,10) AS d, SUM(amount) AS s FROM transactions WHERE from_id = ? AND to_id != ? AND date >= ? GROUP BY d`),
    flowTo: p(`SELECT substr(date,1,10) AS d, SUM(amount) AS s FROM transactions WHERE to_id = ? AND from_id != ? AND date >= ? GROUP BY d`),
    lastTxDate: p(`SELECT date FROM transactions WHERE from_id = ? ORDER BY date DESC LIMIT 1`),
    delOldTx: p(`DELETE FROM transactions WHERE rowid IN (SELECT rowid FROM transactions WHERE date < ? LIMIT 5000)`),
    // stats
    totalCoins: p(`SELECT IFNULL(SUM(coins),0) AS s FROM users`),
    userCount: p(`SELECT COUNT(*) AS n FROM users`),
    holderCount: p(`SELECT COUNT(*) AS n FROM users WHERE coins > 0`),
    txCount: p(`SELECT COUNT(*) AS n FROM transactions`),
    claimCount: p(`SELECT COUNT(*) AS n FROM transactions WHERE from_id = ?`),
    billCount: p(`SELECT COUNT(*) AS n FROM bills`),
    cardCount: p(`SELECT COUNT(*) AS n FROM cards`),
    newUsersSince: p(`SELECT COUNT(*) AS n FROM users WHERE created_at >= ?`),
    txSince: p(`SELECT COUNT(*) AS n, IFNULL(SUM(amount),0) AS v FROM transactions WHERE date >= ?`),
    claimsSince: p(`SELECT COUNT(*) AS n, IFNULL(SUM(amount),0) AS v FROM transactions WHERE from_id = ? AND date >= ?`),
    activeSince: p(`SELECT COUNT(*) AS n FROM (SELECT from_id AS u FROM transactions WHERE date >= ? UNION SELECT to_id FROM transactions WHERE date >= ?) WHERE u != ?`),
    historyDays: p(`SELECT substr(date,1,10) AS d, COUNT(*) AS n, IFNULL(SUM(amount),0) AS v, SUM(CASE WHEN from_id = ? THEN 1 ELSE 0 END) AS c FROM transactions WHERE date >= ? GROUP BY d ORDER BY d`),
    topUsers: p(`SELECT id, username, coins FROM users WHERE coins > 0 AND id != ? ORDER BY coins DESC, id ASC LIMIT ? OFFSET ?`),
    rankOf: p(`SELECT COUNT(*) + 1 AS r FROM users WHERE coins > ? AND id != ?`),
    // cards
    cardByOwner: p(`SELECT code FROM cards WHERE owner_id = ? LIMIT 1`),
    cardByCode: p(`SELECT owner_id FROM cards WHERE code = ?`),
    cardByHash: p(`SELECT owner_id FROM cards WHERE card_hash = ? LIMIT 1`),
    delCardsOf: p(`DELETE FROM cards WHERE owner_id = ?`),
    insCard: p(`INSERT INTO cards (code, owner_id, card_hash) VALUES (?, ?, ?)`),
    // bills
    insBill: p(`INSERT INTO bills (bill_id, from_id, to_id, amount, date, expires_at) VALUES (?, ?, ?, ?, ?, ?)`),
    getBill: p(`SELECT bill_id, from_id, to_id, amount, date, expires_at FROM bills WHERE bill_id = ?`),
    delBill: p(`DELETE FROM bills WHERE bill_id = ?`),
    billsFrom: p(`SELECT bill_id AS id, from_id, to_id, amount, date, expires_at FROM bills WHERE from_id = ? ORDER BY date DESC LIMIT ? OFFSET ?`),
    billsTo: p(`SELECT bill_id AS id, from_id, to_id, amount, date, expires_at FROM bills WHERE to_id = ? ORDER BY date DESC LIMIT ? OFFSET ?`),
    billsExpired: p(`SELECT bill_id, from_id, to_id, amount, date, expires_at FROM bills WHERE expires_at < ? LIMIT ?`),
    // backups
    backupCodes: p(`SELECT code FROM backups WHERE userId = ? ORDER BY rowid`),
    insBackup: p(`INSERT OR IGNORE INTO backups (code, userId) VALUES (?, ?)`),
    getBackup: p(`SELECT rowid AS id, code, userId FROM backups WHERE code = ?`),
    delBackup: p(`DELETE FROM backups WHERE code = ?`),
    // sessions
    insSession: p(`INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`),
    getSession: p(`SELECT token_hash, user_id, created_at, expires_at FROM auth_sessions WHERE token_hash = ?`),
    delSession: p(`DELETE FROM auth_sessions WHERE token_hash = ?`),
    userSessions: p(`SELECT token_hash FROM auth_sessions WHERE user_id = ? ORDER BY created_at DESC`),
    delUserSessions: p(`DELETE FROM auth_sessions WHERE user_id = ?`),
    delExpiredSessions: p(`DELETE FROM auth_sessions WHERE expires_at < ?`),
    // ip limits
    getLimit: p(`SELECT count, window_start, expires_at FROM ip_limits WHERE key = ? AND kind = ?`),
    upLimit: p(`INSERT INTO ip_limits (key, kind, count, window_start, expires_at) VALUES (?, ?, 1, ?, ?)
               ON CONFLICT(key, kind) DO UPDATE SET
                 count = CASE WHEN ip_limits.expires_at < excluded.window_start THEN 1 ELSE ip_limits.count + 1 END,
                 window_start = CASE WHEN ip_limits.expires_at < excluded.window_start THEN excluded.window_start ELSE ip_limits.window_start END,
                 expires_at = CASE WHEN ip_limits.expires_at < excluded.window_start THEN excluded.expires_at ELSE ip_limits.expires_at END`),
    delExpiredLimits: p(`DELETE FROM ip_limits WHERE expires_at < ?`),
    // dm outbox
    insDM: p(`INSERT INTO dm_outbox (user_id, payload, attempts, created_at, next_at) VALUES (?, ?, 0, ?, ?)`),
    dueDMs: p(`SELECT id, user_id, payload, attempts FROM dm_outbox WHERE next_at <= ? ORDER BY next_at, id LIMIT ?`),
    delDM: p(`DELETE FROM dm_outbox WHERE id = ?`),
    retryDM: p(`UPDATE dm_outbox SET attempts = attempts + 1, next_at = ? WHERE id = ?`),
    holdDM: p(`UPDATE dm_outbox SET next_at = ? WHERE id = ? AND next_at <= ?`),
    countDM: p(`SELECT COUNT(*) AS n FROM dm_outbox`),
    delOldDM: p(`DELETE FROM dm_outbox WHERE created_at < ?`),
    // servers
    getServer: p(`SELECT server_id, api_channel, atm_channel, lang, cmds_purged FROM servers WHERE server_id = ?`),
    upServer: p(`INSERT INTO servers (server_id, api_channel, atm_channel, lang, cmds_purged, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(server_id) DO UPDATE SET api_channel = excluded.api_channel, atm_channel = excluded.atm_channel,
                lang = excluded.lang, cmds_purged = excluded.cmds_purged, updated_at = excluded.updated_at`),
    purgedGuilds: p(`SELECT server_id FROM servers WHERE cmds_purged = 1`),
    // staff
    listStaff: p(`SELECT user_id, added_by, added_at FROM staff ORDER BY added_at`),
    addStaff: p(`INSERT OR REPLACE INTO staff (user_id, added_by, added_at) VALUES (?, ?, ?)`),
    delStaff: p(`DELETE FROM staff WHERE user_id = ?`),
    // pay requests
    insPayReq: p(`INSERT INTO pay_requests (id, to_id, amount, memo, reusable, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`),
    getPayReq: p(`SELECT * FROM pay_requests WHERE id = ?`),
    payReqDone: p(`UPDATE pay_requests SET paid_count = paid_count + 1, paid_total = ?, last_tx = ?, last_payer = ?, paid_at = ?, status = ? WHERE id = ? AND status = 'open'`),
    payReqStatus: p(`UPDATE pay_requests SET status = ? WHERE id = ? AND status = 'open'`),
    payReqsOf: p(`SELECT * FROM pay_requests WHERE to_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`),
    payReqsOfStatus: p(`SELECT * FROM pay_requests WHERE to_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`),
    payReqExpire: p(`UPDATE pay_requests SET status = 'expired' WHERE status = 'open' AND expires_at < ?`),
    payReqPurge: p(`DELETE FROM pay_requests WHERE status != 'open' AND COALESCE(paid_at, expires_at) < ?`),
    // kv
    kvGet: p(`SELECT value FROM kv WHERE key = ?`),
    kvSet: p(`INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
  };
}

/* ═══════════════════════════════ GROUP-COMMIT WRITE QUEUE ═══════════════════════════════ */
// Simple deque (array + head index) so huge queues stay O(1) per operation.
let Q = [], qHead = 0, flushScheduled = false, flushing = false;
const wstats = { batches: 0, ops: 0, failed: 0, maxBatch: 0, lastMs: 0 };

function qLength() { return Q.length - qHead; }

/**
 * write(fn) — runs fn(ctx) inside the next group-commit transaction (isolated by a
 * SAVEPOINT). fn must be synchronous. ctx.after(cb) registers post-commit effects
 * (cache updates). Resolves with fn's return value, rejects with its error.
 */
function write(fn) {
  return new Promise((resolve, reject) => {
    Q.push({ fn, resolve, reject });
    if (!flushScheduled && !flushing) { flushScheduled = true; setImmediate(flush); }
  });
}

function flush() {
  flushScheduled = false;
  if (!D || qLength() === 0) return;
  flushing = true;
  const max = cfg.database.write_batch_max;
  const end = Math.min(Q.length, qHead + max);
  const batch = Q.slice(qHead, end);
  qHead = end;
  if (qHead > 4096 && qHead * 2 > Q.length) { Q = Q.slice(qHead); qHead = 0; }
  const t0 = process.hrtime.bigint();
  let fatal = null;
  try {
    D.exec('BEGIN IMMEDIATE');
    for (const job of batch) {
      const ctx = { fx: null, after(cb) { (this.fx || (this.fx = [])).push(cb); } };
      D.exec('SAVEPOINT op');
      try {
        job.value = job.fn(ctx);
        job.ctx = ctx;
        D.exec('RELEASE op');
      } catch (e) {
        job.error = e;
        try {
          if (e && e.keep) D.exec('RELEASE op');          // error that still commits its cleanup writes
          else { D.exec('ROLLBACK TO op'); D.exec('RELEASE op'); }
        } catch (e2) { fatal = e2; break; }
      }
    }
    if (fatal) throw fatal;
    D.exec('COMMIT');
  } catch (e) {
    fatal = e;
    try { D.exec('ROLLBACK'); } catch {}
    log.error('batch commit failed, rolled back:', e.message);
    for (const c of Object.values(C)) c.clear();
  }
  wstats.batches++; wstats.ops += batch.length; wstats.maxBatch = Math.max(wstats.maxBatch, batch.length);
  wstats.lastMs = Number(process.hrtime.bigint() - t0) / 1e6;
  for (const job of batch) {
    if (fatal && !job.error) job.error = err('DB_WRITE_FAILED', 503);
    if (job.error) { wstats.failed++; job.reject(job.error); continue; }
    if (job.ctx && job.ctx.fx) for (const cb of job.ctx.fx) { try { cb(); } catch (e) { log.warn('post-commit effect failed:', e.message); } }
    job.resolve(job.value);
  }
  flushing = false;
  if (qLength() > 0) { flushScheduled = true; setImmediate(flush); }
}

/** Drains the queue synchronously (shutdown). */
function drain() {
  let guard = 0;
  while (D && qLength() > 0 && guard++ < 10000) { flushing = false; flush(); }
}

/* ═══════════════════════════════ HELPERS ═══════════════════════════════ */
function invalidateUser(ctx, ...ids) { ctx.after(() => { for (const id of ids) C.users.delete(String(id)); }); }
function readUser(id) { return S.getUser.get(String(id)) || null; }

/* ═══════════════════════════════ USERS / ACCOUNTS ═══════════════════════════════ */
function getUser(id) {
  id = String(id);
  const hit = C.users.get(id);
  if (hit !== undefined) return hit;
  const row = readUser(id);
  C.users.set(id, row); // caches "not found" as null as well
  return row;
}
const userExists = (id) => !!getUser(id);
const getBalance = (id) => { const u = getUser(id); return u ? u.coins : 0; };
const getUserByUsername = (name) => S.byUsername.get(String(name)) || null;
const usernameTaken = (name, exceptId) => { const r = S.byUsernameNC.get(String(name)); return !!r && r.id !== exceptId; };

/** Creates a registered account + its card. */
function assertUsernameFree(username, exceptId) {
  if (!username) return;
  const r = S.byUsernameNC.get(String(username));
  if (r && r.id !== exceptId) throw err('Username already taken', 409);
}
function createAccount({ id, username, passwordHash, cardCode, now = Date.now() }) {
  return write((ctx) => {
    assertUsernameFree(username, id);
    if (S.userExists.get(id)) {
      const u = readUser(id);
      if (u.username) throw err('ID_TAKEN', 409);
      S.setCreds.run(username, passwordHash, id);
    } else {
      S.insertAccount.run(id, username, passwordHash, now);
    }
    S.delCardsOf.run(id);
    S.insCard.run(cardCode, id, sha256(cardCode));
    invalidateUser(ctx, id);
    ctx.after(() => C.cards.delete('o:' + id));
    return { id };
  });
}

function setCredentials(id, username, passwordHash) {
  return write((ctx) => {
    assertUsernameFree(username, String(id));
    S.ensureUser.run(String(id), Date.now());
    S.setCreds.run(username, passwordHash, String(id));
    invalidateUser(ctx, id);
    return true;
  });
}
function setPassword(id, passwordHash) {
  return write((ctx) => { S.setPassword.run(passwordHash, String(id)); invalidateUser(ctx, id); return true; });
}
function ensureUser(id) {
  return write((ctx) => { const r = S.ensureUser.run(String(id), Date.now()); if (r.changes) invalidateUser(ctx, id); return true; });
}

/* ═══════════════════════════════ MONEY OPERATIONS (atomic) ═══════════════════════════════ */
function doTransfer(ctx, { from, to, sats, txId, now, cooldownMs = 0, recordOnly = false }) {
  if (!Number.isSafeInteger(sats) || sats <= 0) throw err('INVALID_AMOUNT');
  const date = iso(now);
  if (!recordOnly) {
    const payer = readUser(from);
    if (!payer) throw err('INSUFFICIENT_FUNDS', 402);
    if (cooldownMs > 0 && payer.last_tx && now - payer.last_tx < cooldownMs) throw err('TRANSFER_COOLDOWN', 429, { retryAfterMs: cooldownMs - (now - payer.last_tx) });
    const r = S.debit.run(sats, now, from, sats);
    if (r.changes !== 1) throw err('INSUFFICIENT_FUNDS', 402);
    S.ensureUser.run(to, now);
    S.credit.run(sats, to);
  }
  S.insTx.run(txId, date, from, to, sats);
  invalidateUser(ctx, from, to);
  return { txId, date, from, to, amount: sats };
}

/** transfer({ from, to, sats, txId?, cooldownMs? }) → { txId, date } */
function transfer({ from, to, sats, txId = crypto.randomUUID(), cooldownMs = 0, now }) {
  from = String(from); to = String(to);
  if (from === to) return Promise.reject(err('SELF_TRANSFER'));
  return write((ctx) => doTransfer(ctx, { from, to, sats, txId, now: now || Date.now(), cooldownMs }));
}

/**
 * claim({ userId, sats, cooldownMs, maxSupply }) — mints `sats` from the system account.
 * Cooldown and supply cap are checked inside the transaction (no double claims).
 */
function claim({ userId, sats, cooldownMs, maxSupply = 0, systemId, txId = crypto.randomUUID(), now }) {
  userId = String(userId);
  return write((ctx) => {
    now = now || Date.now();
    S.ensureUser.run(userId, now);
    const u = readUser(userId);
    const last = Number(u.cooldown || 0);
    if (last && now - last < cooldownMs) throw err('COOLDOWN_ACTIVE', 429, { nextClaimInMs: cooldownMs - (now - last), lastClaimTs: last });
    const minted = Number((S.kvGet.get('total_minted') || {}).value || 0);
    let amount = sats;
    if (maxSupply > 0) {
      const left = maxSupply - minted;
      if (left <= 0) throw err('MAX_SUPPLY_REACHED', 409);
      if (amount > left) amount = left;
    }
    S.credit.run(amount, userId);
    S.setCooldown.run(now, userId);
    const date = iso(now);
    S.insTx.run(txId, date, systemId, userId, amount);
    S.kvSet.run('total_minted', String(money.add(minted, amount)));
    invalidateUser(ctx, userId);
    return { txId, date, amount, lastClaimTs: now };
  });
}

/** Pays a bill atomically. Self-pay (payer is the receiver) cancels it, recording a zero-move entry. */
function payBill({ billId, payer, cooldownMs = 0, now }) {
  payer = String(payer);
  return write((ctx) => {
    now = now || Date.now();
    const bill = S.getBill.get(String(billId));
    if (!bill) throw err('BILL_NOT_FOUND', 404);
    if (bill.expires_at && bill.expires_at < now) { S.delBill.run(bill.bill_id); throw keepErr('BILL_EXPIRED', 410); }
    const self = String(bill.to_id) === payer;
    const out = self
      ? { txId: null, date: iso(now), from: payer, to: payer, amount: Number(bill.amount) } // cancel: no coins move, no ledger row
      : doTransfer(ctx, { from: payer, to: String(bill.to_id), sats: Number(bill.amount), txId: bill.bill_id, now, cooldownMs });
    S.delBill.run(bill.bill_id);
    return { ...out, self, bill: { id: bill.bill_id, from_id: bill.from_id, to_id: bill.to_id, amount: Number(bill.amount) } };
  });
}

/** Restores a wallet backup: moves the whole balance of the original wallet to `userId`. */
function restoreBackup({ code, userId, txId = crypto.randomUUID(), now }) {
  userId = String(userId);
  return write((ctx) => {
    now = now || Date.now();
    const row = S.getBackup.get(String(code));
    if (!row) throw err('BACKUP_NOT_FOUND', 404);
    const owner = String(row.userId);
    if (owner === userId) { S.delBackup.run(row.code); throw keepErr('BACKUP_SAME_ACCOUNT', 400); }
    const orig = readUser(owner);
    const bal = orig ? Number(orig.coins) : 0;
    if (bal <= 0) { S.delBackup.run(row.code); throw keepErr('BACKUP_EMPTY', 400); }
    const out = doTransfer(ctx, { from: owner, to: userId, sats: bal, txId, now });
    S.delBackup.run(row.code);
    return { ...out, fromUser: owner };
  });
}

/* ═══════════════════════════════ LEDGER READS ═══════════════════════════════ */
function getTransaction(id) {
  id = String(id);
  const hit = C.tx.get(id);
  if (hit !== undefined) return hit;
  const row = S.getTx.get(id) || null;
  if (row) C.tx.set(id, row);
  return row;
}
function listTransactions(userId, limit = 20, offset = 0) {
  userId = String(userId);
  const n = offset + limit;
  return S.txPage.all(userId, n, userId, n, limit, offset);
}
function countTransactions(userId) {
  userId = String(userId);
  return S.txCountFrom.get(userId).n + S.txCountTo.get(userId).n - S.txCountSelf.get(userId, userId).n;
}
const recentTransactions = (limit) => S.txRecent.all(limit);
/** daily in/out sums (sats) for a user since `sinceIso` → { 'YYYY-MM-DD': {in, out} } */
function dailyFlow(userId, sinceIso) {
  userId = String(userId);
  const map = {};
  for (const r of S.flowTo.all(userId, userId, sinceIso)) (map[r.d] || (map[r.d] = { in: 0, out: 0 })).in = Number(r.s);
  for (const r of S.flowFrom.all(userId, userId, sinceIso)) (map[r.d] || (map[r.d] = { in: 0, out: 0 })).out = Number(r.s);
  return map;
}

/* ═══════════════════════════════ STATS ═══════════════════════════════ */
function stats(now = Date.now(), systemId) {
  const since = iso(now - 864e5);
  const t24 = S.txSince.get(since);
  return {
    totalCoins: S.totalCoins.get().s,
    totalUsers: S.userCount.get().n,
    holders: S.holderCount.get().n,
    totalTransactions: S.txCount.get().n,
    totalClaims: S.claimCount.get(systemId).n,
    openBills: S.billCount.get().n,
    totalCards: S.cardCount.get().n,
    newUsers24h: S.newUsersSince.get(now - 864e5).n,
    transactions24h: t24.n,
    volume24h: t24.v,
    claims24h: S.claimsSince.get(systemId, since).n,
    activeUsers24h: S.activeSince.get(since, since, systemId).n,
    totalMinted: Number((S.kvGet.get('total_minted') || {}).value || 0)
  };
}
const historyDays = (sinceIso, systemId) => S.historyDays.all(systemId, sinceIso);
const topUsers = (limit, offset, systemId) => S.topUsers.all(systemId, limit, offset);
const holderCount = () => S.holderCount.get().n;
const rankOf = (coins, systemId) => S.rankOf.get(coins, systemId).r;
const totalCoins = () => S.totalCoins.get().s;
const userCount = () => S.userCount.get().n;

/* ═══════════════════════════════ CARDS ═══════════════════════════════ */
function getCardByOwner(userId) {
  const k = 'o:' + userId;
  const hit = C.cards.get(k);
  if (hit !== undefined) return hit;
  const r = S.cardByOwner.get(String(userId));
  const code = r ? r.code : null;
  C.cards.set(k, code);
  return code;
}
function getCardOwner(code) {
  if (typeof code !== 'string' || code.length < 4 || code.length > 128) return null;
  const r = S.cardByCode.get(code) || S.cardByHash.get(sha256(code));
  return r ? r.owner_id : null;
}
function getCardOwnerByHash(hash) {
  if (!/^[a-f0-9]{64}$/i.test(String(hash))) return null;
  const r = S.cardByHash.get(String(hash).toLowerCase());
  return r ? r.owner_id : null;
}
function setCard(userId, code) {
  userId = String(userId);
  return write((ctx) => {
    S.ensureUser.run(userId, Date.now());
    S.delCardsOf.run(userId);
    S.insCard.run(code, userId, sha256(code));
    invalidateUser(ctx, userId);
    ctx.after(() => C.cards.set('o:' + userId, code));
    return code;
  });
}

/* ═══════════════════════════════ BILLS ═══════════════════════════════ */
function createBill({ billId = crypto.randomUUID(), from, to, sats, now = Date.now(), expiresAt }) {
  return write(() => { S.insBill.run(billId, from ? String(from) : '', String(to), sats, now, expiresAt); return billId; });
}
const getBill = (id) => S.getBill.get(String(id)) || null;
const listBillsFrom = (userId, limit, offset) => S.billsFrom.all(String(userId), limit, offset);
const listBillsTo = (userId, limit, offset) => S.billsTo.all(String(userId), limit, offset);
const deleteBill = (id) => write(() => S.delBill.run(String(id)).changes);
const expiredBills = (now, limit = 500) => S.billsExpired.all(now, limit);

/* ═══════════════════════════════ BACKUPS ═══════════════════════════════ */
const listBackupCodes = (userId) => S.backupCodes.all(String(userId)).map((r) => r.code);
function addBackupCodes(userId, codes) {
  return write(() => { let n = 0; for (const c of codes) n += S.insBackup.run(c, String(userId)).changes; return n; });
}

/* ═══════════════════════════════ SESSIONS ═══════════════════════════════ */
function createSession({ tokenHash, userId, ttlMs, maxPerUser = 5, now = Date.now() }) {
  userId = String(userId);
  return write((ctx) => {
    S.insSession.run(tokenHash, userId, now, now + ttlMs);
    const rows = S.userSessions.all(userId);
    const dropped = [];
    for (let i = maxPerUser; i < rows.length; i++) { S.delSession.run(rows[i].token_hash); dropped.push(rows[i].token_hash); }
    ctx.after(() => { for (const h of dropped) C.sessions.delete(h); C.sessions.set(tokenHash, { user_id: userId, expires_at: now + ttlMs }); });
    return true;
  });
}
function getSession(tokenHash) {
  const hit = C.sessions.get(tokenHash);
  if (hit !== undefined) {
    if (hit && hit.expires_at < Date.now()) { C.sessions.delete(tokenHash); return null; }
    return hit;
  }
  const r = S.getSession.get(tokenHash);
  const v = r && r.expires_at >= Date.now() ? { user_id: r.user_id, expires_at: r.expires_at } : null;
  C.sessions.set(tokenHash, v, v ? 0 : 30000);
  return v;
}
function deleteSession(tokenHash) {
  return write((ctx) => { S.delSession.run(tokenHash); ctx.after(() => C.sessions.delete(tokenHash)); return true; });
}
function deleteUserSessions(userId) {
  return write((ctx) => {
    const rows = S.userSessions.all(String(userId));
    S.delUserSessions.run(String(userId));
    ctx.after(() => { for (const r of rows) C.sessions.delete(r.token_hash); });
    return rows.length;
  });
}
/** Changes credentials and revokes every session atomically. */
function changeCredentials(userId, username, passwordHash) {
  userId = String(userId);
  return write((ctx) => {
    assertUsernameFree(username, userId);
    S.ensureUser.run(userId, Date.now());
    S.setCreds.run(username, passwordHash, userId);
    const rows = S.userSessions.all(userId);
    S.delUserSessions.run(userId);
    invalidateUser(ctx, userId);
    ctx.after(() => { for (const r of rows) C.sessions.delete(r.token_hash); });
    return true;
  });
}

/* ═══════════════════════════════ RATE LIMIT COUNTERS (persistent, anonymous) ═══════════════════════════════ */
function hitLimit(key, kind, windowMs, now = Date.now()) {
  return write(() => {
    S.upLimit.run(key, kind, now, now + windowMs);
    return S.getLimit.get(key, kind).count;
  });
}
function peekLimit(key, kind, now = Date.now()) {
  const r = S.getLimit.get(key, kind);
  return r && r.expires_at >= now ? r.count : 0;
}

/* ═══════════════════════════════ DM OUTBOX ═══════════════════════════════ */
const enqueueDM = (userId, payloadBuf, now = Date.now()) => write(() => S.insDM.run(String(userId), payloadBuf, now, now).lastInsertRowid);
const dueDMs = (now, limit) => S.dueDMs.all(now, limit);
const deleteDM = (id) => write(() => S.delDM.run(id).changes);
const retryDM = (id, nextAt) => write(() => S.retryDM.run(nextAt, id).changes);
/** Reserves a due DM for sending (returns 1 if this worker got it) — prevents double delivery. */
const holdDM = (id, until, now = Date.now()) => write(() => S.holdDM.run(until, id, now).changes);
const countDMs = () => S.countDM.get().n;

/* ═══════════════════════════════ GUILD SETTINGS ═══════════════════════════════ */
function getServer(guildId) {
  const k = String(guildId);
  const hit = C.servers.get(k);
  if (hit !== undefined) return hit;
  const r = S.getServer.get(k) || null;
  C.servers.set(k, r);
  return r;
}
function setServer(guildId, fields) {
  const k = String(guildId);
  return write((ctx) => {
    const cur = S.getServer.get(k) || {};
    const next = {
      api_channel: fields.api_channel !== undefined ? fields.api_channel : cur.api_channel ?? null,
      atm_channel: fields.atm_channel !== undefined ? fields.atm_channel : cur.atm_channel ?? null,
      lang: fields.lang !== undefined ? fields.lang : cur.lang ?? null,
      cmds_purged: fields.cmds_purged !== undefined ? (fields.cmds_purged ? 1 : 0) : (cur.cmds_purged ? 1 : 0)
    };
    S.upServer.run(k, next.api_channel, next.atm_channel, next.lang, next.cmds_purged, Date.now());
    ctx.after(() => C.servers.delete(k));
    return { server_id: k, ...next };
  });
}
const purgedGuildIds = () => new Set(S.purgedGuilds.all().map((r) => r.server_id));

/* ═══════════════════════════════ STAFF / KV ═══════════════════════════════ */
/* ═══════════════════════════════ QR PAYMENT REQUESTS ═══════════════════════════════ */
const PR_CLOSED = { paid: 'PAYREQ_PAID', cancelled: 'PAYREQ_CANCELLED', expired: 'PAYREQ_EXPIRED' };
function createPayRequest({ id, to, sats = null, memo = null, reusable = false, expiresAt, now = Date.now() }) {
  return write((ctx) => {
    S.ensureUser.run(String(to), now);
    S.insPayReq.run(id, String(to), sats, memo, reusable ? 1 : 0, now, expiresAt);
    invalidateUser(ctx, to);
    return S.getPayReq.get(id);
  });
}
const getPayRequest = (id) => S.getPayReq.get(String(id)) || null;
const listPayRequests = (to, status, limit, offset) => (status ? S.payReqsOfStatus.all(String(to), status, limit, offset) : S.payReqsOf.all(String(to), limit, offset));
/** Pays a request atomically: transfer + request state change in the same transaction (no double payment). */
function payPayRequest({ id, payer, sats = null, txId = crypto.randomUUID(), cooldownMs = 0, now }) {
  payer = String(payer);
  return write((ctx) => {
    now = now || Date.now();
    const r = S.getPayReq.get(String(id));
    if (!r) throw err('PAYREQ_NOT_FOUND', 404);
    if (r.status !== 'open') throw err(PR_CLOSED[r.status] || 'PAYREQ_CLOSED', r.status === 'expired' ? 410 : 409);
    if (r.expires_at < now) { S.payReqStatus.run('expired', r.id); throw keepErr('PAYREQ_EXPIRED', 410); }
    const amount = r.amount !== null && r.amount !== undefined ? Number(r.amount) : sats;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw err('AMOUNT_REQUIRED');
    if (payer === String(r.to_id)) throw err('SELF_TRANSFER');
    const out = doTransfer(ctx, { from: payer, to: String(r.to_id), sats: amount, txId, now, cooldownMs });
    const u = S.payReqDone.run(money.add(Number(r.paid_total || 0), amount), out.txId, payer, now, r.reusable ? 'open' : 'paid', r.id);
    if (u.changes !== 1) throw err('PAYREQ_CLOSED', 409);
    return { ...out, request: S.getPayReq.get(r.id) };
  });
}
function cancelPayRequest(id, owner) {
  return write(() => {
    const r = S.getPayReq.get(String(id));
    if (!r || String(r.to_id) !== String(owner)) throw err('PAYREQ_NOT_FOUND', 404);
    if (r.status !== 'open') throw err(PR_CLOSED[r.status] || 'PAYREQ_CLOSED', 409);
    S.payReqStatus.run('cancelled', r.id);
    return S.getPayReq.get(r.id);
  });
}

const listStaff = () => S.listStaff.all();
const addStaff = (id, by) => write(() => S.addStaff.run(String(id), String(by || ''), Date.now()).changes);
const removeStaff = (id) => write(() => S.delStaff.run(String(id)).changes);
const kvGet = (k) => { const r = S.kvGet.get(k); return r ? r.value : null; };
const kvSet = (k, v) => write(() => S.kvSet.run(k, String(v)).changes);

/* ═══════════════════════════════ MAINTENANCE ═══════════════════════════════ */
async function cleanup(now = Date.now()) {
  const out = { transactions: 0, sessions: 0, limits: 0, dms: 0 };
  const days = Number(cfg.retention.transactions_days) || 0;
  if (days > 0) {
    const cutoff = iso(now - days * 864e5);
    for (let i = 0; i < 2000; i++) {
      const n = await write(() => S.delOldTx.run(cutoff).changes);
      out.transactions += n;
      if (n < 5000) break;
    }
    if (out.transactions) C.tx.clear();
  }
  out.sessions = await write(() => S.delExpiredSessions.run(now).changes);
  out.limits = await write(() => S.delExpiredLimits.run(now).changes);
  out.payRequests = await write(() => S.payReqExpire.run(now).changes + S.payReqPurge.run(now - Math.max(7, days || 30) * 864e5).changes);
  const dmDays = Number(cfg.retention.dm_queue_days) || 7;
  out.dms = await write(() => S.delOldDM.run(now - dmDays * 864e5).changes);
  if (out.transactions || out.sessions || out.dms) log.info(`cleanup: ${out.transactions} old transactions, ${out.sessions} expired sessions, ${out.limits} limit counters, ${out.dms} stale DMs`);
  return out;
}

function checkpoint(mode = 'PASSIVE') {
  if (flushing) return;
  try { D.exec(`PRAGMA wal_checkpoint(${mode})`); } catch (e) { log.debug('checkpoint:', e.message); }
}
function optimize() { try { D.exec('PRAGMA optimize'); } catch (e) { log.debug('optimize:', e.message); } }
function shrinkMemory() { try { D.exec('PRAGMA shrink_memory'); } catch {} }

async function backupNow() {
  const b = cfg.database.backup;
  const dir = require('./lib/config').resolvePath(b.dir);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(dir, `database-${stamp}.db`);
  const t0 = Date.now();
  if (D.backup) {
    await D.backup(dest);
  } else {
    D.prepare('VACUUM INTO ?').run(dest);
  }
  const files = fs.readdirSync(dir).filter((f) => /^database-.*\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - Math.max(1, b.keep)))) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  log.info(`backup written: ${path.basename(dest)} (${Date.now() - t0} ms)`);
  return dest;
}

/** Ledger audit: sum of all balances must equal everything ever minted. */
function audit() {
  const sum = S.totalCoins.get().s;
  const minted = Number((S.kvGet.get('total_minted') || {}).value || 0);
  const ok = sum === minted;
  if (!ok) log.error(`LEDGER AUDIT MISMATCH: balances=${money.format(sum)} minted=${money.format(minted)} (diff ${money.format(sum - minted)})`);
  else log.debug(`ledger audit ok: ${money.format(sum)} coins`);
  return { ok, balances: sum, minted };
}

function every(ms, fn) {
  if (!ms || ms <= 0) return;
  const t = setInterval(() => { Promise.resolve().then(fn).catch((e) => log.warn('maintenance task failed:', e.message)); }, ms);
  t.unref(); timers.push(t);
}

/* ═══════════════════════════════ INIT / CLOSE ═══════════════════════════════ */
function init(config) {
  if (D) return module.exports;
  cfg = config;
  const dbc = cfg.database;
  dbFile = require('./lib/config').resolvePath(dbc.file);
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  D = openDriver(dbFile);
  const pragmas = [
    'journal_mode = WAL', 'synchronous = NORMAL', 'temp_store = MEMORY', 'foreign_keys = OFF',
    `cache_size = -${Math.max(1024, Number(dbc.sqlite_cache_kb) || 16384)}`,
    `mmap_size = ${Math.max(0, Number(dbc.mmap_mb) || 0) * 1024 * 1024}`,
    'busy_timeout = 5000', 'wal_autocheckpoint = 1000', 'journal_size_limit = 67108864', 'secure_delete = OFF'
  ];
  for (const p of pragmas) { try { D.exec(`PRAGMA ${p}`); } catch (e) { log.debug(`pragma ${p}:`, e.message); } }
  migrate();
  prepareAll();
  C.users = new LRU({ name: 'db.users', max: dbc.cache_users || 50000, ttl: 10 * 60e3 });
  C.sessions = new LRU({ name: 'db.sessions', max: dbc.cache_sessions || 50000, ttl: 10 * 60e3 });
  C.tx = new LRU({ name: 'db.tx', max: dbc.cache_transactions || 5000, ttl: 30 * 60e3 });
  C.cards = new LRU({ name: 'db.cards', max: 20000, ttl: 30 * 60e3 });
  C.servers = new LRU({ name: 'db.servers', max: 5000, ttl: 30 * 60e3, soft: false });

  every((dbc.checkpoint_minutes || 5) * 60e3, () => checkpoint('PASSIVE'));
  every((dbc.optimize_hours || 6) * 3600e3, () => { optimize(); checkpoint('TRUNCATE'); });
  every((cfg.retention.cleanup_minutes || 10) * 60e3, () => cleanup());
  every((dbc.audit_minutes || 30) * 60e3, () => audit());
  if (dbc.backup && dbc.backup.enabled) every(Math.max(0.25, Number(dbc.backup.interval_hours) || 6) * 3600e3, () => backupNow());
  setTimeout(() => { cleanup().catch(() => {}); audit(); }, 15000).unref();

  try { require('./lib/memory').register('database', { light: () => {}, heavy: shrinkMemory }); } catch {}
  log.info(`ready (${D.kind}) → ${path.relative(require('./lib/config').ROOT, dbFile)}`);
  return module.exports;
}

function close() {
  if (!D) return;
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  try { drain(); } catch (e) { log.error('drain failed:', e.message); }
  try { checkpoint('TRUNCATE'); optimize(); } catch {}
  try { D.close(); } catch {}
  D = null; S = null;
  log.info('closed');
}

function info() {
  return {
    driver: D ? D.kind : null, file: dbFile, queue: qLength(), writes: { ...wstats },
    dmPending: D ? countDMs() : 0
  };
}

module.exports = {
  init, close, drain, write, info, err,
  // users
  getUser, userExists, getBalance, getUserByUsername, usernameTaken, createAccount, setCredentials, setPassword, ensureUser, changeCredentials,
  // money
  transfer, claim, payBill, restoreBackup,
  // ledger
  getTransaction, listTransactions, countTransactions, recentTransactions, dailyFlow,
  // stats
  stats, historyDays, topUsers, holderCount, rankOf, totalCoins, userCount,
  // cards
  getCardByOwner, getCardOwner, getCardOwnerByHash, setCard,
  // bills
  createBill, getBill, listBillsFrom, listBillsTo, deleteBill, expiredBills,
  // backups
  listBackupCodes, addBackupCodes,
  // sessions
  createSession, getSession, deleteSession, deleteUserSessions,
  // limits
  hitLimit, peekLimit,
  // QR payment requests
  createPayRequest, getPayRequest, listPayRequests, payPayRequest, cancelPayRequest,
  // dm
  enqueueDM, dueDMs, deleteDM, retryDM, holdDM, countDMs,
  // guilds / staff / kv
  getServer, setServer, purgedGuildIds, listStaff, addStaff, removeStaff, kvGet, kvSet,
  // maintenance
  cleanup, checkpoint, optimize, backupNow, audit, shrinkMemory,
  sha256
};

'use strict';
/**
 * lib/cache.js — tiny, fast LRU + TTL cache built on Map insertion order.
 * Every cache registers itself so the memory optimizer can prune / trim them.
 */
const registry = new Set();

class LRU {
  /**
   * @param {object} o
   * @param {string} o.name      label (metrics)
   * @param {number} o.max       max entries (oldest evicted first)
   * @param {number} [o.ttl]     default time-to-live in ms (0 = no expiry)
   * @param {boolean} [o.soft]   soft caches may be fully cleared under memory pressure
   */
  constructor({ name = 'cache', max = 1000, ttl = 0, soft = true } = {}) {
    this.name = name; this.max = Math.max(1, max | 0); this.ttl = ttl; this.soft = soft;
    this.map = new Map(); this.hits = 0; this.misses = 0;
    registry.add(this);
  }
  get size() { return this.map.size; }
  get(key) {
    const e = this.map.get(key);
    if (e === undefined) { this.misses++; return undefined; }
    if (e.x && e.x < Date.now()) { this.map.delete(key); this.misses++; return undefined; }
    // refresh recency (cheap for Map)
    this.map.delete(key); this.map.set(key, e);
    this.hits++;
    return e.v;
  }
  peek(key) { const e = this.map.get(key); if (!e || (e.x && e.x < Date.now())) return undefined; return e.v; }
  has(key) { return this.peek(key) !== undefined; }
  set(key, v, ttl = this.ttl) {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { v, x: ttl ? Date.now() + ttl : 0 });
    return v;
  }
  delete(key) { return this.map.delete(key); }
  clear() { this.map.clear(); }
  /** remove expired entries */
  prune() {
    const now = Date.now(); let n = 0;
    for (const [k, e] of this.map) if (e.x && e.x < now) { this.map.delete(k); n++; }
    return n;
  }
  /** keep only the newest `ratio` part of the cache */
  trim(ratio = 0.5) {
    const keep = Math.floor(this.map.size * ratio); let drop = this.map.size - keep;
    for (const k of this.map.keys()) { if (drop-- <= 0) break; this.map.delete(k); }
  }
  /** memoize an async/sync producer */
  async wrap(key, producer, ttl = this.ttl) {
    const v = this.get(key);
    if (v !== undefined) return v;
    const out = await producer();
    if (out !== undefined) this.set(key, out, ttl);
    return out;
  }
  stats() { return { name: this.name, size: this.map.size, max: this.max, hits: this.hits, misses: this.misses }; }
}

/** Collapses concurrent identical async calls into one (thundering-herd protection). */
class SingleFlight {
  constructor() { this.pending = new Map(); }
  run(key, fn) {
    const p = this.pending.get(key);
    if (p) return p;
    const q = Promise.resolve().then(fn).finally(() => this.pending.delete(key));
    this.pending.set(key, q);
    return q;
  }
}

/** Simple async semaphore (limits CPU-heavy work like scrypt / image rendering). */
class Semaphore {
  constructor(max = 2, maxQueue = 1000) { this.max = max; this.active = 0; this.q = []; this.maxQueue = maxQueue; }
  async run(fn) {
    if (this.active >= this.max) {
      if (this.q.length >= this.maxQueue) throw Object.assign(new Error('BUSY'), { code: 'QUEUE_FULL' });
      await new Promise((r) => this.q.push(r));
    }
    this.active++;
    try { return await fn(); } finally {
      this.active--;
      const n = this.q.shift(); if (n) n();
    }
  }
}

function pruneAll() { let n = 0; for (const c of registry) n += c.prune(); return n; }
function trimAll(ratio = 0.5) { for (const c of registry) if (c.soft) c.trim(ratio); }
function statsAll() { return [...registry].map((c) => c.stats()); }

module.exports = { LRU, SingleFlight, Semaphore, pruneAll, trimAll, statsAll, registry };

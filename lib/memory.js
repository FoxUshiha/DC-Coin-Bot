'use strict';
/**
 * lib/memory.js — periodic memory optimizer.
 *
 *  • works with or without --expose-gc (tries to enable GC at runtime)
 *  • prunes expired cache entries every tick, trims soft caches under pressure
 *  • runs module hooks (SQLite shrink_memory, discord.js sweepers, temp files)
 *  • light incremental GC normally, full GC only when above the soft limits
 *  • every step is async-friendly: timers are unref()'d and never block exit
 */
const v8 = require('v8');
const vm = require('vm');
const cache = require('./cache');
const log = require('./log').scope('memory');

let gcFn = null;
function acquireGC(force) {
  if (gcFn) return gcFn;
  if (typeof global.gc === 'function') return (gcFn = global.gc);
  if (!force) return null;
  try {
    v8.setFlagsFromString('--expose_gc');
    const g = vm.runInNewContext('gc');
    if (typeof g === 'function') gcFn = g;
  } catch { /* not available */ }
  return gcFn;
}

function runGC(type = 'major') {
  const g = gcFn; if (!g) return false;
  try { g({ type, execution: type === 'minor' ? 'async' : 'sync' }); }
  catch { try { g(); } catch { return false; } }
  return true;
}

const MB = 1024 * 1024;
const hooks = new Map();
let timer = null, ticks = 0, cfg = null, last = null;

/**
 * register(name, { light, heavy }) — light() runs every tick, heavy() only under
 * memory pressure. Both may be async; errors are swallowed and logged.
 */
function register(name, fns) { hooks.set(name, fns || {}); }
function unregister(name) { hooks.delete(name); }

async function runHooks(kind) {
  for (const [name, h] of hooks) {
    if (typeof h[kind] !== 'function') continue;
    try { await h[kind](); } catch (e) { log.debug(`hook ${name}.${kind} failed:`, e.message); }
  }
}

async function tick(forceHeavy = false) {
  ticks++;
  const before = process.memoryUsage();
  const pruned = cache.pruneAll();
  await runHooks('light');
  const pressure = forceHeavy || before.heapUsed > cfg.heap_soft_limit_mb * MB || before.rss > cfg.rss_soft_limit_mb * MB;
  if (pressure) {
    cache.trimAll(0.5);
    await runHooks('heavy');
    runGC('major');
  } else if (ticks % 5 === 0) {
    runGC('minor');
  }
  const after = process.memoryUsage();
  last = { ts: Date.now(), pressure, pruned, rssMB: +(after.rss / MB).toFixed(1), heapUsedMB: +(after.heapUsed / MB).toFixed(1), heapTotalMB: +(after.heapTotal / MB).toFixed(1), externalMB: +(after.external / MB).toFixed(1) };
  if (cfg.log_stats || pressure) log.info(`rss ${last.rssMB}MB heap ${last.heapUsedMB}/${last.heapTotalMB}MB ext ${last.externalMB}MB${pressure ? ' (pressure → trimmed + full GC)' : ''}`);
  return last;
}

function start(memCfg) {
  cfg = Object.assign({ enabled: true, interval_seconds: 60, heap_soft_limit_mb: 320, rss_soft_limit_mb: 450, force_gc: true, log_stats: false }, memCfg || {});
  if (!cfg.enabled || timer) return;
  const g = acquireGC(cfg.force_gc);
  log.info(`memory optimizer on (every ${cfg.interval_seconds}s, GC ${g ? 'available' : 'unavailable — run with --expose-gc for best results'})`);
  timer = setInterval(() => { tick().catch((e) => log.warn('tick failed', e)); }, Math.max(5, cfg.interval_seconds) * 1000);
  timer.unref();
}

function stop() { if (timer) clearInterval(timer); timer = null; }

function stats() {
  const m = process.memoryUsage();
  return {
    rssMB: +(m.rss / MB).toFixed(1), heapUsedMB: +(m.heapUsed / MB).toFixed(1), heapTotalMB: +(m.heapTotal / MB).toFixed(1),
    externalMB: +(m.external / MB).toFixed(1), arrayBuffersMB: +((m.arrayBuffers || 0) / MB).toFixed(1),
    heapLimitMB: +(v8.getHeapStatistics().heap_size_limit / MB).toFixed(0), gc: !!gcFn, lastTick: last, caches: cache.statsAll()
  };
}

module.exports = { start, stop, tick, register, unregister, stats, runGC, acquireGC };

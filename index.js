'use strict';
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  COIN BANK — main entry                                        ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Works in every way you load it:
 *   node index.js                         → starts everything
 *   const bank = require('./index.js')    → starts (system.autostart) and returns the controller
 *   import bank from './index.js'         → same (CommonJS default export)
 *   import { start, stop } from './index.mjs'
 *
 * Set system.autostart: false in config.yml (or env COIN_BANK_NO_AUTOSTART=1) to start it
 * manually with `await bank.start({ config: 'other.yml', overrides: { api: { port: 8080 } } })`.
 *
 * Start order: config.yml → memory optimizer → database.js → logic.js → api.js → bot.js → tunnels
 * The DM queue (logic.js) only runs while the Discord bot is online.
 */
const configLib = require('./lib/config');
const logLib = require('./lib/log');
const log = logLib.scope('index');

const state = { started: false, starting: null, stopping: null, cfg: null, server: null, signals: false, crashes: [] };

const bank = {
  start, stop, status,
  get started() { return state.started; },
  get config() { return state.cfg; },
  get database() { return require('./database'); },
  get logic() { return require('./logic'); },
  get api() { return require('./api'); },
  get bot() { return require('./bot'); },
  get memory() { return require('./lib/memory'); },
  get money() { return require('./lib/money'); },
  ready: null
};

/**
 * start({ config?: string, overrides?: object }) → Promise<bank>
 * Idempotent: calling it twice returns the same running instance.
 */
async function start(opts = {}) {
  if (state.started) return bank;
  if (state.starting) return state.starting;
  state.starting = (async () => {
    const t0 = Date.now();
    const cfg = configLib.load({ file: opts.config, overrides: opts.overrides, reload: !!(opts.config || opts.overrides) });
    state.cfg = cfg;
    logLib.setLevel(cfg.logging.level, cfg.logging.timestamps);
    for (const w of cfg.__warnings || []) log.warn(w);
    log.info(`starting Coin Bank (node ${process.version}, pid ${process.pid})…`);

    require('./lib/memory').start(cfg.memory);
    require('./database').init(cfg);
    require('./logic').init(cfg);

    if (cfg.api.enabled) {
      try { state.server = await require('./api').start(cfg); }
      catch (e) { log.error(`API could not start on ${cfg.api.host}:${cfg.api.port} — ${e.code === 'EADDRINUSE' ? 'port already in use' : e.message}`); }
    } else log.info('API disabled (api.enabled: false)');

    if (cfg.discord.enabled) {
      try { await require('./bot').start(cfg); } catch (e) { log.error('bot failed to start:', e.message); }
    } else log.info('Discord bot disabled (discord.enabled: false) — DM queue off');

    require('./lib/tunnel').start(cfg).catch((e) => log.warn('tunnel:', e.message));

    // Sozinho (node index.js): instala os handlers de sinal/erro do processo.
    // Como submódulo (require de outro index, ex.: memguard): NÃO mexe no processo — o index de cima
    // é quem decide sair; só fecha o Coin Bank com segurança quando ele avisar.
    if (cfg.system.handle_signals && require.main === module) installSignals();
    else hookParent();
    state.started = true;
    log.info(`ready in ${Date.now() - t0} ms`);
    return bank;
  })();
  try { return await state.starting; }
  catch (e) { log.error('startup failed:', e); throw e; }
  finally { state.starting = null; }
}

/** Graceful shutdown: stops accepting requests, flushes the write queue, closes the DB. */
async function stop(reason = 'stop') {
  if (state.stopping) return state.stopping;
  state.stopping = (async () => {
    log.info(`shutting down (${reason})…`);
    const step = async (name, fn) => { try { await fn(); } catch (e) { log.warn(`${name} stop failed:`, e.message); } };
    await step('api', () => require('./api').stop());
    await step('bot', () => require('./bot').stop());
    await step('logic', () => require('./logic').stop());
    await step('tunnel', () => require('./lib/tunnel').stop());
    await step('memory', () => require('./lib/memory').stop());
    await step('database', () => require('./database').close());
    state.started = false;
    log.info('bye 👋');
  })();
  try { await state.stopping; } finally { state.stopping = null; }
}

function status() {
  const db = require('./database');
  return {
    started: state.started, uptime: process.uptime(),
    api: !!(require('./api').getServer()), bot: require('./bot').isOnline(),
    database: state.started ? db.info() : null, memory: require('./lib/memory').stats()
  };
}

/** submódulo: fecha com segurança quando o index de cima for encerrar (sem chamar process.exit) */
function hookParent() {
  if (state.signals) return;
  state.signals = true;
  const mg = global.memguard;
  if (mg && typeof mg.onShutdown === 'function') mg.onShutdown((why) => { stop(`parent: ${why}`).catch(() => {}); });
  process.once('beforeExit', () => { if (state.started) stop('beforeExit').catch(() => {}); });
}

function installSignals() {
  if (state.signals) return;
  state.signals = true;
  const bye = (sig) => {
    const force = setTimeout(() => process.exit(1), 10000); force.unref();
    stop(sig).finally(() => process.exit(0));
  };
  process.once('SIGINT', () => bye('SIGINT'));
  process.once('SIGTERM', () => bye('SIGTERM'));
  if (process.platform !== 'win32') process.once('SIGHUP', () => bye('SIGHUP'));
  process.on('unhandledRejection', (r) => log.error('unhandled rejection:', r));
  process.on('uncaughtException', (e) => {
    log.error('uncaught exception:', e);
    const now = Date.now();
    state.crashes = state.crashes.filter((t) => now - t < 60000);
    state.crashes.push(now);
    if (state.crashes.length > 30) { log.error('too many errors in 1 minute — restarting process'); bye('crash-loop'); }
  });
}

// ── autostart (require / import / node index.js)
function shouldAutostart() {
  if (process.env.COIN_BANK_NO_AUTOSTART === '1') return false;
  if (require.main === module) return true;
  try { return configLib.load().system.autostart !== false; } catch (e) { console.error('[index] config error:', e.message); return false; }
}
if (shouldAutostart()) {
  bank.ready = start().catch((e) => {
    console.error('[index] fatal startup error:', e && e.message ? e.message : e);
    if (require.main === module) process.exit(1);
  });
}

module.exports = bank;
module.exports.default = bank;

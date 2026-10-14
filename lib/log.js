'use strict';
/**
 * lib/log.js — tiny zero-dependency logger (levels + timestamps + scopes).
 * Level is set once from config (logging.level): debug | info | warn | error | silent
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
let current = LEVELS.info;
let withTime = true;

function setLevel(name, timestamps = true) {
  current = LEVELS[String(name || 'info').toLowerCase()] || LEVELS.info;
  withTime = timestamps !== false;
}

function stamp() {
  if (!withTime) return '';
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} `;
}

function fmtErr(a) {
  if (a instanceof Error) return a.stack || a.message;
  return a;
}

function scope(name) {
  const tag = `[${name}]`;
  return {
    debug: (...a) => { if (current <= LEVELS.debug) console.log(stamp() + tag, ...a.map(fmtErr)); },
    info: (...a) => { if (current <= LEVELS.info) console.log(stamp() + tag, ...a.map(fmtErr)); },
    warn: (...a) => { if (current <= LEVELS.warn) console.warn(stamp() + tag, ...a.map(fmtErr)); },
    error: (...a) => { if (current <= LEVELS.error) console.error(stamp() + tag, ...a.map(fmtErr)); },
    get isDebug() { return current <= LEVELS.debug; }
  };
}

module.exports = { scope, setLevel, LEVELS };

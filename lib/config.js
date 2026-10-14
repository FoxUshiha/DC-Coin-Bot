'use strict';
/**
 * lib/config.js — loads ./config.yml (creating it from the template when missing,
 * importing values from an old .env if one exists), deep-merges it over the
 * template defaults, normalizes and freezes the result.
 */
const fs = require('fs');
const path = require('path');
const miniYaml = require('./yaml');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(__dirname, 'config.template.yml');

let cached = null;

function parseYaml(text) {
  try {
    const Y = require('yaml');
    return Y.parse(text, { intAsBigInt: true }) || {};
  } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
    return miniYaml.parse(text) || {};
  }
}

function normalize(v) {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) if (k !== '__proto__' && k !== 'constructor') o[k] = normalize(v[k]);
    return o;
  }
  return v;
}

function merge(base, over) {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || base === null || typeof over !== 'object') return over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = merge(base[k], over[k]);
  return out;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

/** Reads an old .env (if present) so the first config.yml keeps the user's values. */
function importEnv(template) {
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) return template;
  const env = {};
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const q = (s) => JSON.stringify(String(s));
  const set = (re, value) => { if (value !== undefined && value !== '') template = template.replace(re, (all, pre) => pre + value); };
  set(/^(\s*token:\s*).*$/m, env.DISCORD_TOKEN && q(env.DISCORD_TOKEN));
  set(/^(\s*client_id:\s*).*$/m, env.CLIENT_ID && q(env.CLIENT_ID));
  if (env.ADMIN && /^\d{5,32}$/.test(env.ADMIN)) {
    template = template.replace(/^(\s*owners:\s*)\[(.*?)\].*$/m, (all, pre, inner) => {
      const ids = new Set([env.ADMIN, ...(inner.match(/\d{5,32}/g) || [])]);
      return pre + '[' + [...ids].map(q).join(', ') + ']';
    });
  }
  if (env.AMOUNT && /^\d+(\.\d{1,8})?$/.test(env.AMOUNT)) set(/^(\s*claim_amount:\s*).*$/m, q(env.AMOUNT));
  if (env.WAIT && /^\d+$/.test(env.WAIT)) set(/^(\s*claim_cooldown_ms:\s*).*$/m, env.WAIT);
  const port = env.API_PORT || env.PORT;
  if (port && /^\d+$/.test(port)) set(/^(\s*port:\s*).*$/m, port);
  const yes = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));
  if (env.CLOUDFLARE_TUNNEL_NAME) set(/^(\s*name:\s*)"coin-bot".*$/m, q(env.CLOUDFLARE_TUNNEL_NAME));
  if (env.CLOUDFLARE_HOSTNAME) set(/^(\s*hostname:\s*).*$/m, q(env.CLOUDFLARE_HOSTNAME));
  if (env.CLOUDFLARE_CREDENTIALS) set(/^(\s*credentials:\s*).*$/m, q(env.CLOUDFLARE_CREDENTIALS));
  if (env.CLOUDFLARE_ENABLED !== undefined) template = template.replace(/(tunnel:\s*\n\s*enabled:\s*)(true|false)/, `$1${yes(env.CLOUDFLARE_ENABLED)}`);
  if (env.TEMP_TUNNEL_ENABLED !== undefined) template = template.replace(/(quick_tunnel:\s*\n\s*enabled:\s*)(true|false)/, `$1${yes(env.TEMP_TUNNEL_ENABLED)}`);
  return template;
}

function validate(c) {
  const warn = [];
  const idList = (arr) => (Array.isArray(arr) ? arr : arr ? [arr] : []).map((x) => String(x).trim()).filter((x) => /^\d{5,32}$/.test(x));
  c.discord.owners = idList(c.discord.owners);
  c.discord.staff = idList(c.discord.staff);
  c.discord.client_id = String(c.discord.client_id || '');
  c.discord.token = String(c.discord.token || '');
  c.economy.system_id = String(c.economy.system_id || '000000000000');
  for (const k of ['claim_amount', 'max_supply', 'min_amount']) c.economy[k] = String(c.economy[k]);
  const num = (obj, key, min, max, def) => {
    let n = Number(obj[key]);
    if (!Number.isFinite(n)) { warn.push(`${key} invalid, using ${def}`); n = def; }
    obj[key] = Math.min(max, Math.max(min, Math.floor(n)));
  };
  num(c.api, 'port', 1, 65535, 26450);
  num(c.api, 'session_ttl_hours', 1, 24 * 365, 24);
  num(c.api, 'body_limit_kb', 1, 1024, 16);
  num(c.economy, 'claim_cooldown_ms', 0, 365 * 864e5, 3600000);
  num(c.economy, 'transfer_cooldown_ms', 0, 864e5, 1000);
  num(c.economy, 'backup_codes', 1, 50, 12);
  num(c.economy, 'card_bytes', 4, 32, 6);
  num(c.database, 'write_batch_max', 1, 100000, 2000);
  num(c.dm_queue, 'interval_ms', 250, 60000, 1200);
  if (c.discord.enabled && (!c.discord.token || /PUT_YOUR/i.test(c.discord.token))) warn.push('discord.token is not set — the bot will stay offline (API keeps working).');
  return warn;
}

/**
 * load({ file, overrides }) — returns the frozen config. Cached after first call
 * unless `reload: true` is passed.
 */
function load(opts = {}) {
  if (cached && !opts.reload) return cached;
  const file = path.resolve(ROOT, opts.file || process.env.COIN_BANK_CONFIG || 'config.yml');
  const templateText = fs.readFileSync(TEMPLATE, 'utf8');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, importEnv(templateText), 'utf8');
    console.log(`[config] created ${path.relative(ROOT, file) || file} from template${fs.existsSync(path.join(ROOT, '.env')) ? ' (values imported from .env)' : ''}`);
  }
  // One-time migration: config.yml still has the placeholder token and an old .env exists →
  // copy the .env values into config.yml and rename .env to .env.old (it is no longer used).
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const cur = fs.readFileSync(file, 'utf8');
    if (/token:\s*"PUT_YOUR_BOT_TOKEN_HERE"/.test(cur)) {
      fs.writeFileSync(file, importEnv(cur), 'utf8');
      try { fs.renameSync(envFile, path.join(ROOT, '.env.old')); } catch { /* read-only folder */ }
      console.log('[config] values imported from .env into config.yml (.env renamed to .env.old)');
    }
  }
  const defaults = normalize(miniYaml.parse(templateText));
  let user;
  try {
    user = normalize(parseYaml(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    throw new Error(`config.yml is invalid: ${e.message}`);
  }
  let cfg = merge(defaults, user);
  if (opts.overrides) cfg = merge(cfg, normalize(opts.overrides));
  cfg = JSON.parse(JSON.stringify(cfg));
  const warnings = validate(cfg);
  cfg.__file = file;
  cfg.__root = ROOT;
  cfg.__warnings = warnings;
  cached = deepFreeze(cfg);
  return cached;
}

function resolvePath(p) { return path.isAbsolute(p) ? p : path.join(ROOT, p); }

module.exports = { load, resolvePath, ROOT, get: () => cached || load() };

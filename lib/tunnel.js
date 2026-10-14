'use strict';
/**
 * lib/tunnel.js — Cloudflare tunnels driven by config.yml
 *   cloudflare.tunnel.enabled        → "cloudflared tunnel run <name>" (your own domain)
 *   cloudflare.quick_tunnel.enabled  → "cloudflared tunnel --url http://host:port" (free trycloudflare.com URL)
 * The cloudflared binary is searched in ./cloudflared (per OS/arch names) and then in PATH.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const log = require('./log').scope('tunnel');

const ROOT = path.resolve(__dirname, '..');
const CF_DIR = path.join(ROOT, 'cloudflared');
const children = new Set();
let quickUrl = null;

function findBinary() {
  const names = {
    win32: { x64: 'cloudflared-windows-amd64.exe', ia32: 'cloudflared-windows-386.exe', arm64: 'cloudflared-windows-arm64.exe' },
    linux: { x64: 'cloudflared-linux-amd64', arm64: 'cloudflared-linux-arm64', ia32: 'cloudflared-linux-386', arm: 'cloudflared-linux-arm' },
    darwin: { x64: 'cloudflared-darwin-amd64', arm64: 'cloudflared-darwin-arm64' }
  };
  const list = [];
  const n = names[process.platform] && names[process.platform][process.arch];
  if (n) list.push(path.join(CF_DIR, n));
  list.push(path.join(CF_DIR, 'cloudflared.exe'), path.join(CF_DIR, 'cloudflared'));
  for (const p of list) {
    if (fs.existsSync(p)) { if (process.platform !== 'win32') { try { fs.chmodSync(p, 0o755); } catch {} } return p; }
  }
  return 'cloudflared'; // PATH
}

function findCredentials(rel) {
  const tries = [];
  if (rel) tries.push(path.isAbsolute(rel) ? rel : path.join(ROOT, rel), path.join(CF_DIR, path.basename(rel)), path.join(os.homedir(), '.cloudflared', path.basename(rel)));
  for (const p of tries) if (fs.existsSync(p)) return p;
  for (const dir of [CF_DIR, path.join(os.homedir(), '.cloudflared')]) {
    try { const f = fs.readdirSync(dir).find((x) => x.endsWith('.json')); if (f) return path.join(dir, f); } catch {}
  }
  return null;
}

/** Writes ./cloudflared/config.yml (only if missing) so "tunnel run" finds the ingress rules. */
function ensureTunnelConfig(t, port) {
  fs.mkdirSync(CF_DIR, { recursive: true });
  const cfgPath = path.join(CF_DIR, 'config.yml');
  const creds = findCredentials(t.credentials);
  if (!fs.existsSync(cfgPath)) {
    const lines = [`tunnel: ${t.name}`];
    if (creds) lines.push(`credentials-file: ${creds.replace(/\\/g, '/')}`);
    if (fs.existsSync(path.join(CF_DIR, 'cert.pem'))) lines.push('origincert: ./cert.pem');
    lines.push('', 'ingress:');
    if (t.hostname) lines.push(`  - hostname: ${t.hostname}`, `    service: http://localhost:${port}`);
    lines.push('  - service: http_status:404', '');
    fs.writeFileSync(cfgPath, lines.join('\n'));
    log.info(`wrote ${path.relative(ROOT, cfgPath)}`);
  }
  if (!creds) log.warn('no tunnel credentials JSON found in ./cloudflared or ~/.cloudflared');
  return cfgPath;
}

function run(args, { cwd = CF_DIR, onLine, readyRe, waitMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(findBinary(), args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { return reject(e); }
    children.add(child);
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => finish({ child, ready: false }), waitMs);
    const feed = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        log.debug(line);
        const r = onLine && onLine(line);
        if (r || (readyRe && readyRe.test(line))) finish({ child, ready: true, value: r });
      }
    };
    child.stdout.on('data', feed); child.stderr.on('data', feed);
    child.on('error', (e) => { children.delete(child); if (!done) { done = true; clearTimeout(timer); reject(e); } else log.warn('cloudflared error:', e.message); });
    child.on('exit', (code) => { children.delete(child); if (!done) { done = true; clearTimeout(timer); reject(new Error(`cloudflared exited (code ${code})`)); } else log.warn(`cloudflared exited (code ${code})`); });
  });
}

async function startNamed(t, port) {
  const cfgPath = ensureTunnelConfig(t, port);
  const r = await run(['tunnel', '--config', cfgPath, 'run', t.name], { readyRe: /Registered tunnel connection|Connection .* registered/i, waitMs: 20000 });
  log.info(`named tunnel "${t.name}" ${r.ready ? 'connected' : 'started'}${t.hostname ? ' → https://' + t.hostname : ''}`);
  return r;
}

async function startQuick(q, port) {
  const target = `http://${q.local_host || '127.0.0.1'}:${port}`;
  const r = await run(['tunnel', '--no-autoupdate', '--url', target], {
    onLine: (line) => { const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i); return m ? m[0] : null; },
    waitMs: 25000
  });
  quickUrl = r.value || null;
  log.info(quickUrl ? `quick tunnel → ${quickUrl}` : 'quick tunnel started (URL not captured yet)');
  return r;
}

async function start(cfg) {
  const cf = cfg.cloudflare || {};
  const port = cfg.api.port;
  const out = {};
  if (cf.tunnel && cf.tunnel.enabled) {
    try { out.named = await startNamed(cf.tunnel, port); } catch (e) { log.warn('named tunnel failed:', e.message, '(put cloudflared in ./cloudflared or install it)'); }
  }
  if (cf.quick_tunnel && cf.quick_tunnel.enabled) {
    try { out.quick = await startQuick(cf.quick_tunnel, port); } catch (e) { log.warn('quick tunnel failed:', e.message); }
  }
  return out;
}

function stop() { for (const c of children) { try { c.kill(); } catch {} } children.clear(); }

module.exports = { start, stop, getQuickUrl: () => quickUrl, CF_DIR };

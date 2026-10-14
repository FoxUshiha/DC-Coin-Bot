'use strict';
/**
 * bot.js — Coin Bank Discord bot.
 *
 *  • commands from ./commands registered ONLY globally (work in servers and DMs); every
 *    per-guild copy is deleted once per guild (old versions registered them per guild)
 *  • every slash command / button / modal is acknowledged immediately (deferReply →
 *    "Bot is thinking…"), the work runs asynchronously and the answer replaces it:
 *    no "The application did not respond" / "Interaction failed"
 *  • the same commands work as "@Bot command args" (and plain "command args" in DMs),
 *    with English and Portuguese aliases
 *  • API text protocol kept for other bots: active / verify / bill / paybill
 *  • all replies are embeds with the bot avatar as thumbnail
 *  • minimal discord.js caches + sweepers (low RAM with thousands of guilds)
 *  • DM queue (logic.js) is attached while the bot is online and paused when it is not
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logic = require('./logic');
const money = require('./lib/money');
const i18n = require('./lib/i18n');
const ui = require('./lib/botui');
const log = require('./lib/log').scope('bot');

let D = null;            // discord.js module
let client = null;
let cfg = null;
let online = false;
const commands = new Map();   // name → module
const aliasMap = new Map();   // alias → { cmd, lang }
const mentionCooldown = new Map();
let ephemeralFlag = 64;

/* ═══════════════════════════════ COMMAND CONTEXT ═══════════════════════════════ */
const PT_LOCALE = /^pt/i;

function guildLang(guildId) {
  if (!guildId) return null;
  const g = logic.getGuild(guildId);
  return g && (g.lang === 'pt' || g.lang === 'en') ? g.lang : null;
}

class Ctx {
  constructor({ interaction, message, args, cmd, lang }) {
    this.i = interaction || null;
    this.m = message || null;
    this.args = args || [];
    this.cmd = cmd || null;
    this.client = client;
    this.cfg = cfg;
    this.isSlash = !!(interaction && interaction.isChatInputCommand && interaction.isChatInputCommand());
    this.lang = lang || this.detectLang();
    this.avatar = client && client.user ? client.user.displayAvatarURL({ extension: 'png', size: 128 }) : null;
    this._text = null;
    this.replied = false;
  }
  detectLang() {
    const gl = guildLang(this.guildId);
    if (gl) return gl;
    if (this.i) return PT_LOCALE.test(this.i.locale || '') ? 'pt' : 'en';
    const g = this.m && this.m.guild;
    return g && PT_LOCALE.test(g.preferredLocale || '') ? 'pt' : 'en';
  }
  get user() { return this.i ? this.i.user : this.m.author; }
  get userId() { return this.user.id; }
  get guild() { return this.i ? this.i.guild : this.m.guild; }
  get guildId() { return this.i ? this.i.guildId : this.m.guildId; }
  get channel() { return this.i ? this.i.channel : this.m.channel; }
  get member() { return this.i ? this.i.member : this.m.member; }
  get inDM() { return !this.guildId; }
  l(en, pt) { return this.lang === 'pt' ? pt : en; }

  // ── permissions
  isOwner() { return logic.isOwner(this.userId); }
  isStaff() { return logic.isStaff(this.userId); }
  isGuildAdmin() {
    if (!this.guildId) return false;
    if (this.guild && this.guild.ownerId === this.userId) return true;
    const P = D.PermissionFlagsBits;
    const perms = this.i ? this.i.memberPermissions : (this.member && this.member.permissions);
    try { return !!perms && (perms.has(P.Administrator) || perms.has(P.ManageGuild)); } catch { return false; }
  }
  can(perm) {
    if (perm === 'owner') return this.isOwner();
    if (perm === 'staff') return this.isStaff();
    if (perm === 'guildAdmin') return this.isStaff() || this.isGuildAdmin();
    return true;
  }

  // ── options (slash + text share the same names)
  textOptions() {
    if (this._text) return this._text;
    const out = {};
    const order = (this.cmd && (this.cmd.textArgs || (this.cmd.options || []).map((o) => o.name))) || [];
    const defs = new Map(((this.cmd && this.cmd.options) || []).map((o) => [o.name, o]));
    let i = 0;
    for (let k = 0; k < order.length && i < this.args.length; k++) {
      const name = order[k]; const def = defs.get(name) || {};
      if (def.rest || (k === order.length - 1 && def.type === 'string' && def.restIfLast)) { out[name] = this.args.slice(i).join(' '); i = this.args.length; break; }
      out[name] = this.args[i++];
    }
    return (this._text = out);
  }
  raw(name) {
    if (this.isSlash) { const o = this.i.options.get(name); return o ? o.value : null; }
    const v = this.textOptions()[name];
    return v === undefined ? null : v;
  }
  str(name) { const v = this.raw(name); return v === null || v === undefined ? null : String(v).trim(); }
  int(name) { const v = this.raw(name); const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
  /** user-type option → user id (accepts mentions and raw ids in text mode) */
  targetId(name) { return logic.cleanId(this.raw(name)); }
  async userObj(name) {
    const id = this.targetId(name);
    if (!id) return null;
    if (this.isSlash) { const u = this.i.options.getUser(name); if (u) return u; }
    if (this.m) { const u = this.m.mentions.users.get(id); if (u) return u; }
    try { return await client.users.fetch(id); } catch { return null; }
  }
  async channelObj(name) {
    if (this.isSlash) { const c = this.i.options.getChannel(name); if (c) return client.channels.cache.get(c.id) || c; }
    const raw = this.str(name); if (!raw) return null;
    const id = (raw.match(/^<#(\d+)>$/) || [])[1] || (/^\d{5,32}$/.test(raw) ? raw : null);
    if (!id) return null;
    try { return await client.channels.fetch(id); } catch { return null; }
  }

  // ── replies (always embeds)
  embed(o) { return ui.embed(this, o); }
  async send(payload) {
    payload = { allowedMentions: { parse: [], repliedUser: false }, ...payload };
    try {
      if (this.i) {
        if (this.i.deferred || this.i.replied) return await this.i.editReply(payload);
        return await this.i.reply(payload);
      }
      this.replied = true;
      return await this.m.reply(payload);
    } catch (e) {
      if (this.m && (e.code === 50013 || e.code === 50001)) {
        try { await this.m.channel.send({ content: i18n.errorText(this.lang, { code: 'BOT_NO_PERMS' }, logic.fmtDuration).replace(/\*\*/g, '') }); } catch { /* channel closed for us */ }
      } else if (e.code !== 10062 && e.code !== 10008) log.debug('reply failed:', e.message);
    }
    return null;
  }
  async followUp(payload) {
    payload = { allowedMentions: { parse: [] }, ...payload };
    try {
      if (this.i) return await this.i.followUp({ flags: ephemeralFlag, ...payload });
      return await this.m.channel.send(payload);
    } catch (e) { log.debug('followUp failed:', e.message); return null; }
  }
  /** Sends sensitive content privately: ephemeral for slash, DM for public text commands. */
  async sendPrivate(payload) {
    if (this.i || this.inDM) return this.send(payload);
    try {
      await this.user.send({ allowedMentions: { parse: [] }, ...payload });
      return this.send({ embeds: [this.embed({ title: this.l('📬 Check your DMs', '📬 Veja seu privado'), description: this.l('I sent it to you privately for security.', 'Enviei no seu privado por segurança.'), color: ui.COLORS.info })] });
    } catch {
      return this.send({ embeds: [ui.errEmbed(this, this.l('I could not DM you. Open your DMs or use the slash command (private reply).', 'Não consegui te enviar DM. Abra seu privado ou use o comando com barra (resposta privada).'))] });
    }
  }
  ok(title, description, extra) { return this.send({ embeds: [ui.okEmbed(this, title, description, extra)], ...(extra && extra.components ? { components: extra.components } : {}) }); }
  info(title, description, extra = {}) { return this.send({ embeds: [this.embed({ title, description, color: ui.COLORS.info, ...extra })] }); }
  fail(description, title) { return this.send({ embeds: [ui.errEmbed(this, description, title)] }); }
  error(e) { return this.send({ embeds: [ui.errorFor(this, e)] }); }
  async showModal(modal) {
    if (this.i && !this.i.deferred && !this.i.replied && this.i.showModal) return this.i.showModal(modal);
    // text command → modals need an interaction: offer a button that opens it
    return this.send({
      embeds: [this.embed({ title: modal.title, description: this.l('Click the button below to open the form.', 'Clique no botão abaixo para abrir o formulário.'), color: ui.COLORS.info })],
      components: [ui.row(ui.btn(`cb:open:${modal.custom_id.split(':').pop()}`, this.l('Open form', 'Abrir formulário'), 1, '📝'))]
    });
  }
}

/* ═══════════════════════════════ COMMAND LOADING / REGISTRATION ═══════════════════════════════ */
const OPT_TYPES = { string: 3, integer: 4, boolean: 5, user: 6, channel: 7, number: 10 };

function loadCommands() {
  commands.clear(); aliasMap.clear();
  const dir = path.join(__dirname, 'commands');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && !x.startsWith('_')).sort()) {
    try {
      const file = path.join(dir, f);
      delete require.cache[require.resolve(file)];
      const c = require(file);
      if (!c || !c.name || typeof c.run !== 'function') { log.warn(`commands/${f}: invalid module (needs name + run)`); continue; }
      commands.set(c.name, c);
      aliasMap.set(c.name, { cmd: c, lang: c.lang || null });
      for (const a of (c.aliases && c.aliases.en) || []) aliasMap.set(a.toLowerCase(), { cmd: c, lang: 'en' });
      for (const a of (c.aliases && c.aliases.pt) || []) aliasMap.set(a.toLowerCase(), { cmd: c, lang: 'pt' });
      if (c.names && c.names.pt) aliasMap.set(c.names.pt.toLowerCase(), { cmd: c, lang: 'pt' });
    } catch (e) { log.error(`failed to load commands/${f}:`, e); }
  }
  log.info(`${commands.size} commands loaded`);
}

function commandJSON(c) {
  const contexts = c.guildOnly ? [0] : (cfg.discord.user_install ? [0, 1, 2] : [0, 1]);
  const integration_types = cfg.discord.user_install && !c.guildOnly ? [0, 1] : [0];
  const loc = (o) => (o && o.pt ? { 'pt-BR': o.pt } : undefined);
  const json = {
    name: c.name, type: 1,
    description: (c.description && c.description.en || c.name).slice(0, 100),
    description_localizations: c.description && c.description.pt ? { 'pt-BR': c.description.pt.slice(0, 100) } : undefined,
    name_localizations: c.names && c.names.pt ? { 'pt-BR': c.names.pt } : undefined,
    contexts, integration_types,
    options: (c.options || []).map((o) => {
      const opt = {
        type: OPT_TYPES[o.type] || 3, name: o.name, name_localizations: loc(o.names),
        description: (o.description && o.description.en || o.name).slice(0, 100),
        description_localizations: o.description && o.description.pt ? { 'pt-BR': o.description.pt.slice(0, 100) } : undefined,
        required: !!o.required
      };
      if (o.choices) opt.choices = o.choices.map((ch) => ({ name: ch.name.en || ch.name, name_localizations: ch.name.pt ? { 'pt-BR': ch.name.pt } : undefined, value: ch.value }));
      if (o.type === 'channel') opt.channel_types = o.channelTypes || [0, 5];
      if (o.min !== undefined) opt.min_value = o.min;
      if (o.max !== undefined) opt.max_value = o.max;
      if (o.maxLength) opt.max_length = o.maxLength;
      return opt;
    })
  };
  return JSON.parse(JSON.stringify(json)); // drop undefined
}

async function registerCommands() {
  const appId = (client.application && client.application.id) || cfg.discord.client_id;
  const body = [...commands.values()].filter((c) => !c.textOnly).map(commandJSON);
  const hash = crypto.createHash('sha256').update(appId + JSON.stringify(body)).digest('hex');
  const [oldHash, oldTs] = String(logic.meta.get('commands_hash') || '').split(':');
  if (oldHash === hash && Date.now() - Number(oldTs || 0) < 24 * 3600e3) { log.info(`global commands up to date (${body.length})`); return; }
  await client.rest.put(D.Routes.applicationCommands(appId), { body });
  await logic.meta.set('commands_hash', `${hash}:${Date.now()}`);
  log.info(`registered ${body.length} GLOBAL commands (servers + DMs)`);
}

/** Deletes old per-guild command copies (once per guild, remembered in the database). */
async function purgeGuildCommands(guildIds) {
  if (!cfg.discord.purge_guild_commands) return;
  const appId = (client.application && client.application.id) || cfg.discord.client_id;
  const done = logic.purgedGuildIds();
  const todo = guildIds.filter((id) => !done.has(id));
  if (!todo.length) return;
  log.info(`removing per-guild commands from ${todo.length} guild(s) in background…`);
  let n = 0;
  for (const gid of todo) {
    if (!online) break;
    try { await client.rest.put(D.Routes.applicationGuildCommands(appId, gid), { body: [] }); n++; }
    catch (e) { if (![50001, 10004, 403].includes(e.code) && e.status !== 403) log.debug(`purge ${gid}:`, e.message); }
    await logic.setGuild(gid, { cmds_purged: 1 });
    await new Promise((r) => setTimeout(r, 250));
  }
  log.info(`per-guild commands cleaned in ${n} guild(s)`);
}

/* ═══════════════════════════════ RUNNING COMMANDS ═══════════════════════════════ */
async function guard(ctx, cmd) {
  if (cmd.guildOnly && ctx.inDM) { await ctx.fail(i18n.errorText(ctx.lang, { code: 'GUILD_ONLY' }, logic.fmtDuration)); return false; }
  if (!ctx.can(cmd.perm || 'everyone')) { await ctx.fail(i18n.errorText(ctx.lang, { code: 'NO_PERMISSION' }, logic.fmtDuration)); return false; }
  return true;
}

async function execute(ctx, cmd) {
  try {
    if (!(await guard(ctx, cmd))) return;
    await cmd.run(ctx, { ui, logic, money, D });
  } catch (e) {
    const known = e && e.code && (i18n.ERRORS[e.code] || String(e.code).startsWith('Block:'));
    if (!known) log.error(`command ${cmd.name} failed:`, e);
    await ctx.error(known ? e : { code: 'GENERIC' });
  }
}

async function onSlash(i) {
  const cmd = commands.get(i.commandName);
  if (!cmd) return;
  const forced = cmd.lang || null;
  const ctx = new Ctx({ interaction: i, cmd, lang: forced || undefined });
  const wantsModal = typeof cmd.modal === 'function' ? cmd.modal(ctx) : !!cmd.modal;
  if (!wantsModal) {
    try { await i.deferReply(cmd.ephemeral === false ? {} : { flags: ephemeralFlag }); }
    catch (e) { log.debug('defer failed:', e.message); return; }
  }
  await execute(ctx, cmd);
}

/* ═══════════════════════════════ BUTTONS & MODALS ═══════════════════════════════ */
async function deferEphemeral(i) { try { await i.deferReply({ flags: ephemeralFlag }); return true; } catch { return false; } }

async function onButton(i) {
  const id = i.customId;
  const ctx = new Ctx({ interaction: i });
  // legacy ids from messages posted by the old bot keep working
  const legacy = { resgatar: 'cb:claim', atm_balance: 'cb:bal', atm_transfer: 'cb:transfer', user_register_button: 'cb:open:user' };
  const cid = legacy[id] || id;
  const parts = cid.split(':');
  if (parts[0] !== 'cb') return;
  const act = parts[1];
  try {
    switch (act) {
      case 'claim': {
        if (!(await deferEphemeral(i))) return;
        try { await ctx.send(ui.claimPayload(ctx, await logic.claim(ctx.userId, { source: 'discord' }))); } catch (e) { await ctx.error(e); }
        return;
      }
      case 'bal': {
        if (!(await deferEphemeral(i))) return;
        return ctx.send({ embeds: [ui.balanceEmbed(ctx, ctx.userId, i.user.username)] });
      }
      case 'card': {
        if (!(await deferEphemeral(i))) return;
        const code = await logic.getCard(ctx.userId);
        return ctx.send({ embeds: [ctx.embed({ title: ctx.l('💳 Your Coin Card', '💳 Seu Coin Card'), description: `||\`${code}\`||\n\n${ctx.l('Never share it: it moves your coins through the API.', 'Nunca compartilhe: ele movimenta seus coins pela API.')}`, color: ui.COLORS.purple })] });
      }
      case 'transfer': return i.showModal(ui.modals.transfer(ctx.lang));
      case 'open': {
        const m = ui.modals[parts[2]];
        if (m) return i.showModal(m(ctx.lang));
        return;
      }
      case 'rank': case 'bills': {
        const page = Math.max(1, parseInt(parts[2], 10) || 1), owner = parts[3];
        if (owner && owner !== ctx.userId) {
          if (!(await deferEphemeral(i))) return;
          return ctx.send(act === 'rank' ? ui.rankPayload(ctx, page) : { embeds: [ui.errEmbed(ctx, ctx.l('Use the command yourself to browse.', 'Use o comando você mesmo para navegar.'))] });
        }
        try { await i.deferUpdate(); } catch { return; }
        return i.editReply(act === 'rank' ? ui.rankPayload(ctx, page) : ui.billsPayload(ctx, page)).catch(() => {});
      }
      case 'hist': {
        const target = parts[2], page = Math.max(1, parseInt(parts[3], 10) || 1), owner = parts[4];
        if (owner && owner !== ctx.userId) { if (!(await deferEphemeral(i))) return; return ctx.send(ui.historyPayload(ctx, target, page)); }
        try { await i.deferUpdate(); } catch { return; }
        return i.editReply(ui.historyPayload(ctx, target, page)).catch(() => {});
      }
      case 'hcsv': {
        if (!(await deferEphemeral(i))) return;
        const target = logic.cleanId(parts[2]);
        if (!target) return ctx.error({ code: 'UNKNOWN_USER' });
        return ctx.send({ embeds: [ctx.embed({ title: ctx.l('📄 Statement export', '📄 Exportação do extrato'), description: `ID ${ui.code(target)}`, color: ui.COLORS.info })], files: [{ attachment: ui.historyCsv(target), name: `statement-${target}.csv` }] });
      }
      case 'rcpt': {
        if (!(await deferEphemeral(i))) return;
        const fmt = parts[2] === 'pdf' ? 'pdf' : 'png';
        const txId = parts.slice(3).join(':');
        try {
          const buf = await logic.receipt(txId, { lang: ctx.lang, format: fmt });
          const name = `receipt-${txId}.${fmt}`;
          const e = ctx.embed({ title: ctx.l('🧾 Receipt', '🧾 Comprovante'), description: ui.code(txId), color: ui.COLORS.ok });
          if (fmt === 'png') e.image = { url: `attachment://${name}` };
          return ctx.send({ embeds: [e], files: [{ attachment: buf, name }] });
        } catch (e) { return ctx.error(e); }
      }
      case 'graph': {
        if (!(await deferEphemeral(i))) return;
        const fmt = parts[2] === 'pdf' ? 'pdf' : 'png', target = logic.cleanId(parts[3]) || ctx.userId, days = Math.max(2, Math.min(365, parseInt(parts[4], 10) || 30));
        if (target !== ctx.userId && !ctx.isStaff()) return ctx.error({ code: 'NO_PERMISSION' });
        try {
          const buf = await logic.userChart(target, { days, lang: ctx.lang, format: fmt, name: i.user.username });
          return ctx.send({ embeds: [ctx.embed({ title: ctx.l('📊 Balance chart', '📊 Gráfico de saldo'), description: ctx.l(`Last ${days} days`, `Últimos ${days} dias`), color: ui.COLORS.info })], files: [{ attachment: buf, name: `balance-${target}.${fmt}` }] });
        } catch (e) { return ctx.error(e); }
      }
      case 'prpay': {
        const r = logic.getPayRequest(parts[2]);
        if (!r) { if (!(await deferEphemeral(i))) return; return ctx.error({ code: 'PAYREQ_NOT_FOUND' }); }
        if (r.status !== 'open') { if (!(await deferEphemeral(i))) return; return ctx.error({ code: r.status === 'paid' ? 'PAYREQ_PAID' : r.status === 'cancelled' ? 'PAYREQ_CANCELLED' : 'PAYREQ_EXPIRED' }); }
        return i.showModal(ui.modals.prpay(ctx.lang, r));
      }
      case 'prstat': case 'prcancel': {
        const id = parts[2];
        let r = logic.getPayRequest(id);
        if (!r) { if (!(await deferEphemeral(i))) return; return ctx.error({ code: 'PAYREQ_NOT_FOUND' }); }
        if (act === 'prcancel') {
          if (r.to !== ctx.userId) { if (!(await deferEphemeral(i))) return; return ctx.error({ code: 'NO_PERMISSION' }); }
          try { r = (await logic.cancelPayRequest(ctx.userId, id)).request; } catch (e) { if (!(await deferEphemeral(i))) return; return ctx.error(e); }
        }
        try { await i.deferUpdate(); } catch { return; }
        const p = await ui.payRequestPayload(ctx, r);
        if (!p.files) p.files = []; p.attachments = [];
        return i.editReply(p).catch(() => {});
      }
      case 'noop': return i.deferUpdate().catch(() => {});
      default: return;
    }
  } catch (e) {
    log.error('button failed:', e);
    try { if (i.deferred || i.replied) await ctx.error({ code: 'GENERIC' }); else await i.reply({ embeds: [ui.errorFor(ctx, { code: 'GENERIC' })], flags: ephemeralFlag }); } catch {}
  }
}

async function onModal(i) {
  const legacy = { bill_modal: 'cb:m:bill', paybill_modal: 'cb:m:paybill', user_modal: 'cb:m:user', atm_modal_transfer: 'cb:m:transfer' };
  const cid = legacy[i.customId] || i.customId;
  if (!cid.startsWith('cb:m:')) return;
  const sub = cid.slice(5).split(':');
  if (!(await deferEphemeral(i))) return;
  const ctx = new Ctx({ interaction: i });
  const field = (n) => { try { return (i.fields.getTextInputValue(n) || '').trim(); } catch { return ''; } };
  try {
    switch (sub[0]) {
      case 'prpay': {
        const r = await logic.payPayRequest(ctx.userId, sub[1], { amount: field('amount'), source: 'discord' });
        return ctx.send(await ui.receiptPayload(ctx, r.txId, { title: ctx.l('✅ QR payment sent', '✅ Pagamento por QR enviado'), description: `${ui.coins(r.amountSats, ctx.lang)} → ${ui.code(r.to)}${r.request.memo ? `\n> ${r.request.memo}` : ''}` }));
      }
      case 'transfer': {
        const to = logic.cleanId(field('userId'));
        if (!to) return ctx.error({ code: 'INVALID_TARGET' });
        const r = await logic.transfer(ctx.userId, to, field('valor'), { source: 'discord' });
        return ctx.send(await ui.receiptPayload(ctx, r.txId, { title: ctx.l('✅ Transfer sent', '✅ Transferência enviada'), description: `${ui.coins(r.amountSats, ctx.lang)} → ${ui.code(to)}` }));
      }
      case 'bill': {
        const to = field('toId') || ctx.userId;
        const r = await logic.createBill({ fromId: field('fromId') || null, toId: to, amount: field('amount'), time: field('time') || undefined });
        return ctx.send(billCreatedPayload(ctx, r));
      }
      case 'paybill': {
        const r = await logic.payBill(ctx.userId, field('billId'), { source: 'discord' });
        if (r.self) return ctx.ok(ctx.l('🏦 Bill closed', '🏦 Cobrança encerrada'), ctx.l(`You closed your own bill ${ui.code(r.billId)} — no coins moved.`, `Você encerrou sua própria cobrança ${ui.code(r.billId)} — nenhum coin foi movido.`));
        return ctx.send(await ui.receiptPayload(ctx, r.txId, { title: ctx.l('✅ Bill paid', '✅ Cobrança paga'), description: `${ui.coins(r.amountSats, ctx.lang)} → ${ui.code(r.toId)}` }));
      }
      case 'user': {
        const pw = field('password');
        if (pw !== field('confirm_password')) return ctx.fail(ctx.l('⚠️ The passwords do not match.', '⚠️ As senhas não conferem.'));
        const r = await logic.setDiscordCredentials(ctx.userId, field('username'), pw);
        return ctx.ok(r.created ? ctx.l('✅ Account created', '✅ Conta criada') : ctx.l('✅ Account updated', '✅ Conta atualizada'),
          ctx.l(`You can now log in on the website with **${field('username')}**.\nYour account ID: ${ui.code(ctx.userId)}`, `Agora você pode entrar no site com **${field('username')}**.\nID da sua conta: ${ui.code(ctx.userId)}`),
          { components: cfg.discord.links.website ? [ui.row(ui.linkBtn(cfg.discord.links.website, 'Coin Bank', '🌐'))] : undefined });
      }
      default: return;
    }
  } catch (e) {
    const known = e && e.code && (i18n.ERRORS[e.code] || String(e.code).startsWith('Block:'));
    if (!known) log.error('modal failed:', e);
    return ctx.error(known ? e : { code: 'GENERIC' });
  }
}

function billCreatedPayload(ctx, r) {
  return {
    embeds: [ui.okEmbed(ctx, ctx.l('🧾 Bill created', '🧾 Cobrança criada'), `${ui.coins(r.amountSats, ctx.lang)}\n\`\`\`${r.billId}\`\`\``, {
      fields: [
        { name: ctx.l('📤 Payer', '📤 Pagador'), value: r.from ? ui.code(r.from) : ctx.l('Anyone', 'Qualquer um'), inline: true },
        { name: ctx.l('📥 Receiver', '📥 Recebedor'), value: ui.code(r.to), inline: true },
        { name: ctx.l('⌛ Expires', '⌛ Expira'), value: `<t:${Math.floor(r.expiresAt / 1000)}:R>`, inline: true },
        { name: ctx.l('💡 How to pay', '💡 Como pagar'), value: `\`/paybill ${r.billId}\`` }
      ]
    })]
  };
}

/* ═══════════════════════════════ @MENTION / DM TEXT COMMANDS ═══════════════════════════════ */
function tokenize(s) {
  const out = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(s)) && out.length < 32) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

/** Machine protocol used by other bots/plugins in API channels (raw token kept in content). */
const protocol = {
  async active(msg, a, lang) {
    const [hash, targetId, amount] = a;
    const owner = /^[a-f0-9]{64}$/i.test(hash || '') ? logic.cardOwnerByHash(hash) : null;
    if (!owner || !logic.cleanId(targetId)) return protoReply(msg, `${owner || '000000000000'}:false`, false, lang);
    try { const r = await logic.transfer(owner, targetId, amount, { source: 'discord-api' }); return protoReply(msg, `${owner}:true`, true, lang, r.txId); }
    catch { return protoReply(msg, `${owner}:false`, false, lang); }
  },
  async verify(msg, a, lang) {
    const id = a[0];
    if (!id) return protoReply(msg, ':false', false, lang);
    return protoReply(msg, `${id}:${logic.verifyId(id)}`, logic.verifyId(id), lang);
  },
  async bill(msg, a, lang) {
    const [fromId, toId, amount, time] = a;
    try { const r = await logic.createBill({ fromId, toId, amount, time }); return protoReply(msg, `${fromId}:${r.billId}`, true, lang, null, r.billId); }
    catch (e) { return protoReply(msg, `${fromId || ''}:false`, false, lang, null, null, e); }
  },
  async paybill(msg, a, lang) {
    const billId = a[0];
    try { const r = await logic.payBill(msg.author.id, billId, { source: 'discord-api' }); return protoReply(msg, `${billId}:true`, true, lang, r.txId); }
    catch (e) { return protoReply(msg, `${billId}:false`, false, lang, null, null, e); }
  }
};
async function protoReply(msg, token, ok, lang, txId, billId, e) {
  const ctx = new Ctx({ message: msg, lang });
  const emb = ctx.embed({
    title: ok ? ctx.l('✅ API operation confirmed', '✅ Operação da API confirmada') : ctx.l('❌ API operation refused', '❌ Operação da API recusada'),
    description: '```' + token + '```' + (e ? '\n' + i18n.errorText(lang, e, logic.fmtDuration) : ''),
    color: ok ? ui.COLORS.ok : ui.COLORS.err,
    fields: [txId ? { name: ctx.l('🆔 Transaction', '🆔 Transação'), value: ui.code(txId) } : null, billId ? { name: ctx.l('🧾 Bill', '🧾 Cobrança'), value: ui.code(billId) } : null].filter(Boolean)
  });
  const payload = { embeds: [emb], allowedMentions: { parse: [], repliedUser: false } };
  if (cfg.discord.api_raw_token) payload.content = token;
  try { await msg.reply(payload); } catch (err) { log.debug('protocol reply failed:', err.message); }
}

async function onMessage(msg) {
  if (!online || !msg.content || msg.author.id === (client.user && client.user.id)) return;
  const fromBot = !!(msg.author.bot || msg.webhookId);
  const me = client.user.id;
  let body;
  const c = msg.content;
  if (c.startsWith(`<@${me}>`)) body = c.slice(me.length + 3);
  else if (c.startsWith(`<@!${me}>`)) body = c.slice(me.length + 4);
  else if (!msg.guildId) body = c;
  else return;
  const tokens = tokenize(body.trim());
  const mentioned = msg.guildId || c.startsWith('<@');
  if (fromBot) {
    // other bots / plugins may only use the machine protocol
    const verb = (tokens[0] || '').toLowerCase();
    if (!protocol[verb]) return;
  }
  if (!tokens.length) {
    if (!mentioned) return;
    const helpCmd = commands.get('help');
    if (helpCmd) return execute(new Ctx({ message: msg, cmd: helpCmd }), helpCmd);
    return;
  }
  const name = tokens.shift().toLowerCase().replace(/^[!/.]/, '');
  const entry = aliasMap.get(name);
  const lang = (entry && entry.lang) || guildLang(msg.guildId) || (msg.guild && PT_LOCALE.test(msg.guild.preferredLocale || '') ? 'pt' : null) || 'en';
  const isProto = protocol[name] && (name === 'active' || name === 'verify' || (name === 'bill' && tokens.length >= 3) || (name === 'paybill' && tokens.length >= 1));
  if (!isProto) {
    // anti-spam for human commands (the machine protocol is rate-limited by the money rules)
    const now = Date.now(); const last = mentionCooldown.get(msg.author.id) || 0;
    if (now - last < cfg.discord.mention_cooldown_ms) return;
    mentionCooldown.set(msg.author.id, now);
    if (mentionCooldown.size > 50000) { const cut = now - 60000; for (const [k, v] of mentionCooldown) if (v < cut) mentionCooldown.delete(k); }
  }
  if (isProto) {
    if (name === 'active') {
      // a card hash spends coins: only inside servers, and only in the configured API channel when one is set
      const g = msg.guildId ? logic.getGuild(msg.guildId) : null;
      if (!g || (g.api_channel && g.api_channel !== msg.channelId)) return protoReply(msg, '000000000000:false', false, lang, null, null, { code: 'NO_PERMISSION' });
    }
    return protocol[name](msg, tokens, lang);
  }
  if (fromBot) return;
  if (!entry) {
    if (!mentioned) return; // plain DM chatter: ignore
    const ctx = new Ctx({ message: msg, lang });
    return ctx.fail(ctx.l(`Unknown command \`${name.slice(0, 32)}\`. Use \`@${client.user.username} help\`.`, `Comando desconhecido \`${name.slice(0, 32)}\`. Use \`@${client.user.username} ajuda\`.`));
  }
  const cmd = entry.cmd;
  try { if (msg.channel && msg.channel.sendTyping) msg.channel.sendTyping().catch(() => {}); } catch {}
  const ctx = new Ctx({ message: msg, args: tokens, cmd, lang: cmd.lang || lang });
  return execute(ctx, cmd);
}

/* ═══════════════════════════════ GUILD EVENTS ═══════════════════════════════ */
async function onGuildCreate(guild) {
  log.info(`joined guild ${guild.name} (${guild.id}) — ${client.guilds.cache.size} guilds`);
  purgeGuildCommands([guild.id]).catch(() => {});
  if (!cfg.discord.guild_join_dm) return;
  const payload = i18n.guildJoinPayload(cfg.discord.links, client.user.username, ui.COLORS.primary, client.user.displayAvatarURL({ extension: 'png', size: 128 }));
  const targets = new Set();
  if (guild.ownerId) targets.add(guild.ownerId);
  try {
    const logs = await guild.fetchAuditLogs({ type: D.AuditLogEvent.BotAdd, limit: 3 });
    const entry = logs.entries.find((e) => e.target && e.target.id === client.user.id) || logs.entries.first();
    if (entry && entry.executor) targets.add(entry.executor.id);
  } catch { /* no audit log permission */ }
  for (const id of targets) logic.enqueueDM(id, payload);
}

async function onMemberAdd(member) {
  if (!cfg.discord.welcome_new_members || member.user.bot) return;
  if (logic.balance(member.id) > 0) return;
  const st = logic.claimStatus(member.id);
  const p = logic.dmEmbed({
    titleEn: '🎉 Welcome to Coin Bank!', titlePt: '🎉 Bem-vindo ao Coin Bank!', color: ui.COLORS.primary,
    en: [`Claim **${st.claimAmount}** coins every **${logic.fmtDuration(st.cooldownMs, 'en')}** with the button below or \`/claim\`.`, 'Send coins with `/pay` or `@Coin pay @user 0.00000001`.'],
    pt: [`Resgate **${st.claimAmount}** coins a cada **${logic.fmtDuration(st.cooldownMs, 'pt')}** com o botão abaixo ou \`/claim\`.`, 'Envie coins com `/pay` ou `@Coin pagar @usuário 0.00000001`.']
  });
  p.components = [ui.row(ui.btn('cb:claim', 'Claim · Resgatar', 3, '🎁'))];
  logic.enqueueDM(member.id, p);
}

/* ═══════════════════════════════ DM SENDER (used by logic's DM queue) ═══════════════════════════════ */
async function sendDM(userId, payload) {
  const user = await client.users.fetch(userId);
  const av = client.user.displayAvatarURL({ extension: 'png', size: 128 });
  const meta = payload._meta; delete payload._meta;
  for (const e of payload.embeds || []) { if (!e.thumbnail) e.thumbnail = { url: av }; if (e.footer && !e.footer.icon_url) e.footer.icon_url = av; }
  if (meta && meta.receipt && !payload.components) {
    payload.components = [ui.row(ui.btn(`cb:rcpt:png:${meta.receipt}`, 'PNG', 2, '🧾'), ui.btn(`cb:rcpt:pdf:${meta.receipt}`, 'PDF', 2, '📄'))];
  }
  payload.allowedMentions = { parse: [] };
  await user.send(payload);
}

/* ═══════════════════════════════ LIFECYCLE ═══════════════════════════════ */
function buildClient() {
  const { Client, GatewayIntentBits: I, Partials, Options } = D;
  const intents = [I.Guilds, I.DirectMessages];
  if (cfg.discord.mention_commands) intents.push(I.GuildMessages);
  if (cfg.discord.welcome_new_members) intents.push(I.GuildMembers);
  const keepSelf = (x) => client && client.user && x.id === client.user.id;
  return new Client({
    intents,
    partials: [Partials.Channel],
    allowedMentions: { parse: [], repliedUser: false },
    failIfNotExists: false,
    rest: { timeout: 15000, retries: 2 },
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0, DMMessageManager: 0, GuildMessageManager: 0,
      PresenceManager: 0, ReactionManager: 0, ReactionUserManager: 0, VoiceStateManager: 0, StageInstanceManager: 0,
      GuildEmojiManager: 0, BaseGuildEmojiManager: 0, GuildStickerManager: 0, GuildInviteManager: 0, GuildBanManager: 0,
      GuildScheduledEventManager: 0, AutoModerationRuleManager: 0, ApplicationCommandManager: 0, ThreadMemberManager: 0,
      GuildMemberManager: { maxSize: 1, keepOverLimit: keepSelf },
      UserManager: { maxSize: 500, keepOverLimit: keepSelf }
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      users: { interval: 900, filter: () => (u) => !keepSelf(u) },
      threads: { interval: 3600, lifetime: 3600 }
    }
  });
}

async function start(config) {
  cfg = config;
  if (!cfg.discord.enabled) { log.info('disabled in config.yml (discord.enabled: false) — DM queue stays off'); return null; }
  if (!cfg.discord.token || /PUT_YOUR/i.test(cfg.discord.token)) { log.warn('discord.token not set in config.yml — bot offline, DM queue paused (API keeps running)'); return null; }
  try { D = require('discord.js'); } catch (e) { log.error('discord.js is not installed (npm install). Bot offline.'); return null; }
  if (D.MessageFlags && D.MessageFlags.Ephemeral) ephemeralFlag = D.MessageFlags.Ephemeral;
  ui.setPrimary(cfg.discord.embed_color);
  loadCommands();
  client = buildClient();
  const READY = (D.Events && D.Events.ClientReady) || 'ready';

  client.once(READY, async () => {
    online = true;
    log.info(`online as ${client.user.tag} in ${client.guilds.cache.size} guild(s)`);
    try {
      const p = cfg.discord.presence || {};
      client.user.setPresence({ status: p.status || 'online', activities: p.activity ? [{ name: 'custom', state: String(p.activity).slice(0, 128), type: D.ActivityType.Custom }] : [] });
    } catch {}
    logic.attachDMSender(sendDM);
    try { await registerCommands(); } catch (e) { log.error('global command registration failed:', e.message); }
    purgeGuildCommands([...client.guilds.cache.keys()]).catch((e) => log.warn('guild purge failed:', e.message));
  });
  client.on('interactionCreate', (i) => {
    let p;
    if (i.isChatInputCommand()) p = onSlash(i);
    else if (i.isButton()) p = onButton(i);
    else if (i.isModalSubmit()) p = onModal(i);
    if (p) p.catch((e) => log.error('interaction failed:', e));
  });
  if (cfg.discord.mention_commands) client.on('messageCreate', (m) => { onMessage(m).catch((e) => log.error('message command failed:', e)); });
  client.on('guildCreate', (g) => { onGuildCreate(g).catch((e) => log.warn('guildCreate:', e.message)); });
  client.on('guildDelete', (g) => log.info(`removed from guild ${g.id} — ${client.guilds.cache.size} guilds`));
  if (cfg.discord.welcome_new_members) client.on('guildMemberAdd', (m) => { onMemberAdd(m).catch(() => {}); });
  client.on('shardDisconnect', () => { logic.detachDMSender(); });
  client.on('shardResume', () => { if (online) logic.attachDMSender(sendDM); });
  client.on('shardReady', () => { if (online) logic.attachDMSender(sendDM); });
  client.on('invalidated', () => { online = false; logic.detachDMSender(); log.error('session invalidated'); });
  client.on('error', (e) => log.error('client error:', e.message));
  client.on('warn', (w) => log.warn(w));

  try {
    require('./lib/memory').register('discord', {
      heavy: () => { try { if (client) client.sweepers.sweepUsers((u) => !keepSelfStatic(u)); } catch {} mentionCooldown.clear(); }
    });
  } catch {}

  const login = async (attempt = 1) => {
    try { await client.login(cfg.discord.token); }
    catch (e) {
      const fatal = /TokenInvalid|invalid token|disallowed intents|Used disallowed intents/i.test(e.message || e.code || '');
      log.error(`login failed: ${e.message}${fatal ? ' — check discord.token / enabled intents' : ''}`);
      if (!fatal && attempt < 20) setTimeout(() => login(attempt + 1), Math.min(300e3, 15e3 * attempt)).unref();
    }
  };
  login();
  return client;
}
function keepSelfStatic(u) { return client && client.user && u.id === client.user.id; }

async function stop() {
  online = false;
  logic.detachDMSender();
  if (client) { try { await client.destroy(); } catch {} client = null; }
}

module.exports = {
  start, stop, getClient: () => client, isOnline: () => online,
  // exported for tests / custom integrations
  Ctx, commands, aliasMap, commandJSON, tokenize, onMessage, onSlash, onButton, onModal, protocol,
  _setForTests: (c, d, conf) => { client = c; D = d; cfg = conf; online = true; if (d && d.MessageFlags) ephemeralFlag = d.MessageFlags.Ephemeral || 64; },
  loadCommands
};

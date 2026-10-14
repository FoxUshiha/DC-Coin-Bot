'use strict';
/**
 * lib/botui.js — every Discord message the bot sends is built here: embeds (always with the
 * bot avatar as a small thumbnail), buttons, modals, receipts, rankings, statements.
 * Everything is plain Discord API JSON (no builders) → light and version-proof.
 */
const logic = require('../logic');
const money = require('./money');
const i18n = require('./i18n');

const COLORS = { primary: 0xF1C40F, ok: 0x2ECC71, err: 0xE74C3C, info: 0x3498DB, warn: 0xF39C12, dark: 0x2B2D31, purple: 0x9B59B6 };
function setPrimary(hex) { const n = parseInt(String(hex || '').replace('#', ''), 16); if (Number.isFinite(n)) COLORS.primary = n; }

const l = (lang, en, pt) => (lang === 'pt' ? pt : en);
const ts = (iso, style = 'f') => { const t = Math.floor(new Date(iso).getTime() / 1000); return Number.isFinite(t) ? `<t:${t}:${style}>` : '—'; };
const coins = (sats, lang) => `**${money.pretty(sats, lang)}** coins`;
const code = (s) => '`' + String(s).replace(/`/g, 'ˋ') + '`';
const shortId = (id) => (String(id).length > 14 ? String(id).slice(0, 8) + '…' : String(id));

function embed(ctx, { title, description, color = COLORS.primary, fields, image, footer, url, author } = {}) {
  const e = { color, timestamp: new Date().toISOString() };
  if (title) e.title = String(title).slice(0, 256);
  if (description) e.description = String(description).slice(0, 4096);
  if (url) e.url = url;
  if (fields && fields.length) e.fields = fields.slice(0, 25).map((f) => ({ name: String(f.name).slice(0, 256), value: String(f.value || '—').slice(0, 1024), inline: !!f.inline }));
  if (image) e.image = { url: image };
  if (author) e.author = author;
  const av = ctx && ctx.avatar;
  if (av) e.thumbnail = { url: av };
  e.footer = { text: `Coin Bank${footer ? ' • ' + footer : ''}`.slice(0, 2048), ...(av ? { icon_url: av } : {}) };
  return e;
}
const okEmbed = (ctx, title, description, extra = {}) => embed(ctx, { title, description, color: COLORS.ok, ...extra });
const errEmbed = (ctx, description, title) => embed(ctx, { title: title || l(ctx.lang, '❌ Error', '❌ Erro'), description, color: COLORS.err });
const errorFor = (ctx, e) => errEmbed(ctx, i18n.errorText(ctx.lang, e, logic.fmtDuration));

const btn = (custom_id, label, style = 2, emoji, disabled = false) => ({ type: 2, style, custom_id, label, ...(emoji ? { emoji: { name: emoji } } : {}), disabled });
const linkBtn = (url, label, emoji) => ({ type: 2, style: 5, url, label, ...(emoji ? { emoji: { name: emoji } } : {}) });
const row = (...components) => ({ type: 1, components: components.filter(Boolean).slice(0, 5) });

/* ───────────── receipts / transactions ───────────── */
function receiptRow(ctx, txId, withPng = true) {
  const url = logic.txUrl(txId);
  return row(
    withPng ? btn(`cb:rcpt:png:${txId}`, 'PNG', 2, '🧾') : null,
    btn(`cb:rcpt:pdf:${txId}`, 'PDF', 2, '📄'),
    /^https?:\/\//.test(url) ? linkBtn(url, l(ctx.lang, 'Verify online', 'Verificar online'), '🔎') : null
  );
}

function txFields(ctx, tx) {
  const sys = logic.economy().systemId;
  return [
    { name: l(ctx.lang, '💰 Amount', '💰 Valor'), value: `${coins(tx.amountSats, ctx.lang)}\n${code(tx.amountSats.toLocaleString(ctx.lang === 'pt' ? 'pt-BR' : 'en-US') + ' sats')}`, inline: true },
    { name: l(ctx.lang, '🏷️ Type', '🏷️ Tipo'), value: tx.from === sys ? l(ctx.lang, 'Reward (claim)', 'Recompensa (claim)') : l(ctx.lang, 'Transfer', 'Transferência'), inline: true },
    { name: l(ctx.lang, '📅 Date', '📅 Data'), value: ts(tx.date, 'f'), inline: true },
    { name: l(ctx.lang, '📤 From', '📤 Origem'), value: tx.from === sys ? l(ctx.lang, '🏦 System', '🏦 Sistema') : `${code(tx.from)}${/^\d{17,20}$/.test(tx.from) ? ` · <@${tx.from}>` : ''}`, inline: true },
    { name: l(ctx.lang, '📥 To', '📥 Destino'), value: `${code(tx.to)}${/^\d{17,20}$/.test(tx.to) ? ` · <@${tx.to}>` : ''}`, inline: true },
    { name: l(ctx.lang, '🆔 Transaction', '🆔 Transação'), value: code(tx.id), inline: false }
  ];
}

/** Full receipt message: embed + receipt PNG (when rendering is available) + PDF/verify buttons. */
async function receiptPayload(ctx, txId, { title, description, color = COLORS.ok, attach = true } = {}) {
  const tx = logic.getTransaction(txId);
  if (!tx) return { embeds: [errorFor(ctx, { code: 'INVALID_TRANSACTION' })] };
  const e = embed(ctx, { title: title || l(ctx.lang, '🧾 Transaction receipt', '🧾 Comprovante de transação'), description, color, fields: txFields(ctx, tx), url: /^https?:/.test(logic.txUrl(tx.id)) ? logic.txUrl(tx.id) : undefined });
  const payload = { embeds: [e], components: [receiptRow(ctx, tx.id, !attach)] };
  if (attach && logic.canRender()) {
    try {
      const buf = await logic.receipt(tx.id, { lang: ctx.lang, format: 'png' });
      const name = `receipt-${tx.id}.png`;
      payload.files = [{ attachment: buf, name }];
      e.image = { url: `attachment://${name}` };
    } catch { /* keep the embed only */ }
  }
  return payload;
}

/* ───────────── balance / claim ───────────── */
function balanceEmbed(ctx, userId, who) {
  const s = logic.accountSummary(userId);
  const st = logic.claimStatus(userId);
  const pos = logic.rankPosition(userId);
  const self = userId === ctx.userId;
  return embed(ctx, {
    title: self ? l(ctx.lang, '💼 Your wallet', '💼 Sua carteira') : l(ctx.lang, `💼 Wallet of ${who || userId}`, `💼 Carteira de ${who || userId}`),
    description: `# ${money.pretty(s.sats, ctx.lang)} coins\n${code(s.sats.toLocaleString(ctx.lang === 'pt' ? 'pt-BR' : 'en-US') + ' sats')}`,
    fields: [
      { name: l(ctx.lang, '🏆 Rank', '🏆 Ranking'), value: pos ? `#${pos}` : '—', inline: true },
      { name: l(ctx.lang, '📖 Transactions', '📖 Transações'), value: String(s.totalTransactions), inline: true },
      { name: l(ctx.lang, '🎁 Next reward', '🎁 Próxima recompensa'), value: st.cooldownRemainingMs > 0 ? `<t:${Math.floor((Date.now() + st.cooldownRemainingMs) / 1000)}:R>` : l(ctx.lang, '✅ Available now', '✅ Disponível agora'), inline: true },
      { name: '🆔 ID', value: code(userId), inline: true },
      ...(s.username ? [{ name: l(ctx.lang, '👤 Site login', '👤 Login do site'), value: code(s.username), inline: true }] : [])
    ]
  });
}

function claimPayload(ctx, r) {
  return {
    embeds: [embed(ctx, {
      title: l(ctx.lang, '🎉 Reward claimed!', '🎉 Recompensa resgatada!'), color: COLORS.primary,
      description: `${l(ctx.lang, 'You received', 'Você recebeu')} ${coins(r.claimedSats, ctx.lang)}\n${l(ctx.lang, 'Next reward', 'Próxima recompensa')}: <t:${Math.floor((Date.now() + r.nextClaimInMs) / 1000)}:R>`,
      fields: [{ name: l(ctx.lang, '💼 Balance', '💼 Saldo'), value: coins(logic.balance(ctx.userId), ctx.lang), inline: true }, { name: l(ctx.lang, '🆔 Transaction', '🆔 Transação'), value: code(r.txId), inline: false }]
    })],
    components: [receiptRow(ctx, r.txId, true)]
  };
}

/* ───────────── rank / history / bills (stateless pagination) ───────────── */
function pager(prefix, page, pages, ownerId, extra) {
  return row(
    btn(`${prefix}:${Math.max(1, page - 1)}:${ownerId}`, '◀', 2, null, page <= 1),
    btn(`cb:noop:${Date.now() % 1e6}`, `${page}/${pages}`, 2, null, true),
    btn(`${prefix}:${Math.min(pages, page + 1)}:${ownerId}`, '▶', 2, null, page >= pages),
    extra || null
  );
}

function rankPayload(ctx, page = 1) {
  const size = 10;
  const r = logic.rank(page, size);
  page = Math.min(r.pages, Math.max(1, page));
  const data = page === r.page ? r : logic.rank(page, size);
  const medal = ['🥇', '🥈', '🥉'];
  const lines = data.rankings.map((u) => {
    const pos = u.position;
    const name = u.username && u.username !== 'none' ? `**${u.username}**` : (/^\d{17,20}$/.test(u.id) ? `<@${u.id}>` : code(u.id));
    return `${medal[pos - 1] || `\`#${pos}\``} ${name} — ${coins(u.sats, ctx.lang)}`;
  });
  const mine = logic.rankPosition(ctx.userId);
  return {
    embeds: [embed(ctx, {
      title: l(ctx.lang, '🏆 Global ranking', '🏆 Ranking global'),
      description: lines.join('\n') || l(ctx.lang, 'No coin holders yet.', 'Ainda não há usuários com coins.'),
      fields: [
        { name: l(ctx.lang, '🌐 Total supply', '🌐 Total em circulação'), value: coins(data.totalSats, ctx.lang), inline: true },
        { name: l(ctx.lang, '👥 Holders', '👥 Carteiras'), value: String(data.totalHolders), inline: true },
        { name: l(ctx.lang, '📍 Your position', '📍 Sua posição'), value: mine ? `#${mine}` : '—', inline: true }
      ],
      footer: l(ctx.lang, `Page ${page}/${data.pages}`, `Página ${page}/${data.pages}`)
    })],
    components: data.pages > 1 ? [pager('cb:rank', page, data.pages, ctx.userId)] : []
  };
}

function historyPayload(ctx, targetId, page = 1) {
  const size = 10;
  const total = logic.accountSummary(targetId).totalTransactions;
  const pages = Math.max(1, Math.ceil(total / size));
  page = Math.min(pages, Math.max(1, page));
  const rows = logic.listTransactions(targetId, page, size);
  const sys = logic.economy().systemId;
  const lines = rows.map((t) => {
    const inn = t.to_id === targetId && t.from_id !== targetId, self = t.to_id === t.from_id;
    const icon = self ? '🔁' : inn ? (t.from_id === sys ? '🎁' : '📥') : '📤';
    const other = inn ? t.from_id : t.to_id;
    const who = other === sys ? l(ctx.lang, 'System', 'Sistema') : code(shortId(other));
    return `${icon} ${inn ? '+' : self ? '±' : '-'}${money.pretty(t.amountSats, ctx.lang)} · ${who} · ${ts(t.date, 'R')}\n└ ${code(t.id)}`;
  });
  const s = logic.accountSummary(targetId);
  return {
    embeds: [embed(ctx, {
      title: targetId === ctx.userId ? l(ctx.lang, '📖 Your statement', '📖 Seu extrato') : l(ctx.lang, `📖 Statement of ${targetId}`, `📖 Extrato de ${targetId}`),
      description: lines.join('\n') || l(ctx.lang, '⚠️ No transactions yet.', '⚠️ Nenhuma transação ainda.'),
      fields: [
        { name: l(ctx.lang, '💼 Balance', '💼 Saldo'), value: coins(s.sats, ctx.lang), inline: true },
        { name: l(ctx.lang, '📖 Transactions', '📖 Transações'), value: String(total), inline: true }
      ],
      footer: l(ctx.lang, `Page ${page}/${pages} • /check <id> shows any receipt`, `Página ${page}/${pages} • /check <id> mostra qualquer comprovante`)
    })],
    components: [pager(`cb:hist:${targetId}`, page, pages, ctx.userId, total ? btn(`cb:hcsv:${targetId}:${ctx.userId}`, 'CSV', 2, '📄') : null)]
  };
}

function historyCsv(targetId, max = 2000) {
  const rows = [];
  for (let p = 1; rows.length < max; p++) {
    const chunk = logic.listTransactions(targetId, p, 100);
    rows.push(...chunk);
    if (chunk.length < 100) break;
  }
  const lines = ['id,date,from,to,amount,amount_sats,direction'];
  for (const t of rows.slice(0, max)) lines.push([t.id, t.date, t.from_id, t.to_id, t.amount, t.amountSats, t.from_id === targetId && t.to_id === targetId ? 'self' : t.to_id === targetId ? 'in' : 'out'].join(','));
  return Buffer.from(lines.join('\n'));
}

function billsPayload(ctx, page = 1) {
  const b = logic.listBills(ctx.userId, page, 10);
  const fmt = (x, pay) => `${pay ? '📤' : '📥'} ${coins(x.amountSats, ctx.lang)} · ${pay ? l(ctx.lang, 'to', 'para') : l(ctx.lang, 'from', 'de')} ${code(shortId(pay ? x.to_id : (x.from_id || l(ctx.lang, 'anyone', 'qualquer um'))))}${x.expiresAt ? ` · ⌛ <t:${Math.floor(x.expiresAt / 1000)}:R>` : ''}\n└ ${code(x.id)}`;
  const more = b.toPay.length >= 10 || b.toReceive.length >= 10;
  return {
    embeds: [embed(ctx, {
      title: l(ctx.lang, '💳 Your bills', '💳 Suas cobranças'),
      fields: [
        { name: l(ctx.lang, `📤 To pay (${b.toPay.length})`, `📤 A pagar (${b.toPay.length})`), value: b.toPay.map((x) => fmt(x, true)).join('\n') || l(ctx.lang, 'Nothing to pay 🎉', 'Nada a pagar 🎉') },
        { name: l(ctx.lang, `📥 To receive (${b.toReceive.length})`, `📥 A receber (${b.toReceive.length})`), value: b.toReceive.map((x) => fmt(x, false)).join('\n') || l(ctx.lang, 'No open bills', 'Nenhuma cobrança aberta') }
      ],
      footer: l(ctx.lang, `Page ${page} • pay with /paybill <id>`, `Página ${page} • pague com /paybill <id>`)
    })],
    components: [row(
      btn(`cb:bills:${Math.max(1, page - 1)}:${ctx.userId}`, '◀', 2, null, page <= 1),
      btn(`cb:bills:${page + 1}:${ctx.userId}`, '▶', 2, null, !more),
      btn('cb:open:paybill', l(ctx.lang, 'Pay a bill', 'Pagar cobrança'), 3, '💸'),
      btn('cb:open:bill', l(ctx.lang, 'New bill', 'Nova cobrança'), 1, '🧾')
    )]
  };
}

/* ───────────── ATM ───────────── */
function atmPayload(ctx) {
  const st = logic.claimStatus(ctx.userId || '0');
  return {
    embeds: [embed(ctx, {
      title: '🏧 Coin ATM',
      description: [
        `🇺🇸 Press **Claim** to receive ${coins(st.claimAmountSats, 'en')} every **${logic.fmtDuration(st.cooldownMs, 'en')}**.`,
        `🇧🇷 Aperte **Resgatar** para receber ${coins(st.claimAmountSats, 'pt')} a cada **${logic.fmtDuration(st.cooldownMs, 'pt')}**.`,
        '',
        '🇺🇸 Transfer coins, check your balance or get your payment card below.',
        '🇧🇷 Transfira coins, veja seu saldo ou pegue seu cartão de pagamento abaixo.'
      ].join('\n')
    })],
    components: [row(
      btn('cb:claim', 'Claim · Resgatar', 3, '🎁'),
      btn('cb:transfer', 'Transfer · Transferir', 2, '🏦'),
      btn('cb:bal', 'Balance · Saldo', 1, '💵'),
      btn('cb:card', 'Card · Cartão', 2, '💳')
    )]
  };
}

/* ───────────── QR payments ───────────── */
async function payRequestPayload(ctx, r, { title } = {}) {
  const L = ctx.lang;
  const status = { open: l(L, '🟢 Open', '🟢 Aberto'), paid: l(L, '✅ Paid', '✅ Pago'), cancelled: l(L, '🚫 Cancelled', '🚫 Cancelado'), expired: l(L, '⌛ Expired', '⌛ Expirado') }[r.status] || r.status;
  const e = embed(ctx, {
    title: title || l(L, '📲 Payment QR', '📲 QR de pagamento'), color: r.status === 'open' ? COLORS.primary : COLORS.dark, url: /^https?:/.test(r.url) ? r.url : undefined,
    description: `${r.amountSats ? `# ${money.pretty(r.amountSats, L)} coins` : `### ${l(L, 'Any amount (payer chooses)', 'Valor livre (quem paga escolhe)')}`}${r.memo ? `\n> ${r.memo.replace(/\n/g, ' ')}` : ''}`,
    fields: [
      { name: l(L, '📥 Receiver', '📥 Recebedor'), value: `${r.toName ? `**${r.toName}** · ` : ''}${code(r.to)}`, inline: true },
      { name: l(L, '📌 Status', '📌 Status'), value: status + (r.reusable ? l(L, ' · reusable', ' · reutilizável') : ''), inline: true },
      { name: l(L, '⌛ Expires', '⌛ Expira'), value: `<t:${Math.floor(r.expiresAt / 1000)}:R>`, inline: true },
      ...(r.paidCount ? [{ name: l(L, '💰 Received', '💰 Recebido'), value: `${r.paidCount}× · ${coins(r.paidTotalSats, L)}`, inline: true }] : []),
      { name: '🔗 Link', value: r.url }
    ],
    footer: `ID ${r.id}`
  });
  const payload = { embeds: [e], components: [] };
  const btns = [];
  if (r.status === 'open') btns.push(btn(`cb:prpay:${r.id}`, l(L, 'Pay with Discord', 'Pagar pelo Discord'), 3, '💸'));
  if (/^https?:/.test(r.url) && r.status === 'open') btns.push(linkBtn(r.url, l(L, 'Pay online', 'Pagar online'), '🌐'));
  btns.push(btn(`cb:prstat:${r.id}`, l(L, 'Refresh', 'Atualizar'), 2, '🔄'));
  if (r.status === 'open') btns.push(btn(`cb:prcancel:${r.id}`, l(L, 'Cancel', 'Cancelar'), 4, '✖️'));
  payload.components.push(row(...btns));
  if (r.status === 'open' && logic.canRender()) {
    try {
      const name = `pay-${r.id}.png`;
      payload.files = [{ attachment: await logic.payRequestQr(r.id, { format: 'png', lang: L }), name }];
      e.image = { url: `attachment://${name}` };
    } catch { /* link only */ }
  }
  return payload;
}

/* ───────────── modals ───────────── */
const input = (custom_id, label, { style = 1, required = true, min, max, placeholder, value } = {}) => ({
  type: 1, components: [{ type: 4, custom_id, label: label.slice(0, 45), style, required, ...(min ? { min_length: min } : {}), ...(max ? { max_length: max } : {}), ...(placeholder ? { placeholder: placeholder.slice(0, 100) } : {}), ...(value ? { value } : {}) }]
});
const modals = {
  transfer: (lang) => ({ custom_id: 'cb:m:transfer', title: l(lang, '🏦 Transfer coins', '🏦 Transferir coins'), components: [
    input('userId', l(lang, 'Destination user ID', 'ID do usuário de destino'), { min: 1, max: 32, placeholder: '1378457877085290628' }),
    input('valor', l(lang, 'Amount (up to 8 decimals)', 'Valor (até 8 casas decimais)'), { max: 24, placeholder: '0.00000001' })] }),
  bill: (lang) => ({ custom_id: 'cb:m:bill', title: l(lang, '🧾 Create a bill', '🧾 Criar cobrança'), components: [
    input('amount', l(lang, 'Amount (coins)', 'Valor (coins)'), { max: 24, placeholder: '0.00000001' }),
    input('fromId', l(lang, 'Payer ID (optional = anyone)', 'ID do pagador (opcional = qualquer um)'), { required: false, max: 32 }),
    input('toId', l(lang, 'Receiver ID (optional = you)', 'ID do recebedor (opcional = você)'), { required: false, max: 32 }),
    input('time', l(lang, 'Expires in (e.g. 1h, 7d, 30d)', 'Expira em (ex.: 1h, 7d, 30d)'), { required: false, max: 8, placeholder: '30d' })] }),
  paybill: (lang) => ({ custom_id: 'cb:m:paybill', title: l(lang, '💸 Pay a bill', '💸 Pagar cobrança'), components: [
    input('billId', l(lang, 'Bill ID', 'ID da cobrança'), { min: 8, max: 64 })] }),
  prpay: (lang, r) => ({ custom_id: `cb:m:prpay:${r.id}`, title: l(lang, '💸 Pay QR request', '💸 Pagar pedido QR'), components: [
    input('amount', r.amountSats ? l(lang, 'Amount (fixed — confirm)', 'Valor (fixo — confirme)') : l(lang, 'Amount to pay', 'Valor a pagar'), { max: 24, value: r.amount || undefined, placeholder: '0.00000001' })] }),
  user: (lang) => ({ custom_id: 'cb:m:user', title: l(lang, '🏦 Website login', '🏦 Login do site'), components: [
    input('username', l(lang, 'Username (3-24: a-z 0-9 _ . -)', 'Usuário (3-24: a-z 0-9 _ . -)'), { min: 3, max: 24 }),
    input('password', l(lang, 'Password (4-128)', 'Senha (4-128)'), { min: 4, max: 128 }),
    input('confirm_password', l(lang, 'Confirm password', 'Confirme a senha'), { min: 4, max: 128 })] })
};

module.exports = {
  COLORS, setPrimary, l, ts, coins, code, shortId, embed, okEmbed, errEmbed, errorFor, btn, linkBtn, row,
  receiptRow, txFields, receiptPayload, payRequestPayload, balanceEmbed, claimPayload, rankPayload, historyPayload, historyCsv, billsPayload, atmPayload, modals
};

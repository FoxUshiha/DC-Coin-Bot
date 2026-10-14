'use strict';
/**
 * lib/i18n.js — bilingual (English / Português) texts shared by the bot.
 * Most command texts live next to the command as ctx.l('english', 'português');
 * this file keeps the error catalogue and the long shared messages.
 */

const ERRORS = {
  INSUFFICIENT_FUNDS: ['💸 Insufficient balance for this operation.', '💸 Saldo insuficiente para esta operação.'],
  TRANSFER_COOLDOWN: ['⏳ Wait a moment between transfers ({s}).', '⏳ Aguarde um instante entre transferências ({s}).'],
  COOLDOWN_ACTIVE: ['⏳ Reward not ready yet. Come back in **{s}**.', '⏳ Recompensa ainda não disponível. Volte em **{s}**.'],
  INVALID_AMOUNT: ['❌ Invalid amount. Use up to 8 decimals, e.g. `0.00000001`.', '❌ Valor inválido. Use até 8 casas decimais, ex.: `0.00000001`.'],
  AMOUNT_TOO_SMALL: ['❌ Amount too small (minimum {min}).', '❌ Valor muito pequeno (mínimo {min}).'],
  INVALID_TARGET: ['❌ Invalid destination account/user.', '❌ Conta/usuário de destino inválido.'],
  SELF_TRANSFER: ['🚫 You cannot send coins to yourself.', '🚫 Você não pode enviar coins para si mesmo.'],
  BILL_NOT_FOUND: ['❌ Bill not found (it may have been paid or expired).', '❌ Cobrança não encontrada (pode já ter sido paga ou expirado).'],
  BILL_EXPIRED: ['⌛ This bill has expired.', '⌛ Esta cobrança expirou.'],
  CARD_NOT_FOUND: ['❌ Card not found.', '❌ Cartão não encontrado.'],
  FROM_CARD_NOT_FOUND: ['❌ Source card not found.', '❌ Cartão de origem não encontrado.'],
  TO_CARD_NOT_FOUND: ['❌ Destination card not found.', '❌ Cartão de destino não encontrado.'],
  BACKUP_NOT_FOUND: ['❌ Unknown backup code.', '❌ Código de backup desconhecido.'],
  BACKUP_SAME_ACCOUNT: ['🚫 You cannot restore a backup into the same account. The code was invalidated — create a new one with /backup.', '🚫 Você não pode restaurar um backup na mesma conta. O código foi invalidado — gere outro com /backup.'],
  BACKUP_EMPTY: ['❌ That wallet is empty — nothing to restore.', '❌ Essa carteira está vazia — nada para restaurar.'],
  EMPTY_WALLET: ['❌ Your wallet is empty, so no backup codes are needed.', '❌ Sua carteira está vazia, então não há códigos de backup a gerar.'],
  INVALID_USERNAME: ['❌ Username must have 3-24 characters: letters, numbers, `_ . -`', '❌ O nome de usuário deve ter 3-24 caracteres: letras, números, `_ . -`'],
  INVALID_PASSWORD: ['❌ Password must have 4-128 characters.', '❌ A senha deve ter de 4 a 128 caracteres.'],
  'Username already taken': ['⚠️ That username is already in use.', '⚠️ Esse nome de usuário já está em uso.'],
  INVALID_TIME: ['❌ Invalid time. Use e.g. `30d`, `12h`, `45m`.', '❌ Tempo inválido. Use ex.: `30d`, `12h`, `45m`.'],
  MAX_SUPPLY_REACHED: ['🏁 The maximum coin supply was reached — no more rewards can be minted.', '🏁 O limite máximo de moedas foi atingido — não é possível emitir mais recompensas.'],
  RENDER_UNAVAILABLE: ['🖼️ Image rendering is unavailable on this server (install `sharp`).', '🖼️ A geração de imagens está indisponível neste servidor (instale o `sharp`).'],
  INVALID_TRANSACTION: ['❌ Transaction not found.', '❌ Transação não encontrada.'],
  DB_WRITE_FAILED: ['⚠️ Database is busy, please retry in a few seconds.', '⚠️ Banco de dados ocupado, tente novamente em alguns segundos.'],
  QUEUE_FULL: ['⚠️ The system is busy, please retry.', '⚠️ O sistema está ocupado, tente novamente.'],
  'Invalid parameters': ['❌ Invalid parameters.', '❌ Parâmetros inválidos.'],
  'Missing billId': ['❌ Provide a bill ID.', '❌ Informe o ID da cobrança.'],
  PAYREQ_NOT_FOUND: ['❌ Payment request not found.', '❌ Pedido de pagamento não encontrado.'],
  PAYREQ_PAID: ['✅ This payment request was already paid.', '✅ Este pedido de pagamento já foi pago.'],
  PAYREQ_CANCELLED: ['🚫 This payment request was cancelled.', '🚫 Este pedido de pagamento foi cancelado.'],
  PAYREQ_EXPIRED: ['⌛ This payment request has expired.', '⌛ Este pedido de pagamento expirou.'],
  PAYREQ_CLOSED: ['🚫 This payment request is closed.', '🚫 Este pedido de pagamento está encerrado.'],
  AMOUNT_REQUIRED: ['❌ This request has no fixed amount — enter the amount to pay.', '❌ Este pedido não tem valor fixo — informe o valor a pagar.'],
  TOO_MANY_REQUESTS: ['⚠️ You have too many open payment requests. Cancel some first.', '⚠️ Você tem pedidos de pagamento abertos demais. Cancele alguns antes.'],
  UNKNOWN_USER: ['❌ Unknown user.', '❌ Usuário desconhecido.'],
  NO_PERMISSION: ['🚫 You do not have permission to use this command.', '🚫 Você não tem permissão para usar este comando.'],
  GUILD_ONLY: ['🏠 Use this command inside a server.', '🏠 Use este comando dentro de um servidor.'],
  BOT_NO_PERMS: ['⚠️ I need **View Channel**, **Send Messages** and **Embed Links** permissions in that channel.', '⚠️ Preciso das permissões **Ver canal**, **Enviar mensagens** e **Inserir links** nesse canal.'],
  GENERIC: ['❌ Something went wrong. Please try again in a moment.', '❌ Algo deu errado. Tente novamente em instantes.']
};

function fill(s, vars) { return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : s; }

/** Error code → localized sentence. */
function errorText(lang, e, fmtDuration) {
  const code = e && (e.code || e.message) ? String(e.code || e.message) : 'GENERIC';
  const vars = {};
  if (e && e.nextClaimInMs !== undefined) vars.s = fmtDuration(e.nextClaimInMs, lang);
  if (e && e.retryAfterMs !== undefined) vars.s = fmtDuration(e.retryAfterMs, lang);
  if (e && e.min) vars.min = e.min;
  if (code.startsWith('Block:')) return lang === 'pt' ? '⛔ Limite de criação de contas atingido.' : '⛔ Account creation limit reached.';
  const pair = ERRORS[code] || ERRORS.GENERIC;
  return fill(pair[lang === 'pt' ? 1 : 0], vars);
}

/** Guild join DM: every line in English followed by Portuguese. */
function guildJoinPayload(links, botName, color, avatar) {
  const L = (en, pt) => `🇺🇸 ${en}\n🇧🇷 ${pt}`;
  const cmds = [
    ['/help · /ajuda', 'help menu', 'menu de ajuda'],
    ['/bal', 'your balance', 'seu saldo'],
    ['/pay', 'send coins to a user or ID', 'envia coins para um usuário ou ID'],
    ['/claim', 'collect your reward', 'resgata sua recompensa'],
    ['/qr · /myqr', 'payment QR codes (scan & pay)', 'QR codes de pagamento (escaneie e pague)'],
    ['/rank · /global', 'richest users · economy stats', 'mais ricos · estatísticas da economia'],
    ['/grafic · /history · /check', 'balance chart · statement · receipts (PNG/PDF)', 'gráfico · extrato · comprovantes (PNG/PDF)'],
    ['/bill · /bills · /paybill', 'create, list and pay bills', 'criar, listar e pagar cobranças'],
    ['/card · /cardreset', 'your payment card for the API', 'seu cartão de pagamento para a API'],
    ['/backup · /restore', 'wallet backup codes', 'códigos de backup da carteira'],
    ['/user', 'website login (username/password)', 'login do site (usuário/senha)'],
    ['/set · /api · /config', 'ATM channel, API channel, language (admins)', 'canal ATM, canal da API, idioma (admins)']
  ];
  const lines = [
    L(`**Thanks for adding ${botName}!**`, `**Obrigado por adicionar o ${botName}!**`),
    '',
    L('Make sure I can **view the channel, send messages and embed links**.', 'Garanta que eu possa **ver o canal, enviar mensagens e inserir links**.'),
    L('Every command works as a slash command (`/pay`) or by mentioning me (`@Coin pay @user 0.01`).', 'Todo comando funciona com barra (`/pay`) ou me mencionando (`@Coin pagar @usuário 0.01`).'),
    L('Commands also work in my DMs.', 'Os comandos também funcionam no meu privado.'),
    ''
  ];
  const fields = [{
    name: '📘 Commands · Comandos',
    value: cmds.map(([c, en, pt]) => `\`${c}\`\n└ 🇺🇸 ${en} · 🇧🇷 ${pt}`).join('\n').slice(0, 1024)
  }];
  if (links.donation_btc) fields.push({ name: '💛 Donations · Doações (BTC)', value: '```' + links.donation_btc + '```' });
  const embed = {
    color, title: `🏦 ${botName}`, description: lines.join('\n'), fields,
    thumbnail: avatar ? { url: avatar } : undefined,
    footer: { text: 'Coin Bank · System developed by FoxOficial' }, timestamp: new Date().toISOString()
  };
  const btn = (label, url) => (url ? { type: 2, style: 5, label, url } : null);
  const row1 = [btn('Website', links.website), btn('Support · Suporte', links.support), btn('API Docs', links.docs), btn('Terms · Termos', links.terms), btn('Privacy · Privacidade', links.privacy)].filter(Boolean);
  const row2 = [btn('Add to server · Adicionar', links.invite), btn('Extension · Extensão', links.extension), btn('Minecraft Plugin', links.plugin), btn('Coin Store', links.store)].filter(Boolean);
  const components = [];
  if (row1.length) components.push({ type: 1, components: row1.slice(0, 5) });
  if (row2.length) components.push({ type: 1, components: row2.slice(0, 5) });
  return { embeds: [embed], components };
}

module.exports = { ERRORS, errorText, guildJoinPayload, fill };

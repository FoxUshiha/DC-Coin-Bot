'use strict';
/** /help — English help menu (also @Bot help). /ajuda is the Portuguese twin. */
const CATS = [
  ['economy', '💰 Economy', '💰 Economia'],
  ['rewards', '🎁 Rewards', '🎁 Recompensas'],
  ['utility', '🧰 Utility', '🧰 Utilidades'],
  ['account', '👤 Account', '👤 Conta'],
  ['admin', '🛠️ Server admins', '🛠️ Admins do servidor'],
  ['staff', '🛡️ Bot staff', '🛡️ Equipe do bot']
];

function build(ctx, ui) {
  const { commands } = require('../bot');
  const lang = ctx.lang;
  const fields = [];
  for (const [cat, en, pt] of CATS) {
    if (cat === 'staff' && !ctx.isStaff()) continue;
    const list = [...commands.values()].filter((c) => (c.category || 'utility') === cat && !c.hidden);
    if (!list.length) continue;
    const lines = list.map((c) => {
      const nm = lang === 'pt' && c.names && c.names.pt ? c.names.pt : c.name;
      return `\`/${nm}\` — ${(c.description && c.description[lang]) || ''}`;
    });
    fields.push({ name: lang === 'pt' ? pt : en, value: lines.join('\n').slice(0, 1024) });
  }
  const bot = ctx.client && ctx.client.user ? ctx.client.user.username : 'Coin';
  fields.push({
    name: lang === 'pt' ? '💬 Também por menção' : '💬 Also by mention',
    value: lang === 'pt'
      ? `\`@${bot} pagar @usuário 0.00000001\`\n\`@${bot} saldo\` · \`@${bot} historico 2\`\nNo privado do bot, nem precisa mencionar.`
      : `\`@${bot} pay @user 0.00000001\`\n\`@${bot} bal\` · \`@${bot} history 2\`\nIn my DMs you don't even need to mention me.`
  });
  const links = ctx.cfg.discord.links || {};
  const btns = [
    links.website && ui.linkBtn(links.website, 'Website', '🌐'),
    links.docs && ui.linkBtn(links.docs, 'API Docs', '🔩'),
    links.support && ui.linkBtn(links.support, lang === 'pt' ? 'Suporte' : 'Support', '💬'),
    links.invite && ui.linkBtn(links.invite, lang === 'pt' ? 'Adicionar' : 'Invite', '➕')
  ].filter(Boolean);
  return {
    embeds: [ui.embed(ctx, {
      title: lang === 'pt' ? '🤖 Comandos disponíveis' : '🤖 Available commands',
      description: lang === 'pt'
        ? 'Moeda digital estilo Bitcoin, sem valor real, com cartão próprio, API pública e comprovantes.\nUse `/help` para ver em inglês.'
        : 'A Bitcoin-like digital coin with no real-world value, its own payment card, public API and receipts.\nUse `/ajuda` for Portuguese.',
      fields
    })],
    components: btns.length ? [ui.row(...btns)] : []
  };
}

module.exports = {
  name: 'help', lang: 'en', category: 'utility',
  aliases: { en: ['commands', 'h', '?'], pt: [] },
  description: { en: 'Shows every command (English)', pt: 'Mostra todos os comandos (inglês)' },
  build,
  async run(ctx, { ui }) { await ctx.send(build(ctx, ui)); }
};

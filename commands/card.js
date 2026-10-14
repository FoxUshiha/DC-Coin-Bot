'use strict';
module.exports = {
  name: 'card', names: { pt: 'cartao' }, category: 'account',
  aliases: { en: ['mycard'], pt: ['cartão', 'meucartao'] },
  description: { en: 'Shows your Coin Card (payment code for the API)', pt: 'Mostra seu Coin Card (código de pagamento da API)' },
  async run(ctx, { ui, logic }) {
    const code = await logic.getCard(ctx.userId);
    await ctx.sendPrivate({ embeds: [ui.embed(ctx, {
      title: ctx.l('💳 Your Coin Card', '💳 Seu Coin Card'), color: ui.COLORS.purple,
      description: `||\`\`\`${code}\`\`\`||\n${ctx.l('Use it in the browser extension, Minecraft plugin, stores and other bots.', 'Use na extensão do navegador, plugin de Minecraft, lojas e outros bots.')}\n\n⚠️ ${ctx.l('Anyone with this code can spend your coins. Leaked it? Use `/cardreset`.', 'Quem tiver este código pode gastar seus coins. Vazou? Use `/resetarcartao`.')}`
    })] });
  }
};

'use strict';
module.exports = {
  name: 'cardreset', names: { pt: 'resetarcartao' }, category: 'account',
  aliases: { en: ['newcard', 'resetcard'], pt: ['novocartao', 'resetarcartão'] },
  description: { en: 'Generates a new card (the old code stops working)', pt: 'Gera um novo cartão (o código antigo deixa de funcionar)' },
  async run(ctx, { ui, logic }) {
    const code = await logic.resetCard(ctx.userId);
    await ctx.sendPrivate({ embeds: [ui.embed(ctx, {
      title: ctx.l('♻️ Card regenerated', '♻️ Cartão regenerado'), color: ui.COLORS.purple,
      description: `||\`\`\`${code}\`\`\`||\n${ctx.l('The previous code was invalidated.', 'O código anterior foi invalidado.')}`
    })] });
  }
};

'use strict';
module.exports = {
  name: 'bal', names: { pt: 'saldo' }, category: 'economy',
  aliases: { en: ['balance', 'wallet', 'money'], pt: ['carteira', 'dinheiro'] },
  description: { en: 'Shows your balance, rank and next reward', pt: 'Mostra seu saldo, ranking e próxima recompensa' },
  async run(ctx, { ui }) {
    await ctx.send({
      embeds: [ui.balanceEmbed(ctx, ctx.userId, ctx.user.username)],
      components: [ui.row(
        ui.btn('cb:claim', ctx.l('Claim', 'Resgatar'), 3, '🎁'),
        ui.btn(`cb:graph:png:${ctx.userId}:30`, ctx.l('Chart', 'Gráfico'), 2, '📊'),
        ui.btn(`cb:hist:${ctx.userId}:1:${ctx.userId}`, ctx.l('Statement', 'Extrato'), 2, '📖')
      )]
    });
  }
};

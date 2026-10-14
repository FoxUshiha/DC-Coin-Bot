'use strict';
module.exports = {
  name: 'restore', names: { pt: 'restaurar' }, category: 'account',
  aliases: { en: ['recover'], pt: ['recuperar'] },
  description: { en: 'Restores a wallet from a backup code', pt: 'Restaura uma carteira a partir de um código de backup' },
  options: [{ name: 'code', names: { pt: 'codigo' }, type: 'string', required: true, maxLength: 64, description: { en: 'Backup code from /backup', pt: 'Código de backup do /backup' } }],
  async run(ctx, { ui, logic }) {
    const code = ctx.str('code');
    if (!code) return ctx.fail(ctx.l('Usage: `/restore code:<code>`', 'Uso: `/restaurar codigo:<código>`'));
    const r = await logic.restoreBackup(ctx.userId, code);
    await ctx.send(await ui.receiptPayload(ctx, r.txId, { title: ctx.l('🎉 Wallet restored', '🎉 Carteira restaurada'), description: `${ui.coins(r.amountSats, ctx.lang)} ${ctx.l('moved to your wallet.', 'movidos para sua carteira.')}` }));
  }
};

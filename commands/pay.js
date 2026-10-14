'use strict';
module.exports = {
  name: 'pay', names: { pt: 'pagar' }, category: 'economy',
  aliases: { en: ['send', 'transfer', 'give'], pt: ['enviar', 'transferir', 'pix'] },
  description: { en: 'Sends coins to a user or account ID (receipt PNG/PDF)', pt: 'Envia coins para um usuário ou ID de conta (comprovante PNG/PDF)' },
  options: [
    { name: 'amount', names: { pt: 'valor' }, type: 'string', required: true, maxLength: 24, description: { en: 'Amount in coins (up to 8 decimals)', pt: 'Valor em coins (até 8 casas decimais)' } },
    { name: 'user', names: { pt: 'usuario' }, type: 'user', description: { en: 'Destination Discord user', pt: 'Usuário do Discord de destino' } },
    { name: 'userid', names: { pt: 'id' }, type: 'string', maxLength: 32, description: { en: 'Destination account ID (site / API)', pt: 'ID da conta de destino (site / API)' } }
  ],
  textArgs: ['user', 'amount'],
  async run(ctx, { ui, logic, money }) {
    let to = ctx.targetId('user') || logic.cleanId(ctx.str('userid'));
    let amount = ctx.str('amount');
    // text mode also accepts "pay 0.5 @user"
    if (!ctx.isSlash && (!to || money.parse(amount || '') === null)) {
      const a = logic.cleanId(ctx.args[1]); const b = ctx.args[0];
      if (a && money.parse(b || '') !== null) { to = a; amount = b; }
    }
    if (!to || !amount) return ctx.fail(ctx.l('Usage: `/pay amount:<value> user:@user` or `@Bot pay @user 0.00000001`', 'Uso: `/pagar valor:<valor> usuario:@usuário` ou `@Bot pagar @usuário 0.00000001`'));
    const r = await logic.transfer(ctx.userId, to, amount, { source: 'discord' });
    await ctx.send(await ui.receiptPayload(ctx, r.txId, {
      title: ctx.l('✅ Transfer sent', '✅ Transferência enviada'),
      description: `${ui.coins(r.amountSats, ctx.lang)} → ${/^\d{17,20}$/.test(to) ? `<@${to}>` : ui.code(to)}\n${ctx.l('New balance', 'Novo saldo')}: ${ui.coins(logic.balance(ctx.userId), ctx.lang)}`
    }));
  }
};

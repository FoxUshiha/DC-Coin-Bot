'use strict';
module.exports = {
  name: 'check', names: { pt: 'verificar' }, category: 'utility',
  aliases: { en: ['receipt', 'tx', 'transaction'], pt: ['comprovante', 'recibo', 'transacao'] },
  description: { en: 'Checks a transaction and shows its receipt (PNG/PDF)', pt: 'Consulta uma transação e mostra o comprovante (PNG/PDF)' },
  options: [{ name: 'txid', names: { pt: 'id' }, type: 'string', required: true, maxLength: 64, description: { en: 'Transaction ID', pt: 'ID da transação' } }],
  async run(ctx, { ui, logic }) {
    const id = ctx.str('txid');
    if (!id) return ctx.fail(ctx.l('Usage: `/check txid:<id>`', 'Uso: `/verificar id:<id>`'));
    if (!logic.getTransaction(id)) return ctx.error({ code: 'INVALID_TRANSACTION' });
    await ctx.send(await ui.receiptPayload(ctx, id, { title: ctx.l('✅ Transaction confirmed', '✅ Transação confirmada') }));
  }
};

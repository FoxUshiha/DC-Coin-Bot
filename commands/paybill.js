'use strict';
module.exports = {
  name: 'paybill', names: { pt: 'pagarcobranca' }, category: 'economy',
  aliases: { en: ['payinvoice'], pt: ['pagarconta', 'pagarfatura', 'pagarcobrança'] },
  description: { en: 'Pays a bill by its ID (receipt PNG/PDF)', pt: 'Paga uma cobrança pelo ID (comprovante PNG/PDF)' },
  options: [{ name: 'bill_id', names: { pt: 'id_cobranca' }, type: 'string', maxLength: 64, description: { en: 'Bill ID (empty = open a form)', pt: 'ID da cobrança (vazio = abrir formulário)' } }],
  modal: (ctx) => ctx.isSlash && !ctx.str('bill_id'),
  async run(ctx, { ui, logic }) {
    const id = ctx.str('bill_id');
    if (!id) return ctx.showModal(ui.modals.paybill(ctx.lang));
    const r = await logic.payBill(ctx.userId, id, { source: 'discord' });
    if (r.self) return ctx.ok(ctx.l('🏦 Bill closed', '🏦 Cobrança encerrada'), ctx.l(`You closed your own bill ${ui.code(r.billId)} — no coins moved.`, `Você encerrou sua própria cobrança ${ui.code(r.billId)} — nenhum coin foi movido.`));
    await ctx.send(await ui.receiptPayload(ctx, r.txId, { title: ctx.l('✅ Bill paid', '✅ Cobrança paga'), description: `${ui.coins(r.amountSats, ctx.lang)} → ${ui.code(r.toId)}` }));
  }
};

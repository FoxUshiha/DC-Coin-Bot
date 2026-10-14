'use strict';
module.exports = {
  name: 'bill', names: { pt: 'cobranca' }, category: 'economy', modal: true,
  aliases: { en: ['invoice', 'charge'], pt: ['cobrar', 'cobrança', 'fatura'] },
  description: { en: 'Creates a bill (payment request) with expiration', pt: 'Cria uma cobrança (pedido de pagamento) com validade' },
  async run(ctx, { ui }) { await ctx.showModal(ui.modals.bill(ctx.lang)); }
};

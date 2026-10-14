'use strict';
module.exports = {
  name: 'bills', names: { pt: 'cobrancas' }, category: 'economy',
  aliases: { en: ['invoices'], pt: ['cobranças', 'faturas'] },
  description: { en: 'Lists your bills to pay and to receive', pt: 'Lista suas cobranças a pagar e a receber' },
  options: [{ name: 'page', names: { pt: 'pagina' }, type: 'integer', min: 1, max: 10000, description: { en: 'Page', pt: 'Página' } }],
  async run(ctx, { ui }) { await ctx.send(ui.billsPayload(ctx, ctx.int('page') || 1)); }
};

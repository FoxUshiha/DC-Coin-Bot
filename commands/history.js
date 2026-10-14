'use strict';
module.exports = {
  name: 'history', names: { pt: 'historico' }, category: 'utility',
  aliases: { en: ['statement', 'txs', 'transactions'], pt: ['extrato', 'transacoes', 'histórico'] },
  description: { en: 'Transaction statement (yours or any ID) + CSV export', pt: 'Extrato de transações (seu ou de qualquer ID) + exportar CSV' },
  options: [
    { name: 'user', names: { pt: 'usuario' }, type: 'string', maxLength: 40, description: { en: 'Mention or account ID (default: you)', pt: 'Menção ou ID da conta (padrão: você)' } },
    { name: 'page', names: { pt: 'pagina' }, type: 'integer', min: 1, max: 100000, description: { en: 'Page (10 per page)', pt: 'Página (10 por página)' } }
  ],
  async run(ctx, { ui, logic }) {
    let target = ctx.userId, page = ctx.int('page') || 1;
    const u = ctx.str('user');
    if (u) {
      const id = logic.cleanId(u);
      if (id && (id.length >= 12 || ctx.isSlash)) target = id;
      else if (/^\d{1,6}$/.test(u) && !ctx.isSlash) page = parseInt(u, 10); // "@Bot history 2"
      else return ctx.error({ code: 'UNKNOWN_USER' });
    }
    await ctx.send(ui.historyPayload(ctx, target, page));
  }
};

'use strict';
module.exports = {
  name: 'rank', names: { pt: 'ranking' }, category: 'economy', ephemeral: false,
  aliases: { en: ['top', 'leaderboard', 'lb'], pt: ['ricos', 'placar'] },
  description: { en: 'Shows the richest users (paginated)', pt: 'Mostra os usuários mais ricos (com páginas)' },
  options: [{ name: 'page', names: { pt: 'pagina' }, type: 'integer', min: 1, max: 100000, description: { en: 'Page number', pt: 'Número da página' } }],
  async run(ctx, { ui }) { await ctx.send(ui.rankPayload(ctx, ctx.int('page') || 1)); }
};

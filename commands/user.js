'use strict';
module.exports = {
  name: 'user', names: { pt: 'conta' }, category: 'account', modal: true,
  aliases: { en: ['register', 'account', 'login'], pt: ['registrar', 'cadastro', 'usuario'] },
  description: { en: 'Creates/updates your website login (username + password)', pt: 'Cria/atualiza seu login do site (usuário + senha)' },
  async run(ctx, { ui }) { await ctx.showModal(ui.modals.user(ctx.lang)); }
};

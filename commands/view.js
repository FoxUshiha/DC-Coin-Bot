'use strict';
module.exports = {
  name: 'view', names: { pt: 'ver' }, category: 'economy',
  aliases: { en: ['see', 'look'], pt: ['consultar', 'olhar'] },
  description: { en: "Shows another user's balance", pt: 'Mostra o saldo de outro usuário' },
  options: [{ name: 'user', names: { pt: 'usuario' }, type: 'user', required: true, description: { en: 'User (mention or ID)', pt: 'Usuário (menção ou ID)' } }],
  async run(ctx, { ui }) {
    const id = ctx.targetId('user');
    if (!id) return ctx.fail(ctx.l('Usage: `view @user` or `view <id>`', 'Uso: `ver @usuário` ou `ver <id>`'));
    const u = await ctx.userObj('user');
    await ctx.send({ embeds: [ui.balanceEmbed(ctx, id, u ? u.username : id)] });
  }
};

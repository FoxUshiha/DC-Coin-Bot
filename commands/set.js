'use strict';
function botCanPost(ctx, channel, D) {
  try {
    if (!channel || typeof channel.permissionsFor !== 'function') return false;
    const me = ctx.guild.members.me;
    const p = channel.permissionsFor(me);
    const F = D.PermissionFlagsBits;
    return !!p && p.has(F.ViewChannel) && p.has(F.SendMessages) && p.has(F.EmbedLinks);
  } catch { return false; }
}
module.exports = {
  name: 'set', names: { pt: 'caixa' }, category: 'admin', guildOnly: true, perm: 'guildAdmin',
  aliases: { en: ['atm', 'setatm'], pt: ['caixaeletronico', 'definir'] },
  description: { en: 'Posts the ATM (claim/transfer/balance buttons) in a channel', pt: 'Publica o caixa eletrônico (botões resgatar/transferir/saldo) em um canal' },
  options: [{ name: 'channel', names: { pt: 'canal' }, type: 'channel', required: true, description: { en: 'Text channel for the ATM', pt: 'Canal de texto para o caixa' } }],
  botCanPost,
  async run(ctx, { ui, logic, D }) {
    const ch = await ctx.channelObj('channel');
    if (!ch || !ch.isTextBased || !ch.isTextBased() || ch.guildId !== ctx.guildId) return ctx.fail(ctx.l('Choose a text channel of this server.', 'Escolha um canal de texto deste servidor.'));
    if (!botCanPost(ctx, ch, D)) return ctx.error({ code: 'BOT_NO_PERMS' });
    await ch.send(ui.atmPayload(ctx));
    await logic.setGuild(ctx.guildId, { atm_channel: ch.id });
    await ctx.ok(ctx.l('🏧 ATM ready', '🏧 Caixa pronto'), ctx.l(`The ATM was posted in <#${ch.id}>.`, `O caixa foi publicado em <#${ch.id}>.`));
  }
};

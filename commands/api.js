'use strict';
const { botCanPost } = require('./set');
module.exports = {
  name: 'api', names: { pt: 'api' }, category: 'admin', guildOnly: true, perm: 'guildAdmin',
  aliases: { en: ['apichannel'], pt: ['canalapi'] },
  description: { en: 'Sets the API channel used by bots/plugins (active/bill/paybill/verify)', pt: 'Define o canal da API usado por bots/plugins (active/bill/paybill/verify)' },
  options: [{ name: 'channel', names: { pt: 'canal' }, type: 'channel', required: true, description: { en: 'API text channel', pt: 'Canal de texto da API' } }],
  async run(ctx, { logic, D }) {
    const ch = await ctx.channelObj('channel');
    if (!ch || !ch.isTextBased || !ch.isTextBased() || ch.guildId !== ctx.guildId) return ctx.fail(ctx.l('Choose a text channel of this server.', 'Escolha um canal de texto deste servidor.'));
    if (!botCanPost(ctx, ch, D)) return ctx.error({ code: 'BOT_NO_PERMS' });
    await logic.setGuild(ctx.guildId, { api_channel: ch.id });
    const bot = ctx.client.user.username;
    await ctx.ok(ctx.l('🔩 API channel set', '🔩 Canal da API definido'), ctx.l(
      `API channel: <#${ch.id}>\nProtocol: \`@${bot} active <cardHash> <toId> <amount>\` · \`@${bot} bill <fromId> <toId> <amount> [time]\` · \`@${bot} paybill <billId>\` · \`@${bot} verify <id>\``,
      `Canal da API: <#${ch.id}>\nProtocolo: \`@${bot} active <hashCartão> <idDestino> <valor>\` · \`@${bot} bill <idPagador> <idRecebedor> <valor> [tempo]\` · \`@${bot} paybill <idCobrança>\` · \`@${bot} verify <id>\``));
  }
};

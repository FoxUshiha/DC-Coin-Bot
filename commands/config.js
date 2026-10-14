'use strict';
module.exports = {
  name: 'config', names: { pt: 'configurar' }, category: 'admin', guildOnly: true, perm: 'guildAdmin',
  aliases: { en: ['settings', 'setup'], pt: ['configuracao', 'ajustes'] },
  description: { en: 'Server settings: bot language, ATM and API channels', pt: 'Configurações do servidor: idioma do bot, canais do caixa e da API' },
  options: [{
    name: 'language', names: { pt: 'idioma' }, type: 'string', description: { en: 'Language of the bot in this server', pt: 'Idioma do bot neste servidor' },
    choices: [{ name: { en: 'Automatic (each user)', pt: 'Automático (cada usuário)' }, value: 'auto' }, { name: { en: 'English', pt: 'Inglês' }, value: 'en' }, { name: { en: 'Portuguese', pt: 'Português' }, value: 'pt' }]
  }],
  async run(ctx, { ui, logic }) {
    const lang = (ctx.str('language') || '').toLowerCase();
    if (lang) {
      const v = lang.startsWith('pt') ? 'pt' : lang.startsWith('en') ? 'en' : lang === 'auto' ? null : undefined;
      if (v === undefined) return ctx.fail(ctx.l('Use: `auto`, `en` or `pt`.', 'Use: `auto`, `en` ou `pt`.'));
      await logic.setGuild(ctx.guildId, { lang: v });
      if (v) ctx.lang = v;
    }
    const g = logic.getGuild(ctx.guildId);
    await ctx.send({ embeds: [ui.embed(ctx, {
      title: ctx.l('⚙️ Server settings', '⚙️ Configurações do servidor'), color: ui.COLORS.info,
      fields: [
        { name: ctx.l('🌍 Language', '🌍 Idioma'), value: g.lang ? (g.lang === 'pt' ? 'Português' : 'English') : ctx.l('Automatic', 'Automático'), inline: true },
        { name: '🏧 ATM', value: g.atm_channel ? `<#${g.atm_channel}>` : '—', inline: true },
        { name: '🔩 API', value: g.api_channel ? `<#${g.api_channel}>` : '—', inline: true },
        { name: ctx.l('💡 Tips', '💡 Dicas'), value: ctx.l('`/set` posts the ATM · `/api` sets the API channel · `/config language:` changes the language', '`/caixa` publica o caixa · `/api` define o canal da API · `/configurar idioma:` muda o idioma') }
      ]
    })] });
  }
};

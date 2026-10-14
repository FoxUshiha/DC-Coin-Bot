'use strict';
module.exports = {
  name: 'global', names: { pt: 'economia' }, category: 'economy', ephemeral: false,
  aliases: { en: ['economy', 'stats', 'network'], pt: ['estatisticas', 'rede', 'mundo'] },
  description: { en: 'Global economy statistics with network chart', pt: 'Estatísticas globais da economia com gráfico da rede' },
  async run(ctx, { ui, logic }) {
    const s = logic.stats();
    const st = logic.claimStatus(ctx.userId);
    const L = ctx.lang;
    const fields = [
      { name: ctx.l('🌐 Global balance', '🌐 Saldo global'), value: ui.coins(s.totalSats, L), inline: true },
      { name: ctx.l('💰 Your balance', '💰 Seu saldo'), value: ui.coins(logic.balance(ctx.userId), L), inline: true },
      { name: ctx.l('⏱️ Next reward', '⏱️ Próxima recompensa'), value: st.cooldownRemainingMs > 0 ? `<t:${Math.floor((Date.now() + st.cooldownRemainingMs) / 1000)}:R>` : ctx.l('🎉 NOW', '🎉 AGORA'), inline: true },
      { name: ctx.l('🏦 Servers', '🏦 Servidores'), value: String(ctx.client ? ctx.client.guilds.cache.size : 0), inline: true },
      { name: ctx.l('⭐ Users', '⭐ Usuários'), value: `${s.totalUsers} (+${s.newUsers24h} 24h)`, inline: true },
      { name: ctx.l('👥 Active 24h', '👥 Ativos 24h'), value: String(s.activeUsers24h), inline: true },
      { name: ctx.l('📖 Transactions', '📖 Transações'), value: `${s.totalTransactions} (${s.transactions24h} 24h)`, inline: true },
      { name: ctx.l('📊 Volume 24h', '📊 Volume 24h'), value: ui.coins(s.volume24hSats, L), inline: true },
      { name: ctx.l('📨 Claims', '📨 Resgates'), value: `${s.totalClaims} (${s.claims24h} 24h)`, inline: true },
      { name: ctx.l('💳 Cards · Bills', '💳 Cartões · Cobranças'), value: `${s.totalCards} · ${s.openBills}`, inline: true },
      { name: ctx.l('🎁 Reward', '🎁 Recompensa'), value: `${s.claimAmount} / ${logic.fmtDuration(s.claimCooldownMs, L)}`, inline: true },
      { name: ctx.l('🏁 Max supply', '🏁 Oferta máxima'), value: s.maxSupply ? `${s.maxSupply}` : ctx.l('Unlimited', 'Ilimitada'), inline: true }
    ];
    const e = ui.embed(ctx, { title: ctx.l('🏆 Economy information', '🏆 Informações da economia'), description: ctx.l('🪙 Official Discord Coin System', '🪙 Sistema oficial de moedas do Discord'), fields });
    const payload = { embeds: [e] };
    if (logic.canRender()) {
      try {
        const buf = await logic.networkChart({ days: 14, lang: L, format: 'png' });
        payload.files = [{ attachment: buf, name: 'network.png' }];
        e.image = { url: 'attachment://network.png' };
      } catch { /* stats only */ }
    }
    await ctx.send(payload);
  }
};

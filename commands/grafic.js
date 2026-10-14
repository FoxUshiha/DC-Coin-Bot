'use strict';
module.exports = {
  name: 'grafic', names: { pt: 'grafico' }, category: 'utility', ephemeral: false,
  aliases: { en: ['graph', 'chart', 'graphic'], pt: ['grafico', 'gráfico'] },
  description: { en: 'Your balance chart (PNG + PDF)', pt: 'Gráfico do seu saldo (PNG + PDF)' },
  options: [{ name: 'days', names: { pt: 'dias' }, type: 'integer', min: 7, max: 365, description: { en: 'Period in days (default 30)', pt: 'Período em dias (padrão 30)' } }],
  async run(ctx, { ui, logic, money }) {
    const days = Math.max(7, Math.min(365, ctx.int('days') || 30));
    const s = logic.balanceSeries(ctx.userId, days);
    const tin = s.in.reduce((a, b) => a + b, 0), tout = s.out.reduce((a, b) => a + b, 0);
    const e = ui.embed(ctx, {
      title: ctx.l(`📊 Balance — last ${days} days`, `📊 Saldo — últimos ${days} dias`),
      fields: [
        { name: ctx.l('💼 Now', '💼 Agora'), value: ui.coins(s.current, ctx.lang), inline: true },
        { name: ctx.l('📥 In', '📥 Entradas'), value: ui.coins(tin, ctx.lang), inline: true },
        { name: ctx.l('📤 Out', '📤 Saídas'), value: ui.coins(tout, ctx.lang), inline: true },
        { name: ctx.l('⬆️ Max', '⬆️ Máximo'), value: money.pretty(Math.max(...s.balances), ctx.lang), inline: true },
        { name: ctx.l('⬇️ Min', '⬇️ Mínimo'), value: money.pretty(Math.min(...s.balances), ctx.lang), inline: true }
      ],
      color: ui.COLORS.info
    });
    const payload = { embeds: [e], components: [ui.row(ui.btn(`cb:graph:pdf:${ctx.userId}:${days}`, 'PDF', 2, '📄'))] };
    if (logic.canRender()) {
      const name = `balance-${ctx.userId}.png`;
      payload.files = [{ attachment: await logic.userChart(ctx.userId, { days, lang: ctx.lang, format: 'png', name: ctx.user.username }), name }];
      e.image = { url: `attachment://${name}` };
    } else payload.components = [];
    await ctx.send(payload);
  }
};

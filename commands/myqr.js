'use strict';
module.exports = {
  name: 'myqr', names: { pt: 'meuqr' }, category: 'economy',
  aliases: { en: ['receive', 'mycode'], pt: ['meucodigo', 'receberqr'] },
  description: { en: 'Your permanent "send me coins" QR code', pt: 'Seu QR code fixo de "me envie coins"' },
  options: [{ name: 'amount', names: { pt: 'valor' }, type: 'string', maxLength: 24, description: { en: 'Suggested amount (optional)', pt: 'Valor sugerido (opcional)' } }],
  async run(ctx, { ui, logic }) {
    const info = logic.userPayInfo(ctx.userId, ctx.str('amount') || undefined);
    const e = ui.embed(ctx, {
      title: ctx.l('📥 Your receive QR', '📥 Seu QR para receber'),
      description: `${info.amountSats ? `# ${logic.money.pretty(info.amountSats, ctx.lang)} coins\n` : ''}${ctx.l('Anyone can scan it with the Coin Bank app or the phone camera to send you coins.', 'Qualquer pessoa pode escanear com o app Coin Bank ou a câmera do celular para te enviar coins.')}`,
      fields: [{ name: '🆔 ID', value: ui.code(ctx.userId), inline: true }, { name: '🔗 Link', value: info.url }]
    });
    const payload = { embeds: [e], components: /^https?:/.test(info.url) ? [ui.row(ui.linkBtn(info.url, ctx.l('Open link', 'Abrir link'), '🌐'))] : [] };
    if (logic.canRender()) {
      payload.files = [{ attachment: await logic.userQr(ctx.userId, { amount: info.amount || undefined, lang: ctx.lang }), name: 'my-qr.png' }];
      e.image = { url: 'attachment://my-qr.png' };
    }
    await ctx.send(payload);
  }
};

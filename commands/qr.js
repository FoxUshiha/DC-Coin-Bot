'use strict';
module.exports = {
  name: 'qr', names: { pt: 'cobrarqr' }, category: 'economy', ephemeral: false,
  aliases: { en: ['payqr', 'request', 'charge'], pt: ['qrcode', 'pedido', 'receber'] },
  description: { en: 'Creates a payment QR code (scan & pay on the app, site or Discord)', pt: 'Cria um QR code de pagamento (escaneie e pague no app, site ou Discord)' },
  options: [
    { name: 'amount', names: { pt: 'valor' }, type: 'string', maxLength: 24, description: { en: 'Amount in coins (empty = payer chooses)', pt: 'Valor em coins (vazio = quem paga escolhe)' } },
    { name: 'memo', names: { pt: 'descricao' }, type: 'string', maxLength: 140, description: { en: 'Description shown to the payer', pt: 'Descrição mostrada a quem paga' } },
    { name: 'expires', names: { pt: 'validade' }, type: 'string', maxLength: 8, description: { en: 'Lifetime: 10m, 1h, 1d, 30d (default 1d)', pt: 'Validade: 10m, 1h, 1d, 30d (padrão 1d)' } },
    { name: 'reusable', names: { pt: 'reutilizavel' }, type: 'boolean', description: { en: 'Stay open after each payment (shop counter QR)', pt: 'Continua aberto após cada pagamento (QR de balcão)' } }
  ],
  textArgs: ['amount', 'memo'],
  async run(ctx, { ui, logic, money }) {
    let amount = ctx.str('amount') || undefined;
    let memo = ctx.str('memo') || undefined;
    if (!ctx.isSlash) { // "@Bot qr 0.5 coffee and cake"
      if (amount && money.parse(amount) === null) { memo = ctx.args.join(' '); amount = undefined; } else memo = ctx.args.slice(1).join(' ') || undefined;
    }
    const raw = ctx.raw('reusable');
    const r = await logic.createPayRequest(ctx.userId, { amount, memo, expires: ctx.str('expires') || undefined, reusable: raw === true || raw === 'true' });
    await ctx.send(await ui.payRequestPayload(ctx, r.request, { title: ctx.l('📲 Payment QR created', '📲 QR de pagamento criado') }));
  }
};

'use strict';
module.exports = {
  name: 'remind', names: { pt: 'lembrar' }, category: 'staff', perm: 'staff',
  aliases: { en: ['reminder'], pt: ['lembrete'] },
  description: { en: 'Sends a reward reminder (with claim button) to a user', pt: 'Envia um lembrete de recompensa (com botão de resgate) para um usuário' },
  options: [{ name: 'user', names: { pt: 'usuario' }, type: 'user', required: true, description: { en: 'User to remind', pt: 'Usuário a lembrar' } }],
  async run(ctx, { ui, logic }) {
    const target = await ctx.userObj('user');
    if (!target || target.bot) return ctx.error({ code: 'UNKNOWN_USER' });
    const st = logic.claimStatus(target.id);
    const p = logic.dmEmbed({
      titleEn: '🎁 You have a reward available!', titlePt: '🎁 Você tem uma recompensa disponível!', color: ui.COLORS.primary,
      en: [`Click **Claim** below to receive **${st.claimAmount}** coins.`], pt: [`Clique em **Resgatar** abaixo para receber **${st.claimAmount}** coins.`]
    });
    p.embeds[0].thumbnail = { url: ctx.avatar };
    p.components = [ui.row(ui.btn('cb:claim', 'Claim · Resgatar', 3, '🎁'))];
    try { await target.send(p); } catch { return ctx.fail(ctx.l('⚠️ I could not DM that user (DMs closed).', '⚠️ Não consegui enviar DM para esse usuário (privado fechado).')); }
    await ctx.ok(ctx.l('✅ Reminder sent', '✅ Lembrete enviado'), `${target.username} (${ui.code(target.id)})`);
  }
};

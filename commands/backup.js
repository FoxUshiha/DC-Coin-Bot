'use strict';
module.exports = {
  name: 'backup', names: { pt: 'backup' }, category: 'account',
  aliases: { en: ['backupcodes'], pt: ['copia', 'cópia', 'codigos'] },
  description: { en: 'Creates wallet backup codes (restore your coins on another account)', pt: 'Cria códigos de backup da carteira (restaure seus coins em outra conta)' },
  async run(ctx, { ui, logic }) {
    const codes = await logic.createBackups(ctx.userId);
    const list = codes.map((c, i) => `\`${String(i + 1).padStart(2, '0')}\` ||\`${c}\`||`).join('\n');
    const e = ui.embed(ctx, {
      title: ctx.l('🔒 Your wallet backup codes', '🔒 Seus códigos de backup da carteira'), color: ui.COLORS.purple,
      description: `${ctx.l('Your balance was **not** changed. Each code can be used **once** on another account with `/restore` to move your whole balance there.', 'Seu saldo **não** foi alterado. Cada código pode ser usado **uma vez** em outra conta com `/restaurar` para mover todo o saldo para lá.')}\n\n${list}\n\n⚠️ ${ctx.l('Keep them secret.', 'Guarde-os em segredo.')}`
    });
    const file = { attachment: Buffer.from(codes.join('\n') + '\n'), name: `backup-codes-${ctx.userId}.txt` };
    await ctx.sendPrivate({ embeds: [e], files: [file] });
    if (ctx.isSlash) logic.enqueueDM(ctx.userId, { embeds: [e] }); // keep a copy in the DMs (like before)
  }
};

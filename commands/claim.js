'use strict';
module.exports = {
  name: 'claim', names: { pt: 'resgatar' }, category: 'rewards', ephemeral: false,
  aliases: { en: ['daily', 'reward', 'collect'], pt: ['recompensa', 'diario', 'coletar'] },
  description: { en: 'Claims your periodic coin reward', pt: 'Resgata sua recompensa periódica de coins' },
  async run(ctx, { ui, logic }) {
    const r = await logic.claim(ctx.userId, { source: 'discord' });
    await ctx.send(ui.claimPayload(ctx, r));
  }
};

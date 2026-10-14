'use strict';
module.exports = {
  name: 'staff', names: { pt: 'equipe' }, category: 'staff', perm: 'owner',
  aliases: { en: ['team'], pt: ['moderadores'] },
  description: { en: 'Manages the bot staff (owners only)', pt: 'Gerencia a equipe do bot (somente donos)' },
  options: [
    { name: 'action', names: { pt: 'acao' }, type: 'string', required: true, description: { en: 'What to do', pt: 'O que fazer' },
      choices: [{ name: { en: 'List', pt: 'Listar' }, value: 'list' }, { name: { en: 'Add', pt: 'Adicionar' }, value: 'add' }, { name: { en: 'Remove', pt: 'Remover' }, value: 'remove' }] },
    { name: 'user', names: { pt: 'usuario' }, type: 'user', description: { en: 'Staff member', pt: 'Membro da equipe' } }
  ],
  async run(ctx, { ui, logic }) {
    const action = (ctx.str('action') || 'list').toLowerCase();
    const map = { listar: 'list', adicionar: 'add', add: 'add', remover: 'remove', remove: 'remove', list: 'list' };
    const act = map[action] || 'list';
    if (act !== 'list') {
      const id = ctx.targetId('user');
      if (!id) return ctx.fail(ctx.l('Mention a user or give an ID.', 'Mencione um usuário ou informe um ID.'));
      if (act === 'add') await logic.addStaff(id, ctx.userId); else await logic.removeStaff(id);
    }
    const s = logic.listStaff();
    await ctx.send({ embeds: [ui.embed(ctx, {
      title: ctx.l('🛡️ Bot staff', '🛡️ Equipe do bot'), color: ui.COLORS.info,
      fields: [
        { name: ctx.l('👑 Owners (config.yml)', '👑 Donos (config.yml)'), value: ctx.cfg.discord.owners.map((x) => `<@${x}>`).join(', ') || '—' },
        { name: ctx.l('📄 Staff (config.yml)', '📄 Equipe (config.yml)'), value: s.config.map((x) => `<@${x}>`).join(', ') || '—' },
        { name: ctx.l('⚡ Staff (runtime)', '⚡ Equipe (em execução)'), value: s.runtime.map((x) => `<@${x.user_id}>`).join(', ') || '—' }
      ]
    })] });
  }
};

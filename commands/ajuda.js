'use strict';
/** /ajuda — menu de ajuda em português (também @Bot ajuda). */
const help = require('./help');
module.exports = {
  name: 'ajuda', lang: 'pt', category: 'utility',
  aliases: { en: [], pt: ['comandos', 'socorro'] },
  description: { en: 'Shows every command (Portuguese)', pt: 'Mostra todos os comandos (português)' },
  async run(ctx, { ui }) { await ctx.send(help.build(ctx, ui)); }
};

'use strict';
module.exports = {
  name: 'status', names: { pt: 'estado' }, category: 'staff', perm: 'staff',
  aliases: { en: ['system', 'ping', 'health'], pt: ['sistema', 'saude'] },
  description: { en: 'System status: uptime, memory, database, queues (staff)', pt: 'Estado do sistema: uptime, memória, banco, filas (equipe)' },
  async run(ctx, { ui, logic }) {
    const mem = require('../lib/memory').stats();
    const dbi = logic.dbInfo();
    const dm = logic.dmStats();
    let api = null; try { api = require('../api').metrics; } catch {}
    const up = logic.fmtDuration(process.uptime() * 1000, ctx.lang);
    await ctx.send({ embeds: [ui.embed(ctx, {
      title: ctx.l('🖥️ System status', '🖥️ Estado do sistema'), color: ui.COLORS.dark,
      fields: [
        { name: '⏱️ Uptime', value: up, inline: true },
        { name: '📡 Ping', value: `${ctx.client.ws.ping} ms`, inline: true },
        { name: ctx.l('🏦 Servers', '🏦 Servidores'), value: String(ctx.client.guilds.cache.size), inline: true },
        { name: '🧠 RAM', value: `RSS ${mem.rssMB} MB\nHeap ${mem.heapUsedMB}/${mem.heapTotalMB} MB\nGC ${mem.gc ? '✅' : '❌'}`, inline: true },
        { name: '🗄️ DB', value: `${dbi.driver}\n${ctx.l('queue', 'fila')} ${dbi.queue} · ${ctx.l('batches', 'lotes')} ${dbi.writes.batches}\nops ${dbi.writes.ops} · ${dbi.writes.lastMs.toFixed(1)} ms`, inline: true },
        { name: '📨 DM', value: `${dm.running ? '🟢' : '🔴'} ${ctx.l('pending', 'pendentes')} ${dm.pending}\n${ctx.l('sent', 'enviadas')} ${dm.sent} · ${ctx.l('failed', 'falhas')} ${dm.failed}`, inline: true },
        ...(api ? [{ name: '🌐 API', value: `req ${api.requests} · 2xx ${api.s2xx} · 4xx ${api.s4xx} · 5xx ${api.s5xx}\n429 ${api.rateLimited} · ${ctx.l('queue full', 'fila cheia')} ${api.queueFull}` }] : []),
        { name: '⚙️ Node', value: `${process.version} · ${process.platform}/${process.arch}`, inline: true }
      ]
    })] });
  }
};

<h1 align="center">🏦 Coin Bank 2.0</h1>
<p align="center"><img src="assets/logo.png" height="180"></p>

<p align="center">
Bitcoin-like digital coin <b>with no real-world value</b> · public REST API · website · own payment cards · bilingual (EN/PT) Discord bot<br>
Moeda digital estilo Bitcoin <b>sem valor real</b> · API REST pública · site · cartões próprios · bot do Discord bilíngue (EN/PT)
</p>

---

## 🇧🇷 Português

### O que tem
| Módulo | Função |
|---|---|
| `index.js` | Entrada principal. Funciona com `node index.js`, `require('./index.js')` e `import bank from './index.js'` / `index.mjs`. |
| `database.js` | **Único** módulo que acessa o disco (SQLite). Fila de escrita assíncrona com *group commit*, caches LRU, migração automática do banco antigo, limpeza periódica, backups, auditoria do livro-razão. |
| `logic.js` | Toda a lógica: contas, sessões 24h, transferências, resgates, cobranças, cartões, backups, estatísticas, **fila de DMs**, **gráficos** e **comprovantes PNG/PDF**. |
| `api.js` | Servidor HTTP (node:http puro) com todos os endpoints antigos + os que o site novo precisava, fila justa, rate limit, compressão, Cloudflare. |
| `bot.js` | Bot do Discord: comandos **somente globais** (servidores + DM), respostas imediatas ("pensando…"), comandos por menção, embeds com o avatar do bot. |
| `commands/` | 27 comandos, todos com nome/descrição em inglês e português. |
| `lib/` | config.yml, dinheiro em inteiros, cache, QR code, otimizador de memória, túneis Cloudflare, textos. |
| `site/` | Site (index.html), comprovante público (`/tx/:id`), termos, privacidade e documentação da API. |

### Instalação
```bash
npm install            # instala discord.js, yaml, better-sqlite3 e sharp
# edite config.yml (token, client_id, owners...)
npm start              # ou: node index.js  |  start.bat (Windows)  |  ./start.sh (Linux)
```
* **Node 20+** (Node 22.13+ recomendado). Se o `better-sqlite3` não instalar, o sistema usa automaticamente o SQLite embutido do Node 22 (`node:sqlite`).
* `sharp` gera os PNG/PDF de comprovantes e gráficos. Sem ele tudo funciona, só sem imagens.
* **Não usa mais `.env`.** Na primeira execução o `config.yml` é criado e, se existir um `.env` antigo, os valores (token, client id, admin, AMOUNT, WAIT, porta, Cloudflare) são importados.
* O banco antigo (`playerList/database.db`) é migrado sozinho: saldos, cartões, cobranças e backups são mantidos; senhas antigas (sha256) viram *scrypt* no próximo login; as sessões antigas expiram (é preciso logar de novo).

### Discord
* No Developer Portal: escopos `bot` + `applications.commands`. Nenhuma intent privilegiada é necessária (comandos por menção funcionam sem *Message Content*). Ative "Server Members" só se usar `welcome_new_members`.
* Os comandos são registrados **apenas globalmente** e as cópias antigas por servidor são apagadas (uma vez por servidor).
* Todos os comandos funcionam como `/comando` ou `@Bot comando argumentos` (no privado do bot não precisa mencionar). Aliases em português: `@Bot saldo`, `@Bot pagar @user 0.5`, `@Bot extrato`…
* Configuração: dono do servidor / admins (`/set`, `/api`, `/config`), **staff** (configura qualquer servidor, `/remind`, `/status`) e **donos do bot** (`/staff`). Donos e staff ficam no `config.yml` (e o dono pode adicionar staff em tempo real com `/staff`).
* A fila de DMs só roda com o bot online; se o bot estiver desativado/inacessível ela fica parada e volta sozinha quando ele conectar.

### Pagamentos por QR (app de celular)
* `POST /api/pay/request` cria um QR de cobrança (valor fixo ou livre, descrição, validade, reutilizável para balcão).
* Quem paga escaneia → `POST /api/pay/scan` diz o que é → `POST /api/pay/request/:id/pay`. Pagamento e baixa do pedido acontecem na mesma transação: um QR de uso único nunca é pago duas vezes.
* Cabeçalho `Idempotency-Key`: se a rede do celular repetir a requisição, o pagamento não é feito de novo.
* `GET /api/pay/request/:id?wait=25&since=N` (long-poll): a tela de quem recebe atualiza na hora em que o pagamento cai.
* QR fixo de usuário ("me envie coins"): `/api/pay/me`, imagens prontas em `/api/pay/request/:id/qr.png` e `/api/qr/user/:id.png`.
* Página web `/pay/<id>` e `/pay/u/<id>`: o QR funciona até sem o app (abre na câmera do celular). No Discord: `/qr` (cobrar) e `/myqr` (receber).
* Guia completo: `/terms/documentation.html#app`.

### Dinheiro sem ponto flutuante
Todo saldo é um **inteiro de sats** (1 coin = 100.000.000 sats) no banco, na API e internamente. A conversão para texto usa só divisão inteira, e cada transferência é um único `UPDATE ... WHERE coins >= ?` + registro no livro-razão dentro da mesma transação. A cada 30 min o sistema confere `SOMA(saldos) == total emitido`.

### Segurança
Senhas com *scrypt* + salt, tokens de sessão aleatórios (o banco guarda só o SHA-256), sessões de 24h, bloqueio de IP após erros de login/cartão, limite de criação de contas por IP e por dispositivo, corpo máximo de 16 KB, cabeçalhos de segurança, proteção contra *path traversal*. IPs ficam só em memória; para o limite de contas é guardado apenas um HMAC irreversível por até 24h.

### Cloudflare
Com `cloudflare.enabled: true` o IP real vem do `CF-Connecting-IP` **apenas** se a conexão vier da Cloudflare (faixas oficiais) ou do `cloudflared` na mesma máquina. Túnel nomeado e túnel rápido (trycloudflare) são ligados pelo `config.yml` (veja `cloudflared/README.txt`).

### Desempenho (medido, honesto)
Teste local (cliente e servidor na mesma máquina, 1 processo, SQLite embutido):
| Operação | Resultado |
|---|---|
| `GET /api/stats` (cache) | ~18.800 req/s |
| `GET` saldo autenticado | ~18.500 req/s |
| `POST /api/transfer` (escrita real no banco, atômica) | ~9.600 req/s |
| Operações internas no banco (lote/group commit) | ~100.000 op/s |
| RAM do processo (API + banco, após 110 mil requisições) | ~60 MB após GC, pico ~170 MB |

* Acima da capacidade, as requisições **esperam numa fila justa** (pequeno atraso) em vez de travar ou dar erro.
* "10 milhões de operações por segundo" num único processo Node não é fisicamente realista. Para ir além: Cloudflare na frente (cache das páginas estáticas), CPU mais forte e/ou várias instâncias.
* O bot usa caches mínimos do discord.js + otimizador de memória (com ou sem `--expose-gc`), ficando bem abaixo de 500 MB mesmo com milhares de servidores. `npm start` já usa `--expose-gc --max-old-space-size=384`.

---

## 🇺🇸 English

### Quick start
```bash
npm install
# edit config.yml (discord.token, discord.client_id, discord.owners ...)
npm start            # node index.js | start.bat | ./start.sh
```

### Using it as a module
```js
// CommonJS
const bank = require('./index.js');          // autostarts unless system.autostart: false
await bank.ready;
bank.logic.stats();

// ES modules
import bank, { start, stop } from './index.mjs';
await start({ overrides: { api: { port: 8080 } } });
```
Set `system.autostart: false` (or env `COIN_BANK_NO_AUTOSTART=1`) to start manually.

### Architecture
`config.yml → lib/memory → database.js → logic.js → api.js → bot.js → tunnels`
* **database.js** is the only module touching the disk: async group-commit write queue (each op in its own SAVEPOINT), write-through LRU caches, automatic migration of the old database, chunked retention cleanup, WAL checkpoints, online backups, ledger audit.
* **logic.js** holds all business rules, the DM outbox (active only while the bot is online), balance/network charts and PNG/PDF receipts with QR verification.
* **api.js** keeps every legacy endpoint and adds the ones the new website needed: `/api/stats`, `/api/stats/history`, `/api/stats/recent`, `/tx/:id`, receipts, charts, `/api/me`, `/api/bill/:id`. Full reference: `site/terms/documentation.html` (served at `/terms/documentation.html`).
* **bot.js**: global-only slash commands (servers + DMs), per-guild copies purged, defer-first interactions (never "interaction failed"), `@Bot command` mentions with EN/PT aliases, embeds with the bot avatar thumbnail, API text protocol (`active`, `bill`, `paybill`, `verify`) kept for other bots.

### Folder layout
```
index.js · index.mjs · config.yml · database.js · logic.js · api.js · bot.js
commands/   27 bilingual commands
lib/        config, yaml, money, cache, qr, memory, tunnel, i18n, botui
site/       index.html, tx.html, pay.html (QR payments), terms/{terms,privacy,documentation}.html, icons
assets/     icon.png (receipts / charts), logo.png
cloudflared/  put the cloudflared binary + tunnel credentials here
playerList/ database.db (+ backups/) — created automatically
```

### License
Public domain (Unlicense) — see `LICENSE.txt`. System developed by FoxOficial.

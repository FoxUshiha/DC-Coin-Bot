Cloudflare Tunnel folder / Pasta do Cloudflare Tunnel
=====================================================

EN
1. Download cloudflared from https://github.com/cloudflare/cloudflared/releases and put the
   binary here (e.g. cloudflared-windows-amd64.exe, cloudflared-linux-amd64 or cloudflared).
2. Named tunnel (your own domain):
     cloudflared tunnel login
     cloudflared tunnel create coin-bot
     cloudflared tunnel route dns coin-bot coin.your-domain.com
   Copy the generated <id>.json (and cert.pem) into this folder, then in config.yml:
     cloudflare.tunnel.enabled: true / name / hostname / credentials
   Coin Bank writes ./cloudflared/config.yml automatically if it does not exist.
3. Free random URL (no account): config.yml → cloudflare.quick_tunnel.enabled: true
On Windows you can double-click cloudflared_console.bat to get a terminal with cloudflared in PATH.

PT
1. Baixe o cloudflared em https://github.com/cloudflare/cloudflared/releases e coloque o binário aqui.
2. Túnel nomeado (domínio próprio): rode os comandos acima, copie o <id>.json (e cert.pem) para esta
   pasta e ative cloudflare.tunnel no config.yml. O config.yml do cloudflared é criado automaticamente.
3. URL aleatória grátis: cloudflare.quick_tunnel.enabled: true
No Windows, dê dois cliques em cloudflared_console.bat para abrir um terminal com o cloudflared no PATH.

With Cloudflare in front, Coin Bank reads the real visitor IP from CF-Connecting-IP (only when the
request really comes from Cloudflare or from cloudflared on this machine) for rate limits.

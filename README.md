<h1 align="center">

<img src="logo.png" height="300">

  [Coin](https://discord.com/oauth2/authorize?client_id=1391067775077978214) - Best Economy System!
</h1>
  <br><br>

--------

# :memo: Requirements

  - [Node.JS](https://nodejs.org/en/download/)
  - [Git(Optional)](https://git-scm.com/downloads)
  - [CloudFlare(Optional)](https://github.com/cloudflare/cloudflared/releases)

# :computer: Install instructions

  1. Clone this repository
   ```
   git clone https://github.com/FoxUshiha/DC-Coin-Bot
   cd DC-coin-bot
   ```
  
  2. Install dependecies
  ```
  npm install
  npm install discord.js sqlite3 p-queue uuid node-fetch fs-extra yaml dotenv qrcode express better-sqlite3 fs-extra chartjs-node-canvas
  ```

  3. Create a application
       - Go to https://discord.com/developers/applications/
       - Create an application
       - In the OAuth2 section copy your client id
       - Still in the OAuth2 section, mark the `bot` check and scroll down to Bot Permissions and check `Send Messages` and scroll down again to get its link
       - In the bot section click on `RESET TOKEN` and copy it

  4. Paste the token
       - Go to the .env file and paste your token and ID like this
        ```
          DISCORD_TOKEN=YOUR_BOT_TOKEN
          CLIENT_ID=YOUR_CLIENT_ID
        ```

       - Go to the api.js and change the port number in:
         ```
           const port = process.env.API_PORT || 26450;  <<< // Change the port here
             app.listen(port, () => {
               console.log(`API REST rodando na porta ${port}`);
            });
           }
         ```

  5. Start the bot
      ```
        npm start
      ```
      or
      ```
        node index.js
      ```

      Defaults:
      ```
      API Port: 26450
      Discord bot: https://discord.com/oauth2/authorize?client_id=1391067775077978214
      API Online: http://coin.foxsrv.net:26450/
      ```

- How to setup the cloudflare tunnel (you will need to enable this in .env and buy a domain in cloudflare);

Please put the Cloudflare binary file in the cloudflared folder of the project!
Download here: https://github.com/cloudflare/cloudflared/releases

If you are using linux:

Go to the cloudflared folder and execute:
```
bash

cloudflared tunnel login

cloudflared login
```
If you are using Windows, open PowerShell as admin inside the cloudflared folder and execute:
```
cloudflared tunnel login

cloudflared login
```
Create the json config "coin-bot.json":
```
cloudflared tunnel --config=coin-bot.json run
```
Put those files renamed as coin-bot.json and cert.perm in the cloudflared folder.

And before start the project, use...

Create a tunnel:
```
cloudflared tunnel create tunnel_name
```
Edit the config.yml of cloudflared folder to use your domain setup:
```
tunnel: tunnel-name
credentials-file: ./coin-bot.json   # ou o nome do .json que você tem
origincert: ./cert.pem

ingress:
  - hostname: coin.your_domain.me
    service: http://localhost:26450
  - service: http_status:404

```
When those files are created, the prompt returns the file location for you to seach UwO

All the times you run those commands, the console will show you where the files appear, and you need to go there to copy them and paste in the cloudflared folder of the project.
You will need to rename the files as your config.yml is listening.

Finished, you now has SSL secured API URL and site hosted :D

Or you can use a random URL only to host a SSL secured URL without your own domain (free):
```
# .env file:

TEMP_TUNNEL_ENABLED=true < leave this on (true)
TEMP_TUNNEL_PORT=3000 < change the port for the port you use
TEMP_TUNNEL_LOCAL_HOST=127.0.0.1 < leave this like this or 0.0.0.0

```


      Here is the configurations:

```
###########################################
# DISCORD CONFIGURATION
###########################################
DISCORD_TOKEN=your_bot_token
CLIENT_ID=000000000000

###########################################
# ECONOMY CONFIGURATION
###########################################
AMOUNT=1.00000000
WAIT=10000

###########################################
# API QUEUE CONFIGURATION
###########################################

# Máximo de bytes armazenados na fila (default: 512 KB)
QUEUE_MAX_BYTES=524288

# Máximo de operações que a fila aceita por segundo (default: 500)
QUEUE_MAX_OPS=1000

# Tempo máximo que o cliente pode ficar aguardando o processamento da fila (default: 30000 ms)
QUEUE_WAIT_TIMEOUT_MS=30000

# Tempo que o resultado de uma operação fica armazenado (default: 24h)
QUEUE_RESULT_TTL_MS=60000

# Velocidade do tick do worker da fila (default: 250 ms)
QUEUE_TICK_MS=10


###########################################
# CACHE CONFIGURATION
###########################################

# Ativar/desativar cache (true para ativado | false para desativado)
# Default do código = true ("ativado")
CACHE_ENABLED=true

# Máximo de operações total no cache (default: 20000)
CACHE_MAX_TOTAL_OPS=10000

# Máximo de operações por IP (default: 2000)
CACHE_MAX_PER_IP=20

# Intervalo entre flushes do cache para a fila (default: 200ms)
CACHE_FLUSH_INTERVAL_MS=10

# Quantidade máxima de operações movidas do cache para a fila em cada flush (default: 50)
CACHE_FLUSH_BATCH=500


###########################################
# OVERLOAD THRESHOLDS
###########################################

# Percentual de uso da fila que define "sobrecarga" (default: 0.70)
QUEUE_HIGH_WATERMARK_PCT=0.70

# Percentual de uso da fila que define "crítico" (default: 0.90)
QUEUE_CRITICAL_WATERMARK_PCT=0.90


###########################################
# RATE LIMITING (TOKEN BUCKET)
###########################################

# Tokens por segundo por IP (default: 10)
RATE_LIMIT_PER_IP=10

# Quantidade de tokens máxima que um IP pode acumular (burst) (default: 10)
RATE_LIMIT_BURST=10


###########################################
# MISC
###########################################

# Tamanho máximo permitido para o JSON do body (default: "1mb")
REQUEST_BODY_LIMIT=1mb

###########################################
# TUNNEL
###########################################

CLOUDFLARE_ENABLED=true
CLOUDFLARE_TUNNEL_NAME=coin-bot
CLOUDFLARE_HOSTNAME=coin.your_domain.me
CLOUDFLARE_CREDENTIALS=cloudflared/coin-bot.json
PORT=26450

LT_LOCAL_HOST=127.0.0.1
API_PORT=26450

###########################################
# TEMP TUNNEL
###########################################

TEMP_TUNNEL_ENABLED=true
TEMP_TUNNEL_PORT=26450
TEMP_TUNNEL_LOCAL_HOST=127.0.0.1

```

------
<h1 align="center">

[![License: CC0-1.0](https://img.shields.io/badge/License-CC0%201.0-lightgrey.svg)](http://creativecommons.org/publicdomain/zero/1.0/)

</h1>

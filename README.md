# Telegram Shop (Mini App)

Node.js + Express + Turso/libSQL. One project, no build step.

## Local run
1. Install Node.js 20 LTS from nodejs.org
2. `npm install`
3. Copy `.env.example` to `.env` and fill in the Telegram and Turso credentials
4. For local browser testing set `DEV_MODE=true` (then open http://localhost:3000 and http://localhost:3000/admin). Set it to `false` in production!
5. `npm start`

## Bot setup
- Create a bot with @BotFather, put the token in `TELEGRAM_BOT_TOKEN`
- Get your own Telegram ID from @userinfobot -> `SUPER_ADMIN_TELEGRAM_ID`
- Put your public https URL in `TELEGRAM_MINI_APP_URL` (the server registers the webhook automatically on start)

## Deploy on Render
1. Push this folder to GitHub (`.env`, `database.db`, `node_modules` are git-ignored)
2. Render -> New -> Web Service -> pick the repo
3. Build command: `npm install` | Start command: `npm start`
4. Environment: add the variables from `.env.example` and `NODE_VERSION=20`
5. Set `TELEGRAM_MINI_APP_URL` to your Render URL, redeploy, send `/start` to your bot

Turso stores the database remotely, so the app does not need a local database disk. Render's free disk is
wiped on every redeploy; mount a Persistent Disk at the app's `uploads/` directory if payment proofs must persist.

## Admin
Send /start to the bot as the super admin: an extra "⚙️ Admin Panel" button appears.
Stock: one row = one item; manual entry uses commas to split columns; XLSX uses columns as-is.

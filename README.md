# MFEA Discord Bot

This project contains a Vercel serverless API and Discord bot commands for running the **Market Financial Evaluation Assistant (MFEA)**.  It exposes `/api` endpoints used by the bot and cron jobs that send updates via a Discord webhook.

## Prerequisites
- **Node.js 18+** – install from [nodejs.org](https://nodejs.org/) or use `nvm`.
- A Discord application with a bot user.

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file (or otherwise provide environment variables) with at least:
   - `DISCORD_BOT_TOKEN` – bot token used to register slash commands.
   - `BOT_TOKEN` – token used by the API when editing deferred responses.
   - `APPLICATION_ID` – your Discord application ID.
   - `PUBLIC_KEY` – the application's public key for request verification.
   - `DISCORD_WEBHOOK_URL` – webhook URL for allocation updates.
   - Optional: `STATE_FILE` to override where the last allocation is stored.

   Variables `PUBLIC_KEY` and `BOT_TOKEN` are required by `api/index.js` when verifying incoming interaction requests and when patching messages:
   ```javascript
   if (!process.env.PUBLIC_KEY) {
     console.error("PUBLIC_KEY missing");
     return res.status(500).json({ error: "Internal server configuration error." });
   }
   ...
   if (!process.env.BOT_TOKEN) {
     console.error("BOT_TOKEN not set: cannot edit deferred message.");
     return;
   }
   ```

3. Register the bot's commands with Discord:
   ```bash
   node register-commands.js
   ```
   This script reads `DISCORD_BOT_TOKEN` and `APPLICATION_ID` to push commands:
   ```javascript
   const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
   await rest.put(
     Routes.applicationCommands(process.env.APPLICATION_ID),
     { body: commands }
   );
   ```

## Running locally
Use the Vercel CLI to run the API and static page locally:
```bash
npx vercel dev
```
Visit `http://localhost:3000` to access `index.html` or hit endpoints like `/api/mfea`.

## Cron routes on Vercel
The deployment defines scheduled functions in `vercel.json`:
```json
{
  "crons": [
    { "path": "/api/daily-update", "schedule": "0 19 * * 1-5" },
    { "path": "/api/test-update", "schedule": "30 14 * * 1-5" }
  ]
}
```
These trigger the functions under `api/` at the specified UTC times.  When executed they call `checkAllocation` in `allocationCron.js`, which posts to `DISCORD_WEBHOOK_URL`:
```javascript
if (process.env.DISCORD_WEBHOOK_URL) {
  await axios.post(process.env.DISCORD_WEBHOOK_URL, {
    content: `**${title}**\n${message}`,
  });
}
```

## Example usage
Once the commands are registered you can interact with your bot in Discord:
- `/hi` – replies with a simple greeting.
- `/check` – returns the MFEA status and recommended allocation.
- `/ticker symbol:<SYMBOL> timeframe:<1d|1mo|1y|3y|10y>` – fetch chart data for a ticker.
- `/test` – manually trigger an allocation update check.

Running the project locally with `vercel dev` lets you hit these commands through Discord when the bot is online and the environment variables are set.

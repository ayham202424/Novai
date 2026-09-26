# Novai Backend (Phase 1: `/grant-access`)

A single Node.js service that runs:
- an **Express API** that the Roblox Studio plugin talks to (`/license-status`, `/request-access`)
- a **Discord bot** with one admin command, `/grant-access`, to grant a Roblox user
  access to the plugin for a chosen number of days

Both run in the same process and share the same data file, so there's no extra
networking between "bot" and "backend" to misconfigure.

---

## 1. Create the Discord Application & Bot

1. Go to https://discord.com/developers/applications → **New Application** → give it a name (e.g. `Novai Admin`).
2. Open the **Bot** tab → **Reset Token** → copy it. This is your `DISCORD_TOKEN`. Keep it secret.
3. Still on the **Bot** tab: you do **not** need to enable any privileged intents (Message Content, Presence, etc.) — slash commands don't need them.
4. Go to **OAuth2 → General** → copy the **Client ID**. This is your `DISCORD_CLIENT_ID`.

## 2. Invite the bot to your server

1. Go to **OAuth2 → URL Generator**.
2. Scopes: check `bot` and `applications.commands`.
3. Bot permissions: no special permissions are required (the command uses Discord's
   built-in "Administrator-only" restriction instead — see step 4 below). You can leave
   permissions at `0`, or check `Administrator` if you prefer.
4. Copy the generated URL, open it in your browser, and add the bot to your server.

## 3. Collect the remaining IDs

1. In Discord: **User Settings → Advanced → Developer Mode → ON**.
2. Right-click your server icon → **Copy Server ID** → this is `DISCORD_GUILD_ID`.
3. Right-click your own username → **Copy User ID** → put it in `ADMIN_DISCORD_IDS`
   (comma-separate if you want to allow more than one person).

## 4. Configure the project

```bash
cp .env.example .env
```

Fill in every value in `.env`:

| Variable            | Where it comes from                                             |
|---------------------|-------------------------------------------------------------------|
| `DISCORD_TOKEN`     | Step 1.2                                                          |
| `DISCORD_CLIENT_ID` | Step 1.4                                                          |
| `DISCORD_GUILD_ID`  | Step 3.2                                                          |
| `ADMIN_DISCORD_IDS` | Step 3.3                                                          |
| `PLUGIN_API_KEY`    | Make up any long random string — this replaces the old exposed key |
| `PORT`              | Leave as `3000` locally; Railway sets this automatically         |
| `DB_PATH`           | Leave as-is locally; see Railway notes below for production      |

## 5. Run it locally

```bash
npm install
npm start
```

You should see, in order:

```
[STEP] [bootstrap] Starting Novai backend...
[OK]   [server] API server listening on port 3000
[OK]   [discordClient] Logged in as YourBotName#1234
[STEP] [deployCommands] Registering 1 command(s) to guild ...
[OK]   [deployCommands] Registered: /grant-access
```

If anything is missing or wrong, the log line tells you exactly which step
and which scope failed — that's the point of the `[SCOPE]` tags.

Then in Discord, type `/grant-access` in your server. You should see a live-updating
embed walking through: validating input → resolving the Roblox username → checking
for an existing license → writing the record → a final green summary with the
exact expiry date/time.

## 6. Deploy to Railway

1. Push this folder to a GitHub repo, then in Railway: **New Project → Deploy from GitHub repo**.
2. In the Railway service's **Variables** tab, add every variable from your `.env` file
   (Railway sets `PORT` itself — you can leave it unset here).
3. **Important — persistent storage:** by default, Railway's filesystem is wiped on every
   redeploy. Go to the service's **Settings → Volumes → New Volume**, mount it at `/data`,
   then set `DB_PATH=/data/db.json` in the Variables tab. Without this, every redeploy
   erases all granted access.
4. Deploy. Check the **Deploy Logs** tab — you should see the same startup log lines as
   locally (`API server listening...`, `Logged in as...`, `Registered: /grant-access`).
5. Copy the Railway-provided public URL (Settings → Networking → Generate Domain if you
   haven't already) — this becomes the new `API_BASE` for the plugin.

## 7. Point the Roblox plugin at the new backend

In the plugin's main `Novai` script, update:

```lua
local API_BASE = "https://your-new-railway-url.up.railway.app"
local API_KEY = "the-same-value-as-PLUGIN_API_KEY-in-.env"
```

That's it — the plugin already calls `/license-status` and `/request-access` with
exactly the shapes this backend expects, so no other plugin changes are needed for
Phase 1.

## 8. Test end-to-end

1. Open the plugin in Roblox Studio → it should show "You're not approved yet" (status `not_found`).
2. In Discord: `/grant-access username:<your-roblox-username> days:7`.
3. Wait up to 15 seconds (the plugin polls `/license-status` on that interval) — the
   plugin should flip to the Dashboard automatically.

## Troubleshooting

Every log line follows `[timestamp] [LEVEL] [scope] message`. A few common ones:

- `[ERROR] [auth] ... invalid or missing API key` → the plugin's `API_KEY` doesn't
  match `PLUGIN_API_KEY` in the backend's environment.
- `[ERROR] [licenseService] No Roblox user found with username "..."` → typo in the
  username passed to `/grant-access`, or the account doesn't exist.
- `[ERROR] [db] Database file at ... is corrupted` → the JSON file was manually edited
  and broke; restore from a backup or delete it to start fresh (this loses all grants).
- Bot doesn't respond to `/grant-access` at all → check `DISCORD_TOKEN` is correct and
  the bot shows **online** in your server's member list; check the Railway deploy logs
  for a `[discordClient]` error.

## What's next

This is intentionally scoped to one command. The `commands/` folder and
`commands` array in `src/discord/client.js` are structured so adding a second
command later (e.g. `/revoke-access`) is just: new file in `commands/`, add it
to the array, done — no other wiring changes needed.

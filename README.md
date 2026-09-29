# OM-Bot

A Discord bot for sim-racing communities — moderation, an economy, party games,
race timers, and **Chamy**, a Gemini-powered AI assistant. Originally built
hardcoded for one server (Olzhasstik Motorsports), now usable in any server:
commands register globally, and everything that used to be a fixed channel or
role ID is a per-server setting via `/config`.

## Features

* **Per-server configuration** (`/config`) — channels, roles and categories
  for every feature are set per guild, not hardcoded. `/config view` shows
  what's set; unset features simply stay off, they never fall back to
  another server's values.
* **Chamy** — a Gemini-powered assistant (`@Chamy <question>` or
  `hey chamy <question>`). Asleep by default in every server except OM's own;
  the bot operator wakes it per-server with a fixed phrase. Chamy carries
  OM League knowledge and moderation tools only inside OM's own server —
  everywhere else it's a generic assistant with no OM-specific facts to hand
  out. Backed by MongoDB-cached channel scanning and Gemini vision for
  reading standings/results images.
* **Economy** — coin wallets (global per user), earned through channel
  activity (Madcardex/Ballsdex/F1dex catches, Arcane level-ups), a small
  casino, and driver ratings (PAC/CRA/DEF/OVT/CON/EXP).
* **Moderation** — ban/kick/mute/warn/jail, with a configurable co-owner
  role and a bot-operator tier that works the same in every server.
* **Race timers** — auto-detects race announcements in configured channels
  and posts a countdown reminder.
* **Bump reminders** — Disboard/Carl bump tracking, per server.
* **Party games** — trivia, Gartic, Hunger Games, Millionaire, Jenga, drag
  race, Keep Talking, caption battles, and more.
* **Team radio** — temporary voice channels for race teams.
* **OM-only features** — the Minecraft server bridge (Exaroton), welcome DMs,
  the reaction-role league picker, and the moderation dashboard are tied to
  OM's own server/API keys and stay off elsewhere.

## Tech stack

* Node.js, [discord.js](https://discord.js.org/) v14
* MongoDB / Mongoose
* Google Gemini (`@google/generative-ai`) for Chamy

## Setup

```bash
git clone https://github.com/Gofretfkintank/OM-Bot.git
cd OM-Bot
npm install
```

Create a `.env` file:

| Variable | Required | Purpose |
|---|---|---|
| `TOKEN` | yes | Discord bot token |
| `CLIENT_ID` | yes | Discord application ID (for slash command registration) |
| `MONGO_URI` | yes | MongoDB connection string |
| `OWNER_IDS` | recommended | Comma-separated Discord user ID(s) with bot-operator access everywhere (Chamy wake/sleep, moderation bypass, `/config`-independent full power). Falls back to the original OM commander ID if unset. |
| `GEMINI_API_KEY` | for Chamy | Google Gemini API key. Chamy stays silent without it. |
| `ALLOWED_GUILDS` | optional | Comma-separated guild IDs to restrict the bot to. Leave unset for "works in any server". |
| `LEGACY_GUILD_ID` | no | OM's own guild ID — gates the OM-only features above. Defaults to OM's actual ID; only needed to point it elsewhere. |
| `EXAROTON_API_KEY` | for `/mcturn` | Only used in OM's own server. |
| `REPORT_LOG_ID` | for `/report` | Channel ID the report tool logs to. |
| `MADPLUS_RATING_ENABLED` | optional | Defaults to **false** during the private beta. Set to `true` at public release to resume Mad+ ratings, Discord results scanning and app report imports. |

Start it:

```bash
npm start
```

### Registering slash commands

Commands register **globally** on every boot (`ready` in `index.js`), so a
normal start is enough for the bot to work in any server it's invited to —
global propagation can take up to an hour on a fresh app. For instant
registration to specific servers while developing:

```bash
DEPLOY_SCOPE=guild DEV_GUILD_IDS=123,456 npm run deploy
```

### Per-server setup

Once the bot is in a server, an admin runs `/config view` to see every
configurable feature, then `/config set-channel`, `/config set-role`,
`/config add` / `/config remove` (for list settings) and `/config clear`.
A feature whose setting is unset stays quiet rather than guessing.

### Mad+ rating release switch

Mad+ ratings are temporarily paused unless `MADPLUS_RATING_ENABLED=true`.
The original league scanning and rating calculation code is retained. While
paused, scheduled jobs and `/rating` commands cannot import or recompute
ratings. The bot publishes an empty rating snapshot to the lobby so the app
does not keep displaying old ratings. Other bot features stay active.

At public release, set `MADPLUS_RATING_ENABLED=true` on the bot's Railway
service and deploy/restart it. The normal scan starts after five minutes and
then runs every twenty minutes. This is an explicit release switch; publishing
an APK alone does not change it.

For a clean reset while paused, clear only `madratings`, `raceresults`,
`racereports`, and the Discord-channel entries in `resultcursors`. Keep the
`lobby:race-reports` cursor so already imported app reports are not replayed.
Clearing the Discord cursors makes the next enabled scan read each results
channel afresh (using the existing initial 60-message window). Account links,
legacy driver ratings, economies and all other collections are unrelated to
this reset.

### Rating history and app placements (v2)

Discord scans and manually imported league results form a separate historical
rating. **50% of its total** becomes the driver's starting rating: 2034 becomes
1017, not 1517. Drivers without imported history retain the 1000-point start;
the existing 100-point floor still applies. Historical races, wins and podiums
are retained separately in `historicalRaces`, `historicalWins` and
`historicalPodiums`.

Only a driver's own authenticated Mad+ race report advances their 10-race
placement. Appearing in another driver's report or in a scanned season table
does not count. App race gains and losses are added at full weight to that base,
with the existing 2x placement multiplier. A matched Discord/app race is scored
once per driver. Rank, leaderboard eligibility and Challenger remain locked
until 10 app races have been recorded; the level after placement depends on
results and is not guaranteed.

`races`, `wins`, `podiums` and `history` now describe the app ledger.
`scanRating`, `scanContribution`, `baseRating` and `appDelta` explain the total.
Recomputation rebuilds both ledgers from retained source records, so restarting
or rescanning cannot repeatedly halve a balance. Stored app reports do not age
out of the calculation. The enabled bot refreshes ratings and the lobby snapshot
five seconds after startup, then resumes its normal scanning schedule.

Run the rating regression suite with `node --test tests/rating-*.test.js`.

## License

MIT — see [LICENSE](LICENSE).

### M25 archive backfill v2

`events/m25History.js` walks complete message history and active/archived F1/F2
season threads. `m25-history-v2` checkpoints live in `onetimejobs`; per-message
provenance, extracted evidence, errors and review items live in `m25archiveaudits`.
Every image and explicit race is considered. Points-only season tables cannot
reconstruct race classifications and are reported as standings, not invented races.
Downloads/API failures retry up to three passes. To retry after repairing evidence,
clear the job's `doneAt` and set the affected audit's `attempts` to 0 and `status`
to `failed`. No Discord messages are sent.

Explicit series/season/round/session identifies duplicates; ambiguous legacy
cross-posts and conflicting classifications require review. Legacy source records
are preserved, marked ignored only after their full replacements are saved.
Season-final surrogate records are retired only with a known expected round count
and complete explicit race coverage. `doneAt` means evidence traversal finished,
not that every historical race was recoverable; inspect `summary` and `coverage`.
The 50% imported-history contribution and ten own-app placements remain unchanged.

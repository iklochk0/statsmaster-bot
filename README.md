# StatsMaster Bot

StatsMaster Bot is a Discord bot and admin toolkit for tracking KvK player progress. It stores baseline player data, imports battle deltas from Excel, calculates goals and DKP progress, and exposes Discord commands plus a small admin panel.

## Features

- Discord commands for player stats, leaderboards, account linking, farm approvals, and admin actions.
- PostgreSQL schema setup and data access in `src/db.pg.js`.
- OCR scanner for City Hall 25 baseline snapshots through ADB/emulator automation.
- Excel import/export utilities for KvK battle data and backups.
- Optional Next.js admin panel in `admin/`.

## Project Structure

```text
src/
  bot.js               Discord bot entrypoint
  index.js             OCR baseline scanner
  db.pg.js             PostgreSQL schema and query helpers
  excelImport.js       Excel import pipeline
  excelExport.js       Excel backup/export pipeline
  wipe.all.js          guarded database wipe utility
admin/                 Next.js admin panel
tools/                 calibration and import helper scripts
screenshots/           local screenshots used by OCR tooling
tables/                local Excel inputs/backups
```

## Requirements

- Node.js 20.x
- PostgreSQL database
- Discord bot token
- ADB-compatible Android emulator/device for OCR scans
- `eng.traineddata` for Tesseract OCR

## Environment Variables

Create a `.env` file in the project root. At minimum:

```env
DATABASE_URL=postgresql://user:password@host:5432/database
DISCORD_TOKEN=your_discord_bot_token
```

Common optional variables:

```env
PORT=3000
ADMIN_ROLE_IDS=role_id_1,role_id_2
PUBLIC_CHANNEL_ID=discord_channel_id
ADMIN_CHANNEL_ID=discord_channel_id
LOG_CHANNEL_ID=discord_channel_id
ADMIN_IMPORT_WEBHOOK_URL=https://discord.com/api/webhooks/...

ADB_BIN=adb
ADB_SERIAL=127.0.0.1:5555
SCREEN_PATH=./screenshots/screen.png
USE_HOST_CLIPBOARD=true
```

OCR tuning variables such as `SCAN_PAUSE_MIN_MS`, `SCAN_PAUSE_MAX_MS`, `BASE_ROW_IDX`, `RAND_PX`, and `ACTION_LOG_MAX` are supported by `src/index.js`.

## Installation

```bash
npm install
```

For the admin panel:

```bash
cd admin
npm install
```

## Usage

Start the Discord bot:

```bash
npm run bot
```

Run the OCR baseline scanner:

```bash
npm run scan -- --count=40
```

Import an Excel battle report:

```bash
node src/excelImport.js ./tables/report.xlsx zone4 true
```

Export the latest view to CSV:

```bash
node src/export.latest.csv.js
```

Run the one-time DKP migration:

```bash
npm run migrate:add-dkp
```

## Database Wipe

The wipe script is intentionally guarded. It drops bot-managed objects and does not recreate them.

PowerShell:

```powershell
$env:ALLOW_WIPE="YES"
npm run deletedb
```

Bash:

```bash
ALLOW_WIPE=YES npm run deletedb
```

After a wipe, start the bot or scanner to initialize the schema again through `initSchema()`.

## Admin Panel

The admin panel is a separate Next.js app:

```bash
cd admin
npm run dev
```

It uses the same database connection and supports routes for players, imports, backups, KvK sessions, and database maintenance.

## Notes for Contributors

- Keep operational scripts guarded when they can delete or overwrite data.
- Prefer concise comments that explain non-obvious behavior or business rules.
- Do not commit `.env`, generated screenshots, local exports, or database backups unless they are intentional fixtures.

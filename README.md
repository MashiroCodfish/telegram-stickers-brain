# telegram-stickers-brain

A lightweight OpenClaw plugin for Telegram sticker collection and semantic search.

This version keeps the architecture intentionally simple:

- **Gemini captioning** for short sticker descriptions
- **Gemini Embedding 2** for semantic vectors
- **Local SQLite storage** for the live index
- **In-memory cosine search** for fast retrieval
- **Auto-collection + manual sync** for Telegram sticker sets

Compared with the older stack, this build removes the heavy local embedding / sqlite-vec / llama fallback path and focuses on one clean production path:

```text
query -> Gemini Embedding 2 -> local in-memory similarity search -> sticker_id
```

## What it does

- Watches Telegram sticker traffic and can auto-queue newly seen sticker sets
- Syncs a sticker set from a set name or `t.me/addstickers/...` link
- Generates or reuses sticker descriptions
- Stores metadata as `.qmd` files
- Builds a local semantic index in SQLite
- Exposes agent tools for sticker sync, stats, and semantic sticker lookup

## Why this version exists

The goal of this rewrite was not “more features at any cost”. It was:

- lower runtime overhead
- fewer moving parts
- simpler maintenance
- fewer weird fallback branches
- faster sticker search in normal use

In local testing during the rewrite, semantic search dropped from roughly **4-7.6s** to about **449-532ms**.

## Plugin tools

After installation, the plugin exposes these tools to the agent:

- `sync_sticker_set_by_name`
- `get_sticker_stats`
- `search_sticker_by_emotion`

Typical flow:

1. Agent syncs one or more sticker sets
2. Plugin captions and indexes stickers in the background
3. Agent searches by emotion / action / visual traits
4. Plugin returns a Telegram `sticker_id`
5. Agent sends the sticker through the messaging tool

## Requirements

- OpenClaw with plugin support
- Telegram channel configured in OpenClaw
- A working Telegram bot token
- Gemini API key for captioning / embedding
- Node.js **18+**

## Install

### Option A: install from source checkout

```bash
git clone https://github.com/MashiroCodfish/telegram-stickers-brain.git
cd telegram-stickers-brain
npm install
openclaw plugins install .
```

Then restart the Gateway.

### Option B: install from npm (after npm publish)

```bash
openclaw plugins install @roitium/telegram-stickers-brain
```

Then restart the Gateway.

## Minimal config

Configure the plugin under `plugins.entries.telegram-stickers-brain.config`.

```json5
{
  "plugins": {
    "entries": {
      "telegram-stickers-brain": {
        "enabled": true,
        "config": {
          "vlmApiKey": "YOUR_GEMINI_API_KEY",
          "embeddingModel": "gemini-embedding-2-preview",
          "embeddingDimensions": 768,
          "autoCollect": true
        }
      }
    }
  }
}
```

### Config fields

| Field | Required | Default | Notes |
| --- | --- | --- | --- |
| `vlmModel` | no | `gemini-3.1-flash-lite-preview` | Model used for sticker captioning |
| `vlmApiKey` | usually yes | none | Gemini API key for captioning; also used for embeddings when `embeddingApiKey` is omitted |
| `embeddingModel` | no | `gemini-embedding-2-preview` | Embedding model for semantic index |
| `embeddingApiKey` | no | falls back to `vlmApiKey` | Separate key for embeddings if desired |
| `embeddingDimensions` | no | `768` | Integer between `128` and `3072` |
| `autoCollect` | no | `true` | Automatically queue newly seen Telegram sticker sets |
| `notifyChatId` | no | none | Optional Telegram chat ID for sync start/finish notifications |

The plugin also falls back to these environment variables when API keys are not present in plugin config:

- `GEMINI_API_KEY`
- `GOOGLE_API_KEY`
- `VLM_API_KEY`

## Data layout

This plugin stores data in a very plain way:

- `stickers_metadata/*.qmd` - lightweight sticker metadata files
- `STATE_DIR/telegram-stickers-brain.sqlite` - live semantic index
- `STATE_DIR/telegram/sticker-cache.json` - Telegram sticker cache used for auto-detect
- `STATE_DIR/telegram-stickers-brain-tmp/` - temporary working files

## Search behavior

`search_sticker_by_emotion` works best when the query is concrete and visual.

Good examples:

- `开心 笑着 跑`
- `无奈 叹气 摆烂`
- `生气 拍桌子`
- `委屈 哭哭`

The tool returns JSON text like:

```json
{"sticker_id":"CAACAgUAAxkBA..."}
```

The agent can then send that sticker through the message tool.

## Background behavior

The plugin runs a background service that:

- processes queued sticker sets
- backfills unindexed `.qmd` metadata into the live SQLite index
- periodically checkpoints SQLite WAL state

If auto-collection is enabled, Telegram sticker traffic can trigger set detection and background sync.

## Architecture notes

This release intentionally avoids the older heavy fallback stack.

Removed from the active path:

- `sqlite-vec`
- local embedding fallback branches
- llama / embeddinggemma route
- deprecated helper script `describe_sticker.js`

Current design principles:

- one main embedding path
- keep failures understandable
- prefer text-only fallback over complicated local-model recovery
- keep runtime size and operational burden low

## Packaging

Create a distributable npm tarball with:

```bash
npm pack
```

OpenClaw can install from a local tarball too:

```bash
openclaw plugins install ./roitium-telegram-stickers-brain-2.4.1.tgz
```

## Agent install guide

See: [docs/AGENT_INSTALL.md](docs/AGENT_INSTALL.md)

That file is written as an operations handoff / exact install procedure for another agent or operator.

## Troubleshooting

### No stickers are found

Check:

- Telegram bot token is configured
- Gemini key is valid
- some sticker sets have actually been synced
- `get_sticker_stats` shows indexed stickers > 0

### Auto-collection does not trigger

Check:

- `autoCollect` is `true`
- incoming content is really Telegram sticker traffic
- the sticker cache is updating normally

### Search is slow on first run

First search may warm the in-memory cache or backfill older `.qmd` files. Later searches should be much faster.

## License

MIT

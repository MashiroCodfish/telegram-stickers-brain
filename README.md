# telegram-stickers-brain

`telegram-stickers-brain` is an OpenClaw plugin for semantic Telegram sticker search.

It syncs Telegram sticker sets, builds embeddings with **Gemini Embedding 2**, stores vectors in **local SQLite**, and searches them in memory with cosine similarity.

## Features

- Sync sticker sets from a set name or `t.me/addstickers/...` link
- Optional automatic collection of newly seen Telegram sticker sets
- Gemini Embedding 2 for both sticker indexing and query embedding
- Local SQLite vector storage
- Fast in-memory similarity search
- Returns Telegram `sticker_id` values for agent-side sticker sending

## Requirements

- OpenClaw with Telegram configured
- A working Telegram bot token
- A Gemini API key for embeddings
- Node.js **18+**
- `ffmpeg` recommended for animated or video stickers (`.tgs`, `.webm`) so preview frames can be extracted

## Install

### From source

```bash
git clone https://github.com/MashiroCodfish/telegram-stickers-brain.git
cd telegram-stickers-brain
npm install
openclaw plugins install .
```

Restart the Gateway after installation.

### From npm (after npm publish)

```bash
openclaw plugins install @roitium/telegram-stickers-brain
```

Use this path only after the package has been published to npm.

Restart the Gateway after installation.

## Configuration

Configure the plugin under `plugins.entries.telegram-stickers-brain`.

```json5
{
  "plugins": {
    "entries": {
      "telegram-stickers-brain": {
        "enabled": true,
        "config": {
          "embeddingApiKey": "YOUR_GEMINI_API_KEY",
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

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `embeddingApiKey` | usually yes | none | Gemini API key used for embedding calls |
| `embeddingModel` | no | `gemini-embedding-2-preview` | Embedding model used for stickers and queries |
| `embeddingDimensions` | no | `768` | Output dimensionality for vectors |
| `autoCollect` | no | `true` | Automatically queue newly seen Telegram sticker sets |

If `embeddingApiKey` is omitted, the plugin also checks:

- `GEMINI_API_KEY`
- `GOOGLE_API_KEY`

## Tools

The plugin exposes these tools to the agent:

- `sync_sticker_set_by_name`
- `get_sticker_stats`
- `search_sticker_by_emotion`

## How it works

### Indexing

When a sticker set is synced:

1. The plugin fetches the set from Telegram
2. Sticker files are downloaded
3. A preview image is used directly or extracted with `ffmpeg`
4. Gemini Embedding 2 generates normalized vectors
5. Vectors are stored in local SQLite

### Search

When a query is searched:

1. The query is embedded with Gemini Embedding 2
2. Sticker vectors are loaded into memory
3. Cosine similarity is computed locally
4. The best match is returned as a Telegram `sticker_id`

## Typical workflow

### Manual workflow

1. Sync a sticker set
2. Let indexing finish
3. Search with an emotion or action query
4. Send the returned sticker

### Optional automatic collection

If `autoCollect` is enabled, newly seen Telegram sticker sets can be queued automatically and indexed in the background.

## Search tips

Concrete Chinese emotion / action / trait phrases work best.

Examples:

- `开心 笑着 跑`
- `无奈 叹气 摆烂`
- `委屈 哭哭`
- `得意 比耶`

Typical result format:

```json
{"sticker_id":"CAACAgUAAxkBA..."}
```

## Local data

The plugin stores local state in:

- `STATE_DIR/telegram-stickers-brain.sqlite` — vector index
- `STATE_DIR/telegram-stickers-brain-tmp/` — temporary preview files
- `STATE_DIR/telegram/sticker-cache.json` — used by optional automatic collection

## Packaging

Create a tarball with:

```bash
npm pack
```

OpenClaw can also install from a local tarball:

```bash
openclaw plugins install ./roitium-telegram-stickers-brain-1.0.0.tgz
```

## Installation guides

- Agent/operator guide: [docs/AGENT_INSTALL.md](docs/AGENT_INSTALL.md)
- OpenClaw auto-install guide: [docs/OPENCLAW_AUTO_INSTALL.md](docs/OPENCLAW_AUTO_INSTALL.md)

## License

MIT

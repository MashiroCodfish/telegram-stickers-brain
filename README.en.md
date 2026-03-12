[中文](./README.md) | [English](./README.en.md)

# tg-stickers-chat

A Telegram sticker chat enhancement plugin for **OpenClaw**.

Its goal is simple: help the agent use stickers more naturally and proactively in chat, instead of replying with plain text only.

## Screenshot Example

![tg-stickers-chat screenshot](https://raw.githubusercontent.com/MashiroCodfish/tg-stickers-chat/main/IMG_9061.jpeg)

---

## Quick Install

### Option 1: Install directly from npm

```bash
openclaw plugins install tg-stickers-chat
openclaw gateway restart
```

### Option 2: Install from the release package

Download `tg-stickers-chat-1.0.0.tgz` from the release page, then run:

```bash
openclaw plugins install ./tg-stickers-chat-1.0.0.tgz
openclaw gateway restart
```

### Option 3: Install from source

```bash
git clone https://github.com/MashiroCodfish/tg-stickers-chat.git
cd tg-stickers-chat
npm install
openclaw plugins install .
openclaw gateway restart
```

---

## Tech Stack

This project is intentionally small and uses only a few pieces:

- **OpenClaw Plugin API** for integration
- **Telegram Bot API** for sticker set and file access
- **Gemini Embedding 2** for sticker and query vectors
- **SQLite** for local vector storage
- **In-memory similarity search** for local retrieval
- **ffmpeg** (recommended) for preview extraction from `.tgs` and `.webm` stickers

---

## How It Works

The core path is very small:

1. Sync a Telegram sticker set
2. Download sticker files
3. Use the original image directly for static stickers, or extract a preview frame for animated/video stickers
4. Generate vectors with **Gemini Embedding 2**
5. Store vectors in local **SQLite**
6. Let the agent turn its query into a vector during chat
7. Run similarity matching locally in memory
8. Return the best matching Telegram `sticker_id` so it can be sent in chat

If `autoCollect` is enabled, newly seen sticker sets in chats can be queued automatically. The indexing and search core stays the same.

The plugin exposes these three tools to OpenClaw:

- `sync_sticker_set_by_name`
- `get_sticker_stats`
- `search_sticker_by_emotion`

---

## Configuration

Write config under:

```text
plugins.entries.tg-stickers-chat
```

Minimal example:

```json5
{
  "plugins": {
    "entries": {
      "tg-stickers-chat": {
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

- `embeddingApiKey`
  - Gemini API key used for embeddings
  - Required for building the vector index

- `embeddingModel`
  - Default: `gemini-embedding-2-preview`
  - Usually does not need to change

- `embeddingDimensions`
  - Default: `768`
  - Usually does not need to change

- `autoCollect`
  - Whether newly seen sticker sets should be queued automatically
  - `true` = enabled
  - `false` = fully manual mode

If `embeddingApiKey` is not set in plugin config, the plugin also checks:

- `GEMINI_API_KEY`
- `GOOGLE_API_KEY`

If you want the agent to send stickers more often or less often, you can tell it directly in chat, or store that preference in memory so it can adjust its sticker frequency on its own.

If you want another OpenClaw deployment to install this plugin automatically, see:

- [OpenClaw auto-install guide](./docs/OPENCLAW_AUTO_INSTALL.md)

---

## License

MIT

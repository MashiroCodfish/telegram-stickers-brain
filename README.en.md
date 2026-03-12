[中文](./README.md) | [English](./README.en.md)

# telegram-stickers-brain

A Telegram sticker semantic search plugin for **OpenClaw**.

Its goal is simple: make OpenClaw better at finding and sending stickers by intent or mood.  
Users should be able to say things like “send a sad one” or “give me a happy sticker” without worrying about search syntax.

---

## Quick Install

### Option 1: Install from the release package (recommended)

Download `roitium-telegram-stickers-brain-1.0.0.tgz` from the release page, then run:

```bash
openclaw plugins install ./roitium-telegram-stickers-brain-1.0.0.tgz
openclaw gateway restart
```

### Option 2: Install from source

```bash
git clone https://github.com/MashiroCodfish/telegram-stickers-brain.git
cd telegram-stickers-brain
npm install
openclaw plugins install .
openclaw gateway restart
```

### Option 3: Install from npm

```bash
openclaw plugins install @roitium/telegram-stickers-brain
openclaw gateway restart
```

> This path works after the package is published to npm.

---

## Tech Stack

This project intentionally keeps the stack small:

- **OpenClaw Plugin API** for integration
- **Telegram Bot API** for sticker set and file access
- **Gemini Embedding 2** for sticker and query vectors
- **SQLite** for local vector storage
- **In-memory cosine similarity search** for local retrieval
- **ffmpeg** (optional but recommended) for preview extraction from `.tgs` and `.webm` stickers

---

## How It Works

The core path is very small:

1. Sync a Telegram sticker set
2. Download sticker files
3. Use the original image directly, or extract a preview frame for animated/video stickers
4. Generate vectors with **Gemini Embedding 2**
5. Store vectors in local **SQLite**
6. Turn the search query into a vector
7. Run similarity matching locally in memory
8. Return the best matching Telegram `sticker_id`

If `autoCollect` is enabled, newly seen sticker sets in chats can be queued automatically. The indexing and search core stays the same.

---

## Configuration

Write config under:

```text
plugins.entries.telegram-stickers-brain
```

Minimal example:

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

---

## Exposed Tools

The plugin provides these tools to OpenClaw:

- `sync_sticker_set_by_name`
- `get_sticker_stats`
- `search_sticker_by_emotion`

---

## More Docs

For operators, developers, or other OpenClaw instances:

- [Install / verification guide](./docs/AGENT_INSTALL.md)
- [Auto-install guide for other OpenClaw deployments](./docs/OPENCLAW_AUTO_INSTALL.md)

---

## License

MIT

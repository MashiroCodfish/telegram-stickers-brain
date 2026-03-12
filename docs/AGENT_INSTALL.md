# Agent Install Guide: telegram-stickers-brain 1.0.0

Use this document when another agent or operator needs to install and verify the plugin.

## Goal

Install `telegram-stickers-brain` for Telegram sticker semantic search with:

- manual sticker-set sync
- optional automatic collection
- Gemini Embedding 2 indexing
- local SQLite vector storage
- in-memory cosine similarity search

## Preconditions

Before installing, verify all of these are true:

- OpenClaw is already installed
- Telegram channel is configured and working
- You have a Gemini API key for embeddings
- You can restart the OpenClaw Gateway on this machine
- Node.js 18+ is available
- `ffmpeg` is available if animated or video stickers need preview extraction

## Install paths

Choose **one** path.

### Path 1: source checkout

```bash
git clone https://github.com/MashiroCodfish/telegram-stickers-brain.git
cd telegram-stickers-brain
npm install
openclaw plugins install .
```

### Path 2: local tarball

```bash
openclaw plugins install ./roitium-telegram-stickers-brain-1.0.0.tgz
```

### Path 3: npm package

Use only if the package has already been published to npm.

```bash
openclaw plugins install @roitium/telegram-stickers-brain
```

## Enable and configure

The plugin id is:

```text
telegram-stickers-brain
```

Write config under:

```text
plugins.entries.telegram-stickers-brain
```

### Minimal config

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

Set `autoCollect` to `false` if you want a fully manual workflow.

## Restart

Plugin config changes require a Gateway restart.

```bash
openclaw gateway restart
```

## Verification checklist

After restart, verify these items.

### 1. Plugin is installed

```bash
openclaw plugins list
```

Look for `telegram-stickers-brain`.

### 2. Plugin is enabled

```bash
openclaw plugins info telegram-stickers-brain
```

### 3. Tools are available

Expected tools:

- `sync_sticker_set_by_name`
- `get_sticker_stats`
- `search_sticker_by_emotion`

### 4. Manual sync test

Ask the agent to call:

```text
sync_sticker_set_by_name({"setNameOrUrl":"https://t.me/addstickers/<SET_NAME>"})
```

or provide a bare set name:

```text
sync_sticker_set_by_name({"setNameOrUrl":"<SET_NAME>"})
```

### 5. Stats check

Ask the agent to call:

```text
get_sticker_stats({})
```

Expected result shape:

```text
当前语义索引中共有 X 张表情包，当前同步队列中有 Y 个合集，自动收集目前为开启/关闭。
```

### 6. Search test

Ask the agent to call:

```text
search_sticker_by_emotion({"query":"开心 笑着 跑"})
```

Expected result shape:

```json
{"sticker_id":"..."}
```

## Recommended smoke test flow

1. Install plugin
2. Configure the embedding API key
3. Restart the Gateway
4. Sync one known sticker set
5. Run `get_sticker_stats`
6. Run `search_sticker_by_emotion`
7. Send the returned sticker id in chat

## Operational notes

- Vectors are stored in local SQLite
- Search runs locally in memory using cosine similarity
- Automatic collection is optional and does not change the indexing/search core
- Animated or video sticker preview extraction benefits from `ffmpeg`

## Tool intent summary

- `sync_sticker_set_by_name`: queue a Telegram sticker set for indexing
- `get_sticker_stats`: report indexed sticker count, queue size, and auto-collection state
- `search_sticker_by_emotion`: semantic lookup that returns a Telegram `sticker_id`

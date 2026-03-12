# OpenClaw Auto Install Guide: telegram-stickers-brain 1.0.0

Use this document when an OpenClaw operator or another OpenClaw agent needs to install the plugin with minimal manual interpretation.

## Scope

This guide covers a clean automated install flow for another OpenClaw deployment:

1. install the plugin
2. configure embedding settings
3. restart the Gateway
4. verify tool availability

## Plugin identity

- npm package: `@roitium/telegram-stickers-brain`
- plugin id: `telegram-stickers-brain`
- config path: `plugins.entries.telegram-stickers-brain`

## Preconditions

The target OpenClaw instance should already have:

- Telegram configured and working
- a valid Telegram bot token
- a Gemini API key for embeddings
- Node.js 18+
- `ffmpeg` available for animated or video sticker preview extraction

## Automated install flow

### Option A: install from npm (after npm publish)

```bash
openclaw plugins install @roitium/telegram-stickers-brain
```

Use this path only after the package has been published to npm.

### Option B: install from a local tarball

Download the release asset first, then install it:

```bash
openclaw plugins install ./roitium-telegram-stickers-brain-1.0.0.tgz
```

### Option C: install from a source checkout

```bash
git clone https://github.com/MashiroCodfish/telegram-stickers-brain.git
cd telegram-stickers-brain
npm install
openclaw plugins install .
```

## Config patch template

Set or merge this under the target OpenClaw config:

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

Set `autoCollect` to `false` if the target deployment should remain fully manual.

## Restart

After install and config changes:

```bash
openclaw gateway restart
```

## Post-install verification

### Check plugin presence

```bash
openclaw plugins list
```

### Check plugin details

```bash
openclaw plugins info telegram-stickers-brain
```

### Expected tools

The deployment should expose:

- `sync_sticker_set_by_name`
- `get_sticker_stats`
- `search_sticker_by_emotion`

## Recommended smoke test

1. Sync one known sticker set
2. Wait for indexing to finish
3. Run `get_sticker_stats`
4. Run `search_sticker_by_emotion`
5. Send the returned `sticker_id`

## Example smoke test inputs

### Manual sync

```text
sync_sticker_set_by_name({"setNameOrUrl":"https://t.me/addstickers/<SET_NAME>"})
```

### Stats

```text
get_sticker_stats({})
```

### Search

```text
search_sticker_by_emotion({"query":"开心 笑着 跑"})
```

## Notes for agents and operators

- The indexing/search core is unchanged whether `autoCollect` is enabled or disabled
- Vectors are stored locally in SQLite
- Search runs locally in memory using cosine similarity
- The plugin returns Telegram `sticker_id` values for downstream sending

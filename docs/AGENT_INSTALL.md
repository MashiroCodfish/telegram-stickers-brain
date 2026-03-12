# Agent Install Guide: telegram-stickers-brain

Use this document when another agent or operator needs to install, enable, configure, and verify the plugin with minimal guesswork.

## Goal

Install the `telegram-stickers-brain` OpenClaw plugin, enable it, configure Gemini keys, restart the Gateway, and verify that the sticker tools are available.

## Preconditions

Before installing, verify all of these are true:

- OpenClaw is already installed
- Telegram channel is configured and working
- You have a Gemini API key
- You can restart the OpenClaw Gateway on this machine
- Node.js 18+ is available

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
openclaw plugins install ./roitium-telegram-stickers-brain-2.4.1.tgz
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

### Minimal config example

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

### Optional fields

```json5
{
  "plugins": {
    "entries": {
      "telegram-stickers-brain": {
        "enabled": true,
        "config": {
          "vlmModel": "gemini-3.1-flash-lite-preview",
          "vlmApiKey": "YOUR_GEMINI_API_KEY",
          "embeddingApiKey": "OPTIONAL_SEPARATE_GEMINI_KEY",
          "embeddingModel": "gemini-embedding-2-preview",
          "embeddingDimensions": 768,
          "autoCollect": true,
          "notifyChatId": "123456789"
        }
      }
    }
  }
}
```

## Restart

Plugin config changes require a Gateway restart.

CLI:

```bash
openclaw gateway restart
```

If using an OpenClaw config tool, apply the config patch first, then restart.

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

Confirm the plugin is enabled and the manifest loads correctly.

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

Expect a result like:

```text
当前表情包库中共有 X 张表情包元数据，其中 Y 张已经写入当前语义索引。
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

## Operational notes

- The plugin writes lightweight metadata to `stickers_metadata/*.qmd`
- The live semantic index is stored in SQLite
- Search runs from in-memory vectors loaded from SQLite
- If multimodal embedding fails for a sticker, the plugin retries with text-only embedding
- First search can be slower if the cache is still warming or older metadata is backfilling

## Failure modes to check first

If installation "looks successful" but usage fails, inspect these in order:

1. Telegram bot token missing or invalid
2. Gemini API key missing or invalid
3. Plugin not restarted after config change
4. No sticker sets have been synced yet
5. Existing metadata exists but has not been backfilled into the live index yet

## Recommended smoke test flow

1. Install plugin
2. Enable config with Gemini key
3. Restart Gateway
4. Sync one known sticker set
5. Wait for background indexing
6. Run `get_sticker_stats`
7. Run `search_sticker_by_emotion`
8. Send the returned sticker id in chat

## Exact tool intent summary

- `sync_sticker_set_by_name`: queue a Telegram sticker set for background sync
- `get_sticker_stats`: report metadata count and indexed count
- `search_sticker_by_emotion`: semantic lookup that returns a Telegram `sticker_id`

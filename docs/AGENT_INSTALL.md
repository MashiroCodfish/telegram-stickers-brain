# 安装文档：telegram-sticker-search 1.0.0

这份文档是写给 **agent / 运维人员** 的。

目标很简单：把插件装好、配好、重启好，然后确认它真的能用。

## 这个插件是干什么的？

它负责：

- 同步 Telegram 表情包合集
- 用 Gemini Embedding 2 给表情包建向量
- 把向量存到本地 SQLite
- 在本地内存里做相似度搜索
- 返回 `sticker_id` 给上层 agent 发出去

## 安装前先确认

目标机器上最好已经有：

- OpenClaw
- 可用的 Telegram 配置
- 可用的 Telegram bot token
- Gemini API key
- Node.js 18+
- `ffmpeg`（推荐）

## 安装方式

三种方式任选一种。

### 方式一：源码安装

```bash
git clone https://github.com/MashiroCodfish/telegram-sticker-search.git
cd telegram-sticker-search
npm install
openclaw plugins install .
```

### 方式二：用 release 里的 tgz 安装

```bash
openclaw plugins install ./telegram-sticker-search-1.0.0.tgz
```

### 方式三：npm 安装

```bash
openclaw plugins install telegram-sticker-search
```

> 这个方式要在 npm 已发布后使用。

## 插件 ID 和配置位置

插件 ID：

```text
telegram-sticker-search
```

配置路径：

```text
plugins.entries.telegram-sticker-search
```

## 最小配置

```json5
{
  "plugins": {
    "entries": {
      "telegram-sticker-search": {
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

说明：

- `embeddingApiKey`：Gemini embedding 用的 key
- `embeddingModel`：默认就行
- `embeddingDimensions`：默认就行
- `autoCollect`：
  - `true` = 自动收集新合集
  - `false` = 完全手动

## 重启

插件装好、配置写好之后，要重启 Gateway：

```bash
openclaw gateway restart
```

## 装完之后怎么验

### 1. 看插件有没有装上

```bash
openclaw plugins list
```

### 2. 看插件详情

```bash
openclaw plugins info telegram-sticker-search
```

### 3. 确认工具是否存在

应该能看到这 3 个工具：

- `sync_sticker_set_by_name`
- `get_sticker_stats`
- `search_sticker_by_emotion`

## 推荐验收流程

### 第一步：手动同步一个合集

```text
sync_sticker_set_by_name({"setNameOrUrl":"https://t.me/addstickers/<SET_NAME>"})
```

或者：

```text
sync_sticker_set_by_name({"setNameOrUrl":"<SET_NAME>"})
```

### 第二步：看统计信息

```text
get_sticker_stats({})
```

应该能看到类似：

```text
当前语义索引中共有 X 张表情包，当前同步队列中有 Y 个合集，自动收集目前为开启/关闭。
```

### 第三步：做一次搜索

```text
search_sticker_by_emotion({"query":"开心 笑着 跑"})
```

返回值会长这样：

```json
{"sticker_id":"..."}
```

## 如果出问题，先查这几个地方

1. Telegram bot token 对不对
2. Gemini API key 对不对
3. Gateway 有没有重启
4. 有没有真的同步过表情包合集
5. 动图贴纸场景下，`ffmpeg` 有没有装

## 结论

只要这几件事都正常：
- 能同步合集
- `get_sticker_stats` 有数字
- `search_sticker_by_emotion` 能返回 `sticker_id`

那就说明这个插件已经可以投入使用了。

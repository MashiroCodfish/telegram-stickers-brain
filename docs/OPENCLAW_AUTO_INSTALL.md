# 给其他 OpenClaw 自动安装用的文档：telegram-sticker-search 1.0.0

这份文档是写给 **另一个 OpenClaw 实例**、或者给会自动操作 OpenClaw 的 agent 用的。

目标：

- 安装插件
- 写入配置
- 重启 Gateway
- 验证工具可用

## 插件信息

- npm 包名：`telegram-sticker-search`
- 插件 ID：`telegram-sticker-search`
- 配置路径：`plugins.entries.telegram-sticker-search`

## 前提条件

目标 OpenClaw 环境里应该已经有：

- Telegram 配置
- Telegram bot token
- Gemini API key
- Node.js 18+
- `ffmpeg`（推荐）

## 安装方式

### 方式 A：npm 安装

```bash
openclaw plugins install telegram-sticker-search
```

> 这个方式要在 npm 已发布后再用。

### 方式 B：用 release 里的 tgz 安装

先下载 release 里的压缩包，再执行：

```bash
openclaw plugins install ./telegram-sticker-search-1.0.0.tgz
```

### 方式 C：源码安装

```bash
git clone https://github.com/MashiroCodfish/telegram-sticker-search.git
cd telegram-sticker-search
npm install
openclaw plugins install .
```

## 配置模板

把下面这段合并到目标 OpenClaw 配置里：

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

如果你想让目标实例完全手动管理合集，就把：

```json5
"autoCollect": false
```

## 重启

安装和配置完成后：

```bash
openclaw gateway restart
```

## 安装完成后怎么验证

### 1. 确认插件存在

```bash
openclaw plugins list
```

### 2. 确认插件详情正常

```bash
openclaw plugins info telegram-sticker-search
```

### 3. 确认工具可用

目标实例应该能提供这 3 个工具：

- `sync_sticker_set_by_name`
- `get_sticker_stats`
- `search_sticker_by_emotion`

## 推荐自动验收流程

1. 同步一个已知的表情包合集
2. 等待索引完成
3. 调用 `get_sticker_stats`
4. 调用 `search_sticker_by_emotion`
5. 验证是否返回 `sticker_id`

### 示例：同步合集

```text
sync_sticker_set_by_name({"setNameOrUrl":"https://t.me/addstickers/<SET_NAME>"})
```

### 示例：查询统计

```text
get_sticker_stats({})
```

### 示例：搜索

```text
search_sticker_by_emotion({"query":"开心 笑着 跑"})
```

## 给 agent 的一句话总结

这是一个：

- 用 Gemini Embedding 2 建表情包向量
- 本地 SQLite 存储
- 本地内存搜索
- 支持手动同步和可选自动收集

的 OpenClaw 插件。

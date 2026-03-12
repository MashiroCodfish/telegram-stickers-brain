[中文](./README.md) | [English](./README.en.md)

# telegram-sticker-search

一个给 **OpenClaw** 用的 Telegram 表情包语义搜索插件。让 OpenClaw 能更自然地“按感觉”找表情包、发表情包。  

---

## 快速安装

### 方式一：从 Release 包安装（推荐）

先下载 Release 页面里的 `telegram-sticker-search-1.0.0.tgz`，然后执行：

```bash
openclaw plugins install ./telegram-sticker-search-1.0.0.tgz
openclaw gateway restart
```

### 方式二：从源码安装

```bash
git clone https://github.com/MashiroCodfish/telegram-sticker-search.git
cd telegram-sticker-search
npm install
openclaw plugins install .
openclaw gateway restart
```

### 方式三：从 npm 安装

```bash
openclaw plugins install telegram-sticker-search
openclaw gateway restart
```
---

## 技术栈

- **OpenClaw Plugin API**：把插件接入 OpenClaw
- **Telegram Bot API**：拉取 sticker set 和 sticker 文件
- **Gemini Embedding 2**：给表情包和搜索词生成向量
- **SQLite**：本地存储向量索引
- **内存余弦相似度搜索**：查询时直接在本地内存里匹配
- **ffmpeg（可选但推荐）**：处理 `.tgs` / `.webm` 这类动图或视频贴纸的预览帧

---

## 实现原理

1. 同步一个 Telegram 表情包合集
2. 下载每张贴纸文件
3. 如果是静态图，直接拿图；如果是动图 / 视频，就抽一帧预览图
4. 用 **Gemini Embedding 2** 给贴纸生成向量
5. 把向量存到本地 **SQLite**
6. 搜索时，再把查询词也转成向量
7. 在本地内存里做相似度匹配
8. 返回最合适的 Telegram `sticker_id`

如果打开了 `autoCollect`，聊天里出现新的表情包合集时，插件会自动把它加入处理队列；但核心索引和搜索逻辑不会变。

---

## 配置

配置写在这里：

```text
plugins.entries.telegram-sticker-search
```

最小配置示例：

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

### 配置项说明

- `embeddingApiKey`
  - Gemini 的 API key
  - 这是最重要的配置，没有它就没法建立向量索引

- `embeddingModel`
  - 默认值：`gemini-embedding-2-preview`
  - 一般情况下不用改

- `embeddingDimensions`
  - 默认值：`768`
  - 一般情况下也不用改

- `autoCollect`
  - 是否自动收集聊天里新出现的表情包合集
  - `true` = 开启
  - `false` = 完全手动

如果你没有在插件配置里写 `embeddingApiKey`，插件也会尝试读取这些环境变量：

- `GEMINI_API_KEY`
- `GOOGLE_API_KEY`

---

## 插件提供的工具

这个插件会给 OpenClaw 提供 3 个工具：

- `sync_sticker_set_by_name`
- `get_sticker_stats`
- `search_sticker_by_emotion`

---

## 其他文档

如果你是运维、开发者，或者想让别的 OpenClaw 自动安装它，可以继续看：

- [安装 / 验证文档](./docs/AGENT_INSTALL.md)
- [给其他 OpenClaw 自动安装的文档](./docs/OPENCLAW_AUTO_INSTALL.md)

---

## License

MIT

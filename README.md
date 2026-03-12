[中文](./README.md) | [English](./README.en.md)

# tg-stickers-chat

一个给 **OpenClaw** 用的 Telegram 贴纸聊天增强插件。

它的目标很简单：让 agent 在聊天里更自然地主动使用贴纸，丰富对话，而不是只会发纯文字。

## 截图示例

![tg-stickers-chat screenshot](https://raw.githubusercontent.com/MashiroCodfish/tg-stickers-chat/main/IMG_9061.jpeg)

---

## 快速安装

### 方式一：直接从 npm 安装

```bash
openclaw plugins install tg-stickers-chat
openclaw gateway restart
```

### 方式二：从 Release 包安装

先下载 Release 页面里的 `tg-stickers-chat-1.0.0.tgz`，然后执行：

```bash
openclaw plugins install ./tg-stickers-chat-1.0.0.tgz
openclaw gateway restart
```

### 方式三：从源码安装

```bash
git clone https://github.com/MashiroCodfish/tg-stickers-chat.git
cd tg-stickers-chat
npm install
openclaw plugins install .
openclaw gateway restart
```

---

## 技术栈

这个项目刻意保持简单，只用到这些东西：

- **OpenClaw Plugin API**：把插件接入 OpenClaw
- **Telegram Bot API**：拉取 sticker set 和 sticker 文件
- **Gemini Embedding 2**：给贴纸和查询词生成向量
- **SQLite**：本地存储向量索引
- **内存相似度搜索**：查询时直接在本地内存里匹配
- **ffmpeg（推荐）**：处理 `.tgs` / `.webm` 这类动图或视频贴纸的预览帧

---

## 实现原理

整个流程只有一条主路径：

1. 同步一个 Telegram 表情包合集
2. 下载每张贴纸文件
3. 如果是静态图就直接用原图；如果是动图或视频，就抽一帧预览图
4. 用 **Gemini Embedding 2** 给贴纸生成向量
5. 把向量存到本地 **SQLite**
6. 聊天时，agent 可以把语义查询转成向量
7. 在本地内存里做相似度匹配
8. 找到合适的 Telegram `sticker_id` 后发出去

如果打开了 `autoCollect`，聊天里出现新的表情包合集时，插件会自动把它加入处理队列；但索引和搜索核心逻辑不会变化。

插件会向 OpenClaw 提供这 3 个工具：

- `sync_sticker_set_by_name`
- `get_sticker_stats`
- `search_sticker_by_emotion`

---

## 配置

配置写在这里：

```text
plugins.entries.tg-stickers-chat
```

最小配置示例：

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

### 配置项说明

- `embeddingApiKey`
  - Gemini 的 API key
  - 没有它就没法建立向量索引

- `embeddingModel`
  - 默认值：`gemini-embedding-2-preview`
  - 一般不用改

- `embeddingDimensions`
  - 默认值：`768`
  - 一般不用改

- `autoCollect`
  - 是否自动收集聊天里新出现的表情包合集
  - `true` = 开启
  - `false` = 完全手动

如果你没有在插件配置里写 `embeddingApiKey`，插件也会尝试读取这些环境变量：

- `GEMINI_API_KEY`
- `GOOGLE_API_KEY`

如果你希望 agent 发贴纸更频繁一点、或者克制一点，也可以直接在聊天里告诉它，或者把偏好写进 memory，让它自己调整发贴纸的频率。

如果你要让别的 OpenClaw 实例全自动安装这个插件，可以看：

- [OpenClaw auto-install guide](./docs/OPENCLAW_AUTO_INSTALL.md)

---

## License

MIT

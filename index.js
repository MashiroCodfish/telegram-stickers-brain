const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const https = require('https');
const Database = require('better-sqlite3');
const { GoogleGenerativeAI } = require('@google/generative-ai');

module.exports = function registerTelegramStickersBrain(api) {
  const PLUGIN_ID = 'telegram-sticker-search';
  const STATE_DIR = api.runtime.state.resolveStateDir();
  const INDEX_DB_PATH = path.join(STATE_DIR, `${PLUGIN_ID}.sqlite`);
  const TMP_DIR = path.join(STATE_DIR, `${PLUGIN_ID}-tmp`);
  const CORE_CACHE_FILE = path.join(STATE_DIR, 'telegram', 'sticker-cache.json');

  fs.mkdirSync(TMP_DIR, { recursive: true });

  let indexDb = null;
  let searchCacheLoaded = false;
  let searchCache = [];
  let searchCacheById = new Map();

  let genAI = null;
  let genAIKey = '';
  const modelCache = new Map();

  const syncQueue = [];
  const queuedSets = new Set();
  const recentQueuedSets = new Map();
  let syncRunning = false;

  function getPluginConfig() {
    return api.config?.plugins?.entries?.[PLUGIN_ID]?.config || {};
  }

  function stripProviderPrefix(modelName) {
    if (!modelName || typeof modelName !== 'string') return '';
    return modelName.includes('/') ? modelName.split('/').pop() : modelName;
  }

  function getEmbeddingApiKey() {
    const config = getPluginConfig();
    const candidates = [
      config.embeddingApiKey,
      process.env.GEMINI_API_KEY,
      process.env.GOOGLE_API_KEY,
    ];

    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  }

  function getEmbeddingModelName() {
    return stripProviderPrefix(getPluginConfig().embeddingModel || 'gemini-embedding-2-preview');
  }

  function getEmbeddingDimensions() {
    const raw = Number(getPluginConfig().embeddingDimensions);
    if (Number.isInteger(raw) && raw >= 128 && raw <= 3072) return raw;
    return 768;
  }

  function getAutoCollectEnabled() {
    return getPluginConfig().autoCollect !== false;
  }

  function getBotToken() {
    const token = api.config?.channels?.telegram?.botToken
      || process.env.TELEGRAM_BOT_TOKEN
      || process.env.OPENCLAW_TELEGRAM_BOT_TOKEN
      || '';
    return typeof token === 'string' ? token.trim() : '';
  }

  function normalizeWhitespace(text) {
    return String(text ?? '')
      .replace(/\r/g, '')
      .replace(/\t/g, ' ')
      .replace(/\u00a0/g, ' ')
      .replace(/[ ]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function parseTs(value) {
    const ts = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(ts) ? ts : 0;
  }

  function normalizeVector(values) {
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error('Embedding vector is empty');
    }

    const vector = values.map(Number);
    let sumSq = 0;

    for (const value of vector) {
      if (!Number.isFinite(value)) {
        throw new Error('Embedding vector contains non-finite values');
      }
      sumSq += value * value;
    }

    if (sumSq <= 0) {
      throw new Error('Embedding vector norm is zero');
    }

    const invNorm = 1 / Math.sqrt(sumSq);
    return vector.map((value) => value * invNorm);
  }

  function dotProduct(a, b) {
    const length = Math.min(a.length, b.length);
    let score = 0;
    for (let i = 0; i < length; i += 1) {
      score += a[i] * b[i];
    }
    return score;
  }

  function ensureIndexDb() {
    if (!indexDb) {
      indexDb = new Database(INDEX_DB_PATH);
      indexDb.pragma('journal_mode = WAL');
      indexDb.pragma('synchronous = NORMAL');
      indexDb.exec(`
        CREATE TABLE IF NOT EXISTS stickers_index (
          file_unique_id TEXT PRIMARY KEY,
          file_id TEXT NOT NULL,
          emoji TEXT,
          set_name TEXT,
          embedding_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_stickers_index_set_name ON stickers_index(set_name);
        CREATE INDEX IF NOT EXISTS idx_stickers_index_updated_at ON stickers_index(updated_at);
      `);
    }
    return indexDb;
  }

  function checkpointIndexDb() {
    try {
      ensureIndexDb().pragma('wal_checkpoint(TRUNCATE)');
    } catch (e) {
      api.logger.warn(`[Stickers] WAL checkpoint skipped: ${e.message}`);
    }
  }

  function loadSearchCache(force = false) {
    if (searchCacheLoaded && !force) return searchCache;

    const rows = ensureIndexDb().prepare(`
      SELECT file_unique_id, file_id, emoji, set_name, embedding_json
      FROM stickers_index
    `).all();

    searchCache = [];
    searchCacheById = new Map();

    for (const row of rows) {
      try {
        const item = {
          fileUniqueId: row.file_unique_id,
          fileId: row.file_id,
          emoji: row.emoji || '',
          setName: row.set_name || '',
          embedding: JSON.parse(row.embedding_json),
        };
        searchCache.push(item);
        searchCacheById.set(item.fileUniqueId, item);
      } catch (e) {
        api.logger.warn(`[Stickers] Failed to load embedding for ${row.file_unique_id}: ${e.message}`);
      }
    }

    searchCacheLoaded = true;
    api.logger.info(`[Stickers] Loaded ${searchCache.length} sticker embeddings into memory.`);
    return searchCache;
  }

  function hasIndexedSticker(fileUniqueId) {
    if (!fileUniqueId) return false;
    if (searchCacheLoaded) return searchCacheById.has(fileUniqueId);
    const row = ensureIndexDb().prepare('SELECT 1 AS ok FROM stickers_index WHERE file_unique_id = ?').get(fileUniqueId);
    return !!row;
  }

  function upsertIndexedSticker(record) {
    ensureIndexDb().prepare(`
      INSERT INTO stickers_index (
        file_unique_id, file_id, emoji, set_name, embedding_json, updated_at
      ) VALUES (
        @file_unique_id, @file_id, @emoji, @set_name, @embedding_json, @updated_at
      )
      ON CONFLICT(file_unique_id) DO UPDATE SET
        file_id = excluded.file_id,
        emoji = excluded.emoji,
        set_name = excluded.set_name,
        embedding_json = excluded.embedding_json,
        updated_at = excluded.updated_at
    `).run(record);

    const cachedItem = {
      fileUniqueId: record.file_unique_id,
      fileId: record.file_id,
      emoji: record.emoji || '',
      setName: record.set_name || '',
      embedding: JSON.parse(record.embedding_json),
    };

    if (searchCacheLoaded) {
      const existing = searchCacheById.get(cachedItem.fileUniqueId);
      if (existing) {
        existing.fileId = cachedItem.fileId;
        existing.emoji = cachedItem.emoji;
        existing.setName = cachedItem.setName;
        existing.embedding = cachedItem.embedding;
      } else {
        searchCache.push(cachedItem);
        searchCacheById.set(cachedItem.fileUniqueId, cachedItem);
      }
    }
  }

  function getIndexedStickerCount() {
    const row = ensureIndexDb().prepare('SELECT COUNT(*) AS count FROM stickers_index').get();
    return Number(row?.count || 0);
  }

  function ensureCoreCache() {
    const dir = path.dirname(CORE_CACHE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(CORE_CACHE_FILE)) {
      fs.writeFileSync(CORE_CACHE_FILE, JSON.stringify({ stickers: {} }, null, 2));
    }
  }

  function readCoreCache() {
    ensureCoreCache();
    try {
      const parsed = JSON.parse(fs.readFileSync(CORE_CACHE_FILE, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return { stickers: {} };
      if (!parsed.stickers || typeof parsed.stickers !== 'object') parsed.stickers = {};
      return parsed;
    } catch (e) {
      api.logger.warn(`[Stickers] Failed to read core sticker cache: ${e.message}`);
      return { stickers: {} };
    }
  }

  function getSenderStickers(cache, senderId) {
    return Object.values(cache?.stickers || {})
      .filter((item) => item && item.receivedFrom === `telegram:${senderId}` && item.setName)
      .sort((a, b) => parseTs(b.cachedAt) - parseTs(a.cachedAt));
  }

  function guessMimeType(filePathValue) {
    const ext = String(path.extname(filePathValue || '')).toLowerCase();
    switch (ext) {
      case '.png': return 'image/png';
      case '.jpg':
      case '.jpeg': return 'image/jpeg';
      case '.webp': return 'image/webp';
      case '.gif': return 'image/gif';
      case '.webm': return 'video/webm';
      case '.tgs': return 'application/x-tgsticker';
      default: return 'application/octet-stream';
    }
  }

  async function downloadBuffer(url) {
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(downloadBuffer(res.headers.location));
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode}`));
          res.resume();
          return;
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    });
  }

  function makeTempBase(prefix = 'sticker') {
    return path.join(TMP_DIR, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  }

  function buildPreviewImage(buffer, filePathValue) {
    const mimeType = guessMimeType(filePathValue);

    if (mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/webp' || mimeType === 'image/gif') {
      return { buffer, mimeType, source: 'original' };
    }

    const tempBase = makeTempBase('preview');
    const inputPath = `${tempBase}${path.extname(filePathValue || '') || '.bin'}`;
    const outputPath = `${tempBase}.png`;

    try {
      fs.writeFileSync(inputPath, buffer);
      const result = cp.spawnSync('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', inputPath,
        '-frames:v', '1',
        outputPath,
      ], { encoding: 'utf8' });

      if (result.status === 0 && fs.existsSync(outputPath)) {
        return {
          buffer: fs.readFileSync(outputPath),
          mimeType: 'image/png',
          source: 'ffmpeg',
        };
      }

      api.logger.warn(`[Stickers] Preview conversion failed for ${filePathValue || 'unknown'}: ${normalizeWhitespace(result.stderr || '') || 'unknown ffmpeg error'}`);
      return null;
    } catch (e) {
      api.logger.warn(`[Stickers] Preview conversion error for ${filePathValue || 'unknown'}: ${e.message}`);
      return null;
    } finally {
      try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch (_) {}
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
    }
  }

  function getEmbeddingModel() {
    const apiKey = getEmbeddingApiKey();
    if (!apiKey) throw new Error('Gemini embedding API key not configured');

    if (!genAI || genAIKey !== apiKey) {
      genAI = new GoogleGenerativeAI(apiKey);
      genAIKey = apiKey;
      modelCache.clear();
    }

    const modelName = getEmbeddingModelName();
    if (!modelCache.has(modelName)) {
      modelCache.set(modelName, genAI.getGenerativeModel({ model: modelName }));
    }
    return modelCache.get(modelName);
  }

  function extractEmbeddingValues(response) {
    const values = response?.embedding?.values || response?.embedding?.vector || response?.embedding;
    if (!Array.isArray(values) || values.length === 0) {
      throw new Error('Embedding response missing values');
    }
    return values;
  }

  async function embedQueryText(queryText) {
    const response = await getEmbeddingModel().embedContent({
      content: { parts: [{ text: String(queryText || '').trim() }] },
      taskType: 'RETRIEVAL_QUERY',
      outputDimensionality: getEmbeddingDimensions(),
    });
    return normalizeVector(extractEmbeddingValues(response));
  }

  async function embedStickerDocument({ imageBuffer, imageMimeType, emoji, setName, fileUniqueId }) {
    const parts = [];

    if (imageBuffer && imageMimeType && String(imageMimeType).startsWith('image/')) {
      parts.push({
        inlineData: {
          data: imageBuffer.toString('base64'),
          mimeType: imageMimeType,
        }
      });
    }

    if (parts.length === 0) {
      const metadataText = [
        emoji ? `emoji: ${emoji}` : '',
        setName ? `set: ${setName}` : '',
        fileUniqueId ? `id: ${fileUniqueId}` : '',
      ].filter(Boolean).join('\n');

      if (!metadataText) {
        throw new Error('No image preview or metadata available to embed');
      }

      parts.push({ text: metadataText });
    }

    const response = await getEmbeddingModel().embedContent({
      content: { parts },
      taskType: 'RETRIEVAL_DOCUMENT',
      title: setName || fileUniqueId || 'telegram-sticker',
      outputDimensionality: getEmbeddingDimensions(),
    });

    return normalizeVector(extractEmbeddingValues(response));
  }

  async function tgRequest(method, params = {}) {
    const token = getBotToken();
    if (!token) throw new Error('Telegram bot token not found');

    return new Promise((resolve, reject) => {
      const req = https.request(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.ok) resolve(result.result);
            else reject(new Error(result.description || `Telegram API error: ${method}`));
          } catch (e) {
            reject(new Error(`Failed to parse Telegram API response for ${method}: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.write(JSON.stringify(params));
      req.end();
    });
  }

  async function indexSticker({ sticker, setName }) {
    if (!sticker?.file_id || !sticker?.file_unique_id) {
      throw new Error('Sticker is missing file identifiers');
    }

    if (hasIndexedSticker(sticker.file_unique_id)) {
      return { skipped: true, reason: 'already-indexed' };
    }

    const fileInfo = await tgRequest('getFile', { file_id: sticker.file_id });
    if (!fileInfo?.file_path) {
      throw new Error(`Telegram did not return file_path for ${sticker.file_unique_id}`);
    }

    const downloadUrl = `https://api.telegram.org/file/bot${getBotToken()}/${fileInfo.file_path}`;
    const originalBuffer = await downloadBuffer(downloadUrl);
    const previewImage = buildPreviewImage(originalBuffer, fileInfo.file_path);

    const vector = await embedStickerDocument({
      imageBuffer: previewImage?.buffer || null,
      imageMimeType: previewImage?.mimeType || '',
      emoji: sticker.emoji || '',
      setName: setName || '',
      fileUniqueId: sticker.file_unique_id,
    });

    upsertIndexedSticker({
      file_unique_id: sticker.file_unique_id,
      file_id: sticker.file_id,
      emoji: sticker.emoji || '',
      set_name: setName || '',
      embedding_json: JSON.stringify(vector),
      updated_at: new Date().toISOString(),
    });

    return {
      skipped: false,
      source: previewImage?.source || 'metadata-only',
    };
  }

  async function syncStickerSet(setName) {
    const stickerSet = await tgRequest('getStickerSet', { name: setName });
    const stickers = Array.isArray(stickerSet?.stickers) ? stickerSet.stickers : [];

    let indexedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const sticker of stickers) {
      try {
        const result = await indexSticker({ sticker, setName });
        if (result.skipped) skippedCount += 1;
        else indexedCount += 1;
      } catch (e) {
        failedCount += 1;
        api.logger.warn(`[Stickers] Failed to index ${sticker?.file_unique_id || 'unknown'} in ${setName}: ${e.message}`);
      }
    }

    checkpointIndexDb();
    return {
      setName,
      total: stickers.length,
      indexedCount,
      skippedCount,
      failedCount,
    };
  }

  async function searchSticker(queryText) {
    const trimmedQuery = String(queryText || '').trim();
    if (!trimmedQuery) throw new Error('Search query is empty');

    loadSearchCache();
    if (searchCache.length === 0) throw new Error('Sticker index is empty');

    const queryVector = await embedQueryText(trimmedQuery);
    let best = null;

    for (const item of searchCache) {
      const score = dotProduct(queryVector, item.embedding);
      if (!best || score > best.score) {
        best = {
          fileId: item.fileId,
          fileUniqueId: item.fileUniqueId,
          score,
          source: 'embedding2-local-search',
        };
      }
    }

    if (!best) throw new Error('No sticker candidates found');
    return best;
  }

  function normalizeSetName(value) {
    let text = String(value || '').trim();
    if (!text) return '';

    text = text.replace(/^https?:\/\/t\.me\/addstickers\//i, '');
    text = text.replace(/^https?:\/\/telegram\.me\/addstickers\//i, '');
    text = text.split('?')[0].trim();
    return text;
  }

  async function processSyncQueue() {
    if (syncRunning) return;
    syncRunning = true;

    try {
      while (syncQueue.length > 0) {
        const setName = syncQueue.shift();
        try {
          api.logger.info(`[Stickers] Syncing set: ${setName}`);
          const summary = await syncStickerSet(setName);
          api.logger.info(`[Stickers] Set ${setName} synced (${summary.indexedCount} indexed, ${summary.skippedCount} skipped, ${summary.failedCount} failed).`);
        } catch (e) {
          api.logger.error(`[Stickers] Error syncing set ${setName}: ${e.message}`);
        } finally {
          queuedSets.delete(setName);
        }
      }
    } finally {
      syncRunning = false;
    }
  }

  function queueSetOnce(setName, reason = 'manual') {
    if (!setName) return false;

    const now = Date.now();
    const lastQueuedAt = recentQueuedSets.get(setName) || 0;
    if (queuedSets.has(setName) || (now - lastQueuedAt) < 10 * 60 * 1000) {
      return false;
    }

    recentQueuedSets.set(setName, now);
    queuedSets.add(setName);
    syncQueue.push(setName);
    api.logger.info(`[Stickers] Queued set ${setName} (${reason})`);
    processSyncQueue().catch((e) => {
      api.logger.error(`[Stickers] Queue processing crashed: ${e.message}`);
    });
    return true;
  }

  if (api.on) {
    api.on('message_received', async (event) => {
      const channel = event.metadata?.channel || event.metadata?.originatingChannel;
      if (channel !== 'telegram') return;
      if (!getAutoCollectEnabled()) return;
      if (!event.content || (!event.content.includes('<media:sticker>') && !event.content.includes('sticker'))) return;

      let senderId;
      let baselineLatestTs = 0;

      try {
        senderId = event.metadata?.senderId || event.from?.split(':')?.[1];
        if (!senderId) return;
        const cache = readCoreCache();
        const existing = getSenderStickers(cache, senderId);
        baselineLatestTs = existing.length > 0 ? parseTs(existing[0].cachedAt) : 0;
      } catch (e) {
        api.logger.warn(`[Stickers] Failed to capture baseline sticker cache: ${e.message}`);
      }

      setTimeout(() => {
        try {
          if (!senderId) return;
          const cache = readCoreCache();
          const senderStickers = getSenderStickers(cache, senderId);
          if (senderStickers.length === 0) return;

          const newStickers = senderStickers.filter((item) => parseTs(item.cachedAt) > baselineLatestTs + 1);
          let matchedSticker = newStickers[0] || null;

          if (!matchedSticker) {
            const now = Date.now();
            const recent = senderStickers.filter((item) => (now - parseTs(item.cachedAt)) <= 15 * 1000);
            const uniqueRecentSets = [...new Set(recent.map((item) => item.setName))];
            if (recent.length === 1 || uniqueRecentSets.length === 1) {
              matchedSticker = recent[0];
              api.logger.info(`[Stickers] Falling back to recent sticker match for sender ${senderId}: ${matchedSticker.setName}`);
            }
          }

          if (!matchedSticker?.setName) {
            api.logger.warn(`[Stickers] Could not confidently resolve sticker set for sender ${senderId}; skipping auto-sync to avoid false positives.`);
            return;
          }

          queueSetOnce(matchedSticker.setName, `auto-detect sender=${senderId} sticker=${matchedSticker.fileUniqueId || 'unknown'}`);
        } catch (e) {
          api.logger.error(`[Stickers] Failed to detect sticker set from cache: ${e.message}`);
        }
      }, 2500);
    });
  }

  api.registerTool({
    name: 'sync_sticker_set_by_name',
    emoji: '📥',
    description: '通过表情包合集的名字（或者包含名字的链接）来手动同步一个 Telegram 表情包合集。当用户发给你一个表情包链接，或者告诉你合集名字让你收集时调用。',
    parameters: {
      type: 'object',
      properties: {
        setNameOrUrl: {
          type: 'string',
          description: '合集的名字（例如：AnimalPack）或者合集的分享链接（例如：https://t.me/addstickers/AnimalPack）'
        }
      },
      required: ['setNameOrUrl']
    },
    async execute(id, params) {
      try {
        const targetSetName = normalizeSetName(params.setNameOrUrl);
        if (!targetSetName) {
          return { content: [{ type: 'text', text: '无法从你提供的参数中提取合集名称，请检查格式。' }] };
        }

        const queued = queueSetOnce(targetSetName, 'manual-tool');
        if (!queued) {
          return { content: [{ type: 'text', text: `表情包合集 ${targetSetName} 已经在同步队列里了。` }] };
        }

        return {
          content: [{
            type: 'text',
            text: `好的，我已经把合集 ${targetSetName} 加入同步队列了。这一版只会用 Gemini Embedding 2 建索引，并在本地做向量相似度搜索。`
          }]
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `同步任务提交失败: ${e.message}` }] };
      }
    }
  });

  api.registerTool({
    name: 'get_sticker_stats',
    emoji: '📊',
    description: '查询当前表情包库中已处理和索引的表情包数量。当用户询问表情包库状态、进度时调用。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const indexedCount = getIndexedStickerCount();
      const queuedCount = syncQueue.length + (syncRunning ? 1 : 0);
      const autoCollectText = getAutoCollectEnabled() ? '开启' : '关闭';
      return {
        content: [{
          type: 'text',
          text: `当前语义索引中共有 ${indexedCount} 张表情包，当前同步队列中有 ${queuedCount} 个合集，自动收集目前为${autoCollectText}。`
        }]
      };
    }
  });

  api.registerTool({
    name: 'search_sticker_by_emotion',
    emoji: '🔎',
    description: '通过语义（情感、动作、特征）搜索表情包库，并返回匹配的 sticker_id，用于随后通过 message(action=sticker) 发送。\n构建 query 时，请使用具体的情绪、动作、视觉特征的中文词汇组合（如 开心 笑着 跑 或 无奈 叹气 摆烂）。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '表情包的语义搜索词（例如：开心 笑着 跑）'
        }
      },
      required: ['query']
    },
    async execute(id, params) {
      const startedAt = Date.now();
      const queryText = String(params.query || '').trim();
      api.logger.info(`[Stickers] Semantic search for: "${queryText}"`);

      try {
        const result = await searchSticker(queryText);
        api.logger.info(`[Stickers] Search for "${queryText}" took ${Date.now() - startedAt}ms via ${result.source} (score=${result.score.toFixed(4)})`);
        return { content: [{ type: 'text', text: `{"sticker_id": "${result.fileId}"}` }] };
      } catch (e) {
        api.logger.error(`[Stickers] Search error: ${e.message}`);
        return { content: [{ type: 'text', text: `搜索失败: ${e.message}` }] };
      }
    }
  });

  ensureIndexDb();
  ensureCoreCache();
  loadSearchCache();
};

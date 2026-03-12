const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const https = require('https');
const Database = require('better-sqlite3');
const { GoogleGenerativeAI } = require('@google/generative-ai');

module.exports = function(api) {
  (async () => {
    const PLUGIN_ID = 'telegram-stickers-brain';
    const STATE_DIR = api.runtime.state.resolveStateDir();
    const CORE_CACHE_FILE = path.join(STATE_DIR, 'telegram', 'sticker-cache.json');
    const METADATA_DIR = '/root/.openclaw/workspace/stickers_metadata';
    const INDEX_DB_PATH = path.join(STATE_DIR, `${PLUGIN_ID}.sqlite`);
    const TMP_DIR = path.join(STATE_DIR, `${PLUGIN_ID}-tmp`);

    fs.mkdirSync(METADATA_DIR, { recursive: true });
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(CORE_CACHE_FILE), { recursive: true });

    let indexDb = null;
    let searchCacheLoaded = false;
    let searchCache = [];
    let searchCacheById = new Map();

    let genAI = null;
    let genAIKey = null;
    const modelCache = new Map();

    const queue = [];
    let isProcessing = false;
    let isBackfilling = false;
    let serviceInterval = null;
    const recentQueuedSets = new Map();

    function getPluginConfig() {
      return api.config?.plugins?.entries?.[PLUGIN_ID]?.config || {};
    }

    function stripProviderPrefix(modelName) {
      if (!modelName || typeof modelName !== 'string') return '';
      return modelName.includes('/') ? modelName.split('/').pop() : modelName;
    }

    function getGeminiApiKey() {
      const config = getPluginConfig();
      const candidates = [
        config.embeddingApiKey,
        config.vlmApiKey,
        process.env.GEMINI_API_KEY,
        process.env.GOOGLE_API_KEY,
        process.env.VLM_API_KEY,
      ];
      for (const value of candidates) {
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
      return '';
    }

    function getCaptionModelName() {
      return stripProviderPrefix(getPluginConfig().vlmModel || 'gemini-3.1-flash-lite-preview');
    }

    function getEmbeddingModelName() {
      return stripProviderPrefix(getPluginConfig().embeddingModel || 'gemini-embedding-2-preview');
    }

    function getEmbeddingDimensions() {
      const raw = Number(getPluginConfig().embeddingDimensions);
      if (Number.isInteger(raw) && raw >= 128 && raw <= 3072) return raw;
      return 768;
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

    function q(value) {
      return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
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
      for (let i = 0; i < length; i++) {
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
            description TEXT,
            embedding_json TEXT NOT NULL,
            embedding_model TEXT NOT NULL,
            embedding_dims INTEGER NOT NULL,
            embedding_mode TEXT NOT NULL,
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
        SELECT file_unique_id, file_id, emoji, set_name, description, embedding_json
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
            description: row.description || '',
            embedding: JSON.parse(row.embedding_json),
          };
          searchCache.push(item);
          searchCacheById.set(item.fileUniqueId, item);
        } catch (e) {
          api.logger.warn(`[Stickers] Failed to load cached embedding for ${row.file_unique_id}: ${e.message}`);
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
          file_unique_id, file_id, emoji, set_name, description,
          embedding_json, embedding_model, embedding_dims, embedding_mode, updated_at
        ) VALUES (
          @file_unique_id, @file_id, @emoji, @set_name, @description,
          @embedding_json, @embedding_model, @embedding_dims, @embedding_mode, @updated_at
        )
        ON CONFLICT(file_unique_id) DO UPDATE SET
          file_id = excluded.file_id,
          emoji = excluded.emoji,
          set_name = excluded.set_name,
          description = excluded.description,
          embedding_json = excluded.embedding_json,
          embedding_model = excluded.embedding_model,
          embedding_dims = excluded.embedding_dims,
          embedding_mode = excluded.embedding_mode,
          updated_at = excluded.updated_at
      `).run(record);

      const cachedItem = {
        fileUniqueId: record.file_unique_id,
        fileId: record.file_id,
        emoji: record.emoji || '',
        setName: record.set_name || '',
        description: record.description || '',
        embedding: JSON.parse(record.embedding_json),
      };

      if (searchCacheLoaded) {
        const existing = searchCacheById.get(cachedItem.fileUniqueId);
        if (existing) {
          existing.fileId = cachedItem.fileId;
          existing.emoji = cachedItem.emoji;
          existing.setName = cachedItem.setName;
          existing.description = cachedItem.description;
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

    function getQmdStickerCount() {
      return fs.readdirSync(METADATA_DIR).filter((name) => name.endsWith('.qmd')).length;
    }

    function ensureCoreCache() {
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

    function writeCoreCache(cache) {
      ensureCoreCache();
      fs.writeFileSync(CORE_CACHE_FILE, JSON.stringify(cache, null, 2));
    }

    function updateCoreStickerCache(sticker, setName, description) {
      try {
        const cache = readCoreCache();
        cache.stickers[sticker.file_unique_id] = {
          fileId: sticker.file_id,
          fileUniqueId: sticker.file_unique_id,
          emoji: sticker.emoji,
          setName,
          description,
          cachedAt: new Date().toISOString(),
          receivedFrom: 'plugin:telegram-stickers',
        };
        writeCoreCache(cache);
      } catch (e) {
        api.logger.warn(`[Stickers] Failed to update core sticker cache: ${e.message}`);
      }
    }

    function parseQmdFile(qmdPath) {
      if (!fs.existsSync(qmdPath)) return null;
      try {
        const content = fs.readFileSync(qmdPath, 'utf8');
        const getField = (name) => {
          const match = content.match(new RegExp(`^${name}: \"(.*?)\"$`, 'm'));
          return match ? match[1] : '';
        };
        const descriptionMatch = content.match(/# Sticker Description\n([\s\S]*)$/);
        return {
          fileId: getField('file_id'),
          fileUniqueId: getField('file_unique_id'),
          emoji: getField('emoji'),
          setName: getField('set_name'),
          description: normalizeWhitespace(descriptionMatch ? descriptionMatch[1] : ''),
        };
      } catch (e) {
        api.logger.warn(`[Stickers] Failed to parse ${qmdPath}: ${e.message}`);
        return null;
      }
    }

    function writeQmdFile(sticker, setName, description) {
      const qmdPath = path.join(METADATA_DIR, `${sticker.file_unique_id}.qmd`);
      fs.writeFileSync(qmdPath, `---
file_id: "${q(sticker.file_id)}"
file_unique_id: "${q(sticker.file_unique_id)}"
emoji: "${q(sticker.emoji || '')}"
set_name: "${q(setName || '')}"
---
# Sticker Description
${description || '无法生成描述'}
`);
      return qmdPath;
    }

    function getSenderStickers(cache, senderId) {
      return Object.values(cache?.stickers || {})
        .filter((item) => item && item.receivedFrom === `telegram:${senderId}` && item.setName)
        .sort((a, b) => parseTs(b.cachedAt) - parseTs(a.cachedAt));
    }

    function queueSetOnce(setName, reason = 'unknown') {
      if (!setName) return false;
      const now = Date.now();
      const lastQueuedAt = recentQueuedSets.get(setName) || 0;
      if (queue.includes(setName) || (now - lastQueuedAt) < 10 * 60 * 1000) {
        api.logger.info(`[Stickers] Skip queueing ${setName} (${reason}) - already queued recently.`);
        return false;
      }
      recentQueuedSets.set(setName, now);
      queue.push(setName);
      api.logger.info(`[Stickers] Queued set ${setName} (${reason}).`);
      return true;
    }

    function guessMimeType(filePathValue) {
      const ext = path.extname(filePathValue || '').toLowerCase();
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
      if (mimeType === 'image/png' || mimeType === 'image/jpeg') {
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

    function getGenAIModel(modelName) {
      const apiKey = getGeminiApiKey();
      if (!apiKey) throw new Error('Gemini API key not configured');
      if (!genAI || genAIKey !== apiKey) {
        genAI = new GoogleGenerativeAI(apiKey);
        genAIKey = apiKey;
        modelCache.clear();
      }
      const cleanName = stripProviderPrefix(modelName);
      if (!modelCache.has(cleanName)) {
        modelCache.set(cleanName, genAI.getGenerativeModel({ model: cleanName }));
      }
      return modelCache.get(cleanName);
    }

    function extractEmbeddingValues(response) {
      const values = response?.embedding?.values || response?.embedding?.vector || response?.embedding;
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error('Embedding response missing values');
      }
      return values;
    }

    async function embedQueryText(queryText) {
      const response = await getGenAIModel(getEmbeddingModelName()).embedContent({
        content: { parts: [{ text: String(queryText || '').trim() }] },
        taskType: 'RETRIEVAL_QUERY',
        outputDimensionality: getEmbeddingDimensions(),
      });
      return normalizeVector(extractEmbeddingValues(response));
    }

    async function embedStickerDocument({ caption, emoji, setName, fileUniqueId, imageBuffer, imageMimeType }) {
      const parts = [];
      const textParts = [];
      const cleanedCaption = normalizeWhitespace(caption || '');

      if (cleanedCaption) textParts.push(cleanedCaption);
      if (!cleanedCaption && emoji) textParts.push(`emoji: ${emoji}`);
      if (setName) textParts.push(`set: ${setName}`);
      if (fileUniqueId) textParts.push(`id: ${fileUniqueId}`);
      if (textParts.length > 0) parts.push({ text: textParts.join('\n') });
      if (imageBuffer && imageMimeType && String(imageMimeType).startsWith('image/')) {
        parts.push({
          inlineData: {
            data: imageBuffer.toString('base64'),
            mimeType: imageMimeType,
          }
        });
      }
      if (parts.length === 0) throw new Error('No content available to embed sticker document');

      const response = await getGenAIModel(getEmbeddingModelName()).embedContent({
        content: { parts },
        taskType: 'RETRIEVAL_DOCUMENT',
        title: setName || fileUniqueId || 'telegram-sticker',
        outputDimensionality: getEmbeddingDimensions(),
      });
      return normalizeVector(extractEmbeddingValues(response));
    }

    async function generateStickerDescription(imageBuffer, imageMimeType) {
      const prompt = '请用中文简洁描述这个表情包的情绪、动作和角色特征。尽量抓住聊天时会用到的感觉词，不要写太长。';
      const result = await getGenAIModel(getCaptionModelName()).generateContent([
        prompt,
        {
          inlineData: {
            data: imageBuffer.toString('base64'),
            mimeType: imageMimeType,
          }
        }
      ]);
      const response = await result.response;
      return normalizeWhitespace(response?.text ? response.text() : '') || '无法生成描述';
    }

    async function tgRequest(method, params = {}) {
      const token = getBotToken();
      if (!token) throw new Error('Bot token not found');
      return new Promise((resolve, reject) => {
        const req = https.request(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
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

    async function notifyAdmin(text) {
      const target = getPluginConfig().notifyChatId;
      if (!target) return;
      try {
        await tgRequest('sendMessage', { chat_id: target, text });
      } catch (e) {
        api.logger.warn(`[Stickers] Failed to notify admin: ${e.message}`);
      }
    }

    async function maybeCaptionSticker({ existingCaption, previewImage, originalBuffer, originalMimeType }) {
      const existing = normalizeWhitespace(existingCaption || '');
      if (existing && existing !== '无法生成描述') return existing;

      try {
        if (previewImage?.buffer && previewImage?.mimeType) {
          return await generateStickerDescription(previewImage.buffer, previewImage.mimeType);
        }
        if (originalBuffer && String(originalMimeType).startsWith('image/')) {
          return await generateStickerDescription(originalBuffer, originalMimeType);
        }
      } catch (e) {
        api.logger.warn(`[Stickers] Sticker captioning failed: ${e.message}`);
      }

      return existing || '无法生成描述';
    }

    async function indexSticker({ sticker, setName, existingMeta = null }) {
      const qmdPath = path.join(METADATA_DIR, `${sticker.file_unique_id}.qmd`);
      if (hasIndexedSticker(sticker.file_unique_id) && fs.existsSync(qmdPath)) {
        return { skipped: true, reason: 'already-indexed' };
      }

      const fileInfo = await tgRequest('getFile', { file_id: sticker.file_id });
      if (!fileInfo?.file_path) {
        throw new Error(`Telegram did not return file_path for ${sticker.file_unique_id}`);
      }

      const filePathValue = fileInfo.file_path;
      const downloadUrl = `https://api.telegram.org/file/bot${getBotToken()}/${filePathValue}`;
      const originalBuffer = await downloadBuffer(downloadUrl);
      const originalMimeType = guessMimeType(filePathValue);
      const previewImage = buildPreviewImage(originalBuffer, filePathValue);

      const caption = await maybeCaptionSticker({
        existingCaption: existingMeta?.description,
        previewImage,
        originalBuffer,
        originalMimeType,
      });

      if (!fs.existsSync(qmdPath) || caption !== (existingMeta?.description || '')) {
        writeQmdFile(sticker, setName, caption);
      }

      let embeddingMode = 'text-only';
      let vector;
      try {
        vector = await embedStickerDocument({
          caption,
          emoji: sticker.emoji,
          setName,
          fileUniqueId: sticker.file_unique_id,
          imageBuffer: previewImage?.buffer || null,
          imageMimeType: previewImage?.mimeType || '',
        });
        if (previewImage?.buffer) embeddingMode = 'image+caption';
      } catch (e) {
        api.logger.warn(`[Stickers] Multimodal embedding failed for ${sticker.file_unique_id}, retrying text-only: ${e.message}`);
        vector = await embedStickerDocument({
          caption,
          emoji: sticker.emoji,
          setName,
          fileUniqueId: sticker.file_unique_id,
          imageBuffer: null,
          imageMimeType: '',
        });
      }

      upsertIndexedSticker({
        file_unique_id: sticker.file_unique_id,
        file_id: sticker.file_id,
        emoji: sticker.emoji || '',
        set_name: setName || '',
        description: caption,
        embedding_json: JSON.stringify(vector),
        embedding_model: getEmbeddingModelName(),
        embedding_dims: getEmbeddingDimensions(),
        embedding_mode: embeddingMode,
        updated_at: new Date().toISOString(),
      });

      updateCoreStickerCache(sticker, setName, caption);
      return { skipped: false, embeddingMode, caption };
    }

    async function processQueue() {
      if (isProcessing || queue.length === 0) return;
      isProcessing = true;

      while (queue.length > 0) {
        const setName = queue.shift();
        try {
          api.logger.info(`[Stickers] Syncing set: ${setName}`);
          await notifyAdmin(`🔄 [Stickers] 开始同步表情包合集: ${setName}`);
          const stickerSet = await tgRequest('getStickerSet', { name: setName });

          let indexedCount = 0;
          let skippedCount = 0;
          for (const sticker of stickerSet.stickers || []) {
            try {
              const existingMeta = parseQmdFile(path.join(METADATA_DIR, `${sticker.file_unique_id}.qmd`));
              const result = await indexSticker({ sticker, setName, existingMeta });
              if (result.skipped) skippedCount += 1;
              else indexedCount += 1;
            } catch (e) {
              api.logger.warn(`[Stickers] Failed to index ${sticker.file_unique_id} in ${setName}: ${e.message}`);
            }
          }

          checkpointIndexDb();
          api.logger.info(`[Stickers] Set ${setName} processed (${indexedCount} indexed/updated, ${skippedCount} skipped).`);
          await notifyAdmin(`✅ [Stickers] 表情包合集 ${setName} 同步完成，新增或更新 ${indexedCount} 张，跳过 ${skippedCount} 张。`);
        } catch (e) {
          api.logger.error(`[Stickers] Error processing set ${setName}: ${e.message}`);
          await notifyAdmin(`❌ [Stickers] 同步表情包合集 ${setName} 失败: ${e.message}`);
        }
      }

      isProcessing = false;
    }

    async function backfillMetadataBatch(limit = 8) {
      if (isBackfilling || isProcessing) return 0;
      if (!getGeminiApiKey()) return 0;

      isBackfilling = true;
      let processed = 0;

      try {
        const files = fs.readdirSync(METADATA_DIR)
          .filter((name) => name.endsWith('.qmd'))
          .sort();

        for (const filename of files) {
          if (processed >= limit) break;
          const fileUniqueId = filename.replace(/\.qmd$/, '');
          if (hasIndexedSticker(fileUniqueId)) continue;

          const meta = parseQmdFile(path.join(METADATA_DIR, filename));
          if (!meta?.fileId || !meta?.fileUniqueId) continue;

          try {
            await indexSticker({
              sticker: {
                file_id: meta.fileId,
                file_unique_id: meta.fileUniqueId,
                emoji: meta.emoji || '',
              },
              setName: meta.setName || '',
              existingMeta: meta,
            });
            processed += 1;
          } catch (e) {
            api.logger.warn(`[Stickers] Metadata backfill failed for ${meta.fileUniqueId}: ${e.message}`);
          }
        }
      } finally {
        isBackfilling = false;
      }

      if (processed > 0) {
        checkpointIndexDb();
        api.logger.info(`[Stickers] Backfilled ${processed} stickers into the live index.`);
      }
      return processed;
    }

    async function ensureWarmIndex() {
      loadSearchCache();
      if (searchCache.length > 0) return;
      await backfillMetadataBatch(24);
      loadSearchCache(true);
    }

    async function searchSticker(queryText) {
      const trimmedQuery = String(queryText || '').trim();
      if (!trimmedQuery) throw new Error('Search query is empty');

      await ensureWarmIndex();
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
            source: 'embedding2',
          };
        }
      }

      if (!best) throw new Error('No sticker candidates found');
      return best;
    }

    api.registerService({
      id: 'telegram-stickers-sync',
      start: () => {
        serviceInterval = setInterval(() => {
          processQueue().catch((e) => api.logger.error(`[Stickers] Sync error: ${e.message}`));
          backfillMetadataBatch(6).catch((e) => api.logger.error(`[Stickers] Backfill error: ${e.message}`));
        }, 5000);

        setTimeout(() => {
          backfillMetadataBatch(24).catch((e) => api.logger.error(`[Stickers] Initial backfill error: ${e.message}`));
        }, 1500);
      },
      stop: () => {
        if (serviceInterval) clearInterval(serviceInterval);
      }
    });

    if (api.on) {
      api.on('message_received', async (event) => {
        const channel = event.metadata?.channel || event.metadata?.originatingChannel;
        if (channel !== 'telegram') return;
        if (getPluginConfig().autoCollect !== true) return;
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
          let targetSetName = String(params.setNameOrUrl || '').trim();
          if (targetSetName.includes('t.me/addstickers/')) {
            const parts = targetSetName.split('/');
            targetSetName = parts[parts.length - 1].split('?')[0];
          }
          if (!targetSetName) {
            return { content: [{ type: 'text', text: '无法从你提供的参数中提取合集名称，请检查格式！' }] };
          }
          if (queue.includes(targetSetName)) {
            return { content: [{ type: 'text', text: `表情包合集 ${targetSetName} 已经在同步队列中啦！` }] };
          }
          queueSetOnce(targetSetName, 'manual-tool');
          return { content: [{ type: 'text', text: `好的！我已经把合集 ${targetSetName} 加入后台同步队列了，同步完成后我会再通知。` }] };
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
        const qmdCount = getQmdStickerCount();
        const indexedCount = getIndexedStickerCount();
        return {
          content: [{
            type: 'text',
            text: `当前表情包库中共有 ${qmdCount} 张表情包元数据，其中 ${indexedCount} 张已经写入当前语义索引。`
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
    loadSearchCache();
    ensureCoreCache();
  })().catch((e) => {
    api.logger.error(`[Stickers] Plugin initialization failed: ${e.message}`);
  });
};

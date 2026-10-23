// 表情字节的磁盘缓存，默认不过期。调用方负责校验图片签名和当前媒体限额。
// 临时文件写完后再 rename，避免本模块的读操作看到尚未完成的写入。
import fs from 'node:fs';
import path from 'node:path';

const SAFE_KEY = /^[A-Za-z0-9._-]{1,128}$/;
const CACHE_EXT = '.img';

/** 把任意表情标识收敛成安全的缓存文件名；不安全/为空时返回 null。 */
export function normalizeCacheKey(raw) {
  const key = String(raw ?? '').trim();
  if (!key) return null;
  if (SAFE_KEY.test(key)) return key;
  // 含路径分隔符、中文备注、空格等的标识：替换成下划线后再校验，
  // 保证缓存路径永远落在缓存目录内（不会因为 id 里有 `..` 或 `/` 写到别处）。
  const cleaned = key.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 128);
  if (!cleaned || /^\.*$/.test(cleaned)) return null;
  return cleaned;
}

/**
 * @param {string} dir 缓存目录（通常是 state/sticker-cache）
 * @param {{ maxBytes?: number, maxAgeMs?: number, logger?: (msg: string) => void }} [options]
 *   maxBytes —— 缓存总字节上限，超出后按最近使用时间淘汰最旧的（默认 64MB）；
 *   maxAgeMs —— 可选的最大存活时间，0 表示永不过期（默认，因为 md5 内容不可变）。
 */
export function createStickerCache(dir, { maxBytes = 64 * 1024 * 1024, maxAgeMs = 0, logger = null } = {}) {
  const root = path.resolve(dir);
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.round(maxBytes) : 0;
  const ttl = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? Math.round(maxAgeMs) : 0;
  const warn = (message) => {
    if (logger) logger(message);
  };
  let totalBytes = null; // 惰性统计的缓存总大小

  function fileFor(key) {
    const safe = normalizeCacheKey(key);
    return safe ? path.join(root, `${safe}${CACHE_EXT}`) : null;
  }

  function readEntries() {
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      return [];
    }
    const entries = [];
    for (const name of names) {
      if (!name.endsWith(CACHE_EXT)) continue;
      const file = path.join(root, name);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) entries.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // 正在被淘汰/被外部删除：跳过即可
      }
    }
    return entries;
  }

  /** 读缓存；命中时顺手 touch 一下 mtime，让淘汰顺序近似 LRU。 */
  function get(key) {
    const file = fileFor(key);
    if (!file) return null;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size <= 0) return null;
      if (ttl > 0 && Date.now() - stat.mtimeMs > ttl) {
        fs.rmSync(file, { force: true });
        totalBytes = null;
        return null;
      }
      const buffer = fs.readFileSync(file);
      // 读到一半被截断（外部清理/磁盘异常）：按未命中处理，别把坏图发出去。
      if (buffer.length !== stat.size) return null;
      const now = Date.now();
      try {
        fs.utimesSync(file, new Date(now), new Date(now));
      } catch {
        // 只影响淘汰顺序，失败无所谓
      }
      return buffer;
    } catch {
      return null;
    }
  }

  /** 写缓存（原子替换）；超过总量上限时淘汰最旧的。失败只影响性能，不抛错。 */
  function set(key, buffer) {
    const file = fileFor(key);
    if (!file || !Buffer.isBuffer(buffer) || buffer.length === 0) return false;
    // 单张就超过整个上限：不写，否则每次都会把缓存清空一遍。
    if (limit > 0 && buffer.length > limit) return false;
    if (limit === 0) return false;
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(tmp, buffer);
      fs.renameSync(tmp, file);
      totalBytes = null;
      prune();
      return true;
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // 临时文件清理失败不影响正确性，下次 prune 会当成 .tmp 忽略
      }
      warn(`表情缓存写入失败（不影响本次发送）：${error?.message ?? error}`);
      return false;
    }
  }

  /** 按 mtime 从旧到新淘汰，直到总量回到上限内。返回删除的文件数。 */
  function prune() {
    const entries = readEntries();
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total <= limit) {
      totalBytes = total;
      return 0;
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let removed = 0;
    for (const entry of entries) {
      if (total <= limit) break;
      try {
        fs.rmSync(entry.file, { force: true });
        total -= entry.size;
        removed += 1;
      } catch {
        // 删不掉就跳过，别让缓存维护影响发送
      }
    }
    totalBytes = total;
    return removed;
  }

  function stats() {
    const entries = readEntries();
    const bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    totalBytes = bytes;
    return { dir: root, files: entries.length, bytes, maxBytes: limit };
  }

  function clear() {
    let removed = 0;
    for (const entry of readEntries()) {
      try {
        fs.rmSync(entry.file, { force: true });
        removed += 1;
      } catch {
        // 忽略
      }
    }
    totalBytes = 0;
    return removed;
  }

  return {
    dir: root,
    get,
    set,
    prune,
    stats,
    clear,
    get totalBytes() {
      if (totalBytes === null) totalBytes = readEntries().reduce((sum, entry) => sum + entry.size, 0);
      return totalBytes;
    }
  };
}

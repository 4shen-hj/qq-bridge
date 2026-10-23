// DSH 端口自动发现。
//
// 为什么需要：桌面版 DSH 用 `--port 0` 启动，每次重启都会换一个随机端口，
// 而 config.json 的 `dsh.baseUrl` 是具体的 host:port。DSH 一重启，桥接就指向
// 一个已经没人监听的地址，日志表现为「连上事件流后 0 帧」或 `fetch failed`，
// 但提示会误报成「协议/版本不匹配」。
//
// 做法：枚举本机 127.0.0.1 的监听端口，用 DSH 自己的未鉴权响应做指纹
// （`dsh web authentication required`，或带 `__DSH_BOOT__` 的引导页），
// 命中后再由调用方用铸造的 Cookie 做一次真实 RPC 验证，避免认错服务。
//
// 只在连不上当前地址时才调用，正常情况下完全不产生开销。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const DSH_AUTH_FINGERPRINT = /dsh web authentication required/i;
const DSH_BOOT_FINGERPRINT = /__DSH_BOOT__/;

/** 从 netstat/ss 输出里提取本机监听端口（只认 LISTENING/LISTEN 行）。 */
export function parseListeningPorts(text, platform = process.platform) {
  const ports = new Set();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (platform === 'win32') {
      if (!/\bLISTENING\b/i.test(line)) continue;
      const local = (line.split(/\s+/)[1] ?? '');
      const port = Number(local.slice(local.lastIndexOf(':') + 1));
      if (Number.isInteger(port) && port > 0) ports.add(port);
    } else {
      if (!/\bLISTEN\b/i.test(line)) continue;
      const m = line.match(/(?:127\.0\.0\.1|\[::1\]|0\.0\.0\.0|\[::\]):(\d{1,5})/);
      if (m) ports.add(Number(m[1]));
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** 本机监听端口列表；调用方负责处理端口枚举失败。 */
export async function listLocalListeningPorts() {
  if (process.platform === 'win32') {
    const { stdout } = await run('netstat', ['-ano'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return parseListeningPorts(stdout, 'win32');
  }
  for (const [cmd, args] of [['ss', ['-lnt']], ['netstat', ['-lnt']]]) {
    try {
      const { stdout } = await run(cmd, args, { maxBuffer: 8 * 1024 * 1024 });
      const ports = parseListeningPorts(stdout, process.platform);
      if (ports.length) return ports;
    } catch {}
  }
  return [];
}

/** 这个端口是不是 DSH 的 Web 服务（只做未鉴权指纹，不发任何凭据）。 */
export async function looksLikeDsh(port, timeoutMs = 700) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8' }
    });
    const body = await res.text().catch(() => '');
    return DSH_AUTH_FINGERPRINT.test(body) || DSH_BOOT_FINGERPRINT.test(body);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 扫描本机监听端口，返回**疑似** DSH 的 base URL 列表（可能多个，调用方再鉴权确认）。
 * @param {{ exclude?: string[], probeTimeoutMs?: number, concurrency?: number, log?: (msg: string) => void }} [options]
 */
export async function discoverDshBaseUrls({ exclude = [], probeTimeoutMs = 700, concurrency = 8, log = () => {} } = {}) {
  let ports;
  try {
    ports = await listLocalListeningPorts();
  } catch (error) {
    log(`本机端口枚举失败：${error?.message ?? error}`);
    return [];
  }
  if (!ports.length) return [];

  const excludedPorts = new Set();
  for (const base of exclude) {
    try { excludedPorts.add(Number(new URL(base).port)); } catch {}
  }
  const candidates = ports.filter((p) => !excludedPorts.has(p));
  if (!candidates.length) return [];

  const hits = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const port = candidates[cursor++];
      if (await looksLikeDsh(port, probeTimeoutMs)) hits.push(port);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));
  return hits.sort((a, b) => a - b).map((p) => `http://127.0.0.1:${p}`);
}

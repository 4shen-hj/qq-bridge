// Offline scan of tracked files and unignored working-tree files. Reports never contain matched values.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const QQ_RULE = 'QQ 号/群号（9-10 位连续数字）';
const TOKEN_RULE = '疑似令牌/密钥（高熵串）';
export const DEFAULT_RULES = {
  deny: [
    { name: '本机绝对路径（Windows 用户目录）', pattern: '[A-Za-z]:\\\\Users\\\\[^\\\\\\s"\'`]{2,}', flags: 'i' },
    { name: '本机绝对路径（非系统盘的顶层目录）', pattern: '(?<![A-Za-z0-9])(?!C:)[A-Za-z]:\\\\[^\\\\\\s"\'`|<>]{2,}\\\\', flags: 'i' },
    { name: QQ_RULE, pattern: '(?<![0-9])[1-9][0-9]{8,9}(?![0-9])' },
    { name: TOKEN_RULE, pattern: '(?<![0-9a-zA-Z])[0-9a-zA-Z_-]{32,}(?![0-9a-zA-Z])', noise: 'token' },
    { name: '疑似凭据赋值（有实际值）', pattern: '(?:access[_-]?token|api[_-]?key|password|passwd|secret)["\']?\\s*[:=]\\s*(["\'])([A-Za-z0-9_\\-./+=]{12,})\\1', flags: 'i' },
    { name: '疑似凭据赋值（有实际值）', pattern: '(?:access[_-]?token|api[_-]?key|password|passwd|secret)\\s*[:=]\\s*[A-Za-z0-9_\\-./+=]{12,}(?=\\s|$)', flags: 'i', paths: ['.env', '.env.*', '*.env', '*.yaml', '*.yml'] },
    { name: '私钥头', pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----' },
    { name: '带凭据的 URL', pattern: 'https?://[^/\\s:@]+:[^/\\s:@]+@', flags: 'i' },
  ],
  denyFiles: ['config.json', 'state/', 'audio/', '*.log', '*.bak', '*.bak-*', 'roles/*.md.bak*'],
  allowMatches: [
    { path: 'docs/guides/PRIVACY.md', rule: QQ_RULE, value: String(123_456_789) },
    { path: 'scripts/privacy-rules.example.json', rule: QQ_RULE, value: String(123_456_789) },
    { path: 'docs/guides/PRIVACY.md', rule: '带凭据的 URL', value: 'https://user:pass@' },
    { path: 'scripts/privacy-scan.mjs', rule: '带凭据的 URL', value: 'https://user:pass@' },
    { path: 'docs/guides/PRIVACY.md', rule: '本机绝对路径（Windows 用户目录）', value: 'C:\\Users\\<名字>' },
    { path: 'docs/guides/PRIVACY.md', rule: '本机绝对路径（非系统盘的顶层目录）', value: 'D:\\<工作盘>\\' },
    { path: 'src/bridge.js', rule: '本机绝对路径（非系统盘的顶层目录）', value: 'D:\\...\\' },
  ],
};

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm', '.wav', '.mp3', '.ico', '.zip', '.tgz', '.exe', '.dll', '.node', '.woff', '.woff2', '.ttf', '.zstd']);

function globToRe(glob, descendants = false) {
  const pattern = glob.replace(/\/$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  const anywhere = !glob.includes('/') ? '(?:^|/)' : '^';
  return new RegExp(`${anywhere}${pattern}${descendants ? '(?:/.*)?' : ''}$`);
}

function tokenNoise(value) {
  return /^[0-9a-f]+$/i.test(value)
    || /^[A-Z][A-Z0-9_-]*$/.test(value)
    || /^[a-z0-9._-]+$/.test(value);
}

function loadRules(root, incomplete) {
  const file = path.join(root, 'scripts/privacy-rules.json');
  if (!fs.existsSync(file)) return { ...DEFAULT_RULES, fromFile: false };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    for (const key of ['deny', 'denyFiles', 'allowMatches', 'allowPaths']) {
      if (raw[key] !== undefined && !Array.isArray(raw[key])) throw new Error('invalid shape');
    }
    if (raw.allowPaths?.length) incomplete.push({ kind: 'rules', reason: 'allowPaths 已停止整文件放行，请迁移到 allowMatches 的 path、rule、value。' });
    return {
      deny: [...(raw.deny ?? []), ...DEFAULT_RULES.deny],
      denyFiles: [...(raw.denyFiles ?? []), ...DEFAULT_RULES.denyFiles],
      allowMatches: [...(raw.allowMatches ?? []), ...DEFAULT_RULES.allowMatches],
      fromFile: true,
    };
  } catch {
    incomplete.push({ kind: 'rules', reason: '无法读取或解析 scripts/privacy-rules.json。' });
    return { ...DEFAULT_RULES, fromFile: true };
  }
}

function listFiles(root, trackedOnly, incomplete) {
  const collect = (args) => {
    const result = spawnSync('git', ['ls-files', '-z', ...args], { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      incomplete.push({ kind: 'listing', reason: 'git 文件枚举失败，无法确认待扫描范围。' });
      return [];
    }
    return result.stdout.split('\0').filter(Boolean);
  };
  const tracked = collect([]);
  return [...new Set([...tracked, ...(trackedOnly ? [] : collect(['--others', '--exclude-standard']))])];
}

export function scanPrivacy({ root = ROOT, trackedOnly = false, maxMatches = 5000, maxRuleMs = 3000, maxFileBytes = 8 * 1024 * 1024 } = {}) {
  const incomplete = [];
  const findings = [];
  const rules = loadRules(root, incomplete);
  const files = listFiles(root, trackedOnly, incomplete);
  const compiled = [];
  for (const [index, rule] of rules.deny.entries()) {
    try {
      if (!rule || typeof rule.name !== 'string' || typeof rule.pattern !== 'string' || (rule.flags !== undefined && typeof rule.flags !== 'string')) throw new Error('invalid rule');
      if ((rule.flags ?? '').includes('y')) throw new Error('sticky rules cannot search a file');
      const flags = [...new Set(`${rule.flags ?? ''}g`)].join('');
      if (rule.paths !== undefined && (!Array.isArray(rule.paths) || rule.paths.some((p) => typeof p !== 'string'))) throw new Error('invalid paths');
      compiled.push({ ...rule, paths: rule.paths?.map((p) => globToRe(p)), re: new RegExp(rule.pattern, flags) });
    } catch {
      incomplete.push({ kind: 'rule', index, reason: '规则格式或正则无效。' });
    }
  }
  const denyFiles = [];
  for (const glob of rules.denyFiles) {
    if (typeof glob !== 'string' || !glob) {
      incomplete.push({ kind: 'rules', reason: 'denyFiles 项无效。' });
    } else denyFiles.push({ glob, re: globToRe(glob, glob.endsWith('/')) });
  }
  const allowMatches = [];
  for (const item of rules.allowMatches) {
    if (!item || typeof item.path !== 'string' || !item.path || typeof item.rule !== 'string' || typeof item.value !== 'string' || !item.value) {
      incomplete.push({ kind: 'rules', reason: 'allowMatches 项必须包含 path、rule 和非空 value。' });
    } else allowMatches.push({ ...item, re: globToRe(item.path) });
  }
  let scanned = 0;
  let skippedBinary = 0;
  for (const rel of files) {
    const normalized = rel.replace(/\\/g, '/');
    for (const { glob, re } of denyFiles) {
      if (re.test(normalized)) findings.push({ kind: 'file', rule: `不应入库的文件（${glob}）`, file: normalized, masked: '' });
    }
    const absolute = path.resolve(root, rel);
    if (path.relative(root, absolute).startsWith('..') || path.isAbsolute(path.relative(root, absolute))) {
      incomplete.push({ kind: 'file', file: normalized, reason: '文件路径超出扫描目录。' });
      continue;
    }
    let buffer;
    try {
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
      if (BINARY_EXT.has(path.extname(normalized).toLowerCase())) { skippedBinary++; continue; }
      if (stat.size > maxFileBytes) throw new Error('file too large');
      buffer = fs.readFileSync(absolute);
    } catch {
      incomplete.push({ kind: 'file', file: normalized, reason: '文件无法读取、不是普通文件或超过大小上限。' });
      continue;
    }
    if (buffer.subarray(0, 4096).includes(0)) { skippedBinary++; continue; }
    const text = buffer.toString('utf8');
    scanned++;
    for (const rule of compiled) {
      if (rule.paths && !rule.paths.some((re) => re.test(normalized))) continue;
      rule.re.lastIndex = 0;
      let attempts = 0;
      let hits = 0;
      const started = Date.now();
      let match;
      while ((match = rule.re.exec(text)) !== null) {
        if (++attempts > maxMatches || Date.now() - started > maxRuleMs) {
          incomplete.push({ kind: 'limit', file: normalized, rule: rule.name, reason: '匹配次数或时间超过上限，该规则扫描不完整。' });
          break;
        }
        if (!match[0].length) {
          const unicode = rule.re.unicode || rule.re.unicodeSets;
          rule.re.lastIndex = match.index + (unicode && text.codePointAt(match.index) > 0xffff ? 2 : 1);
        }
        if (rule.noise === 'token' && tokenNoise(match[0])) continue;
        if (rule.requireNonHex && /^[0-9a-f]+$/i.test(match[0])) continue;
        if (allowMatches.some((item) => item.rule === rule.name && item.value === match[0] && item.re.test(normalized))) continue;
        if (hits++ >= 3) continue;
        findings.push({ kind: 'content', rule: rule.name, file: normalized, line: text.slice(0, match.index).split('\n').length, masked: '[已隐藏]' });
      }
    }
  }
  return { rulesFromFile: rules.fromFile, source: 'git ls-files', listed: files.length, scanned, skippedBinary, complete: incomplete.length === 0, incomplete, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = scanPrivacy({ trackedOnly: process.argv.includes('--tracked-only') });
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`[privacy-scan] 已扫描 ${report.scanned} 个文本文件，跳过 ${report.skippedBinary} 个二进制文件。`);
    for (const finding of report.findings) console.log(`   [${finding.kind}] ${finding.rule} → ${finding.file}${finding.line ? `:${finding.line}` : ''}`);
    for (const issue of report.incomplete) console.error(`[privacy-scan] 扫描不完整：${issue.file ?? ''} ${issue.reason}`);
    if (report.complete && !report.findings.length) console.log('[privacy-scan] 未发现敏感信息。');
    if (report.findings.length) console.log('[privacy-scan] 请逐项确认；误报仅用 allowMatches 的 path、rule、value 精确豁免。');
  }
  process.exitCode = report.complete ? (report.findings.length ? 1 : 0) : 2;
}

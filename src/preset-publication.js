import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PRESETS, renderPatch, patchFileFor } from './agent-preset-patches.js';

const BUNDLE = 'qq-agent-presets';

function validateProfile(profile) {
  if (!profile || ['.', '..', 'node_modules'].includes(profile)
      || /[\\/\x00-\x1f<>:"|?*]/.test(profile) || /[. ]$/.test(profile)) {
    throw new Error(`无效 DSH profile ${JSON.stringify(profile)}`);
  }
  return profile;
}

function sameDirectory(actual, expected) {
  try {
    const left = fs.realpathSync(actual);
    const right = fs.realpathSync(expected);
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function readPackage(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function registeredProfiles(dshHome) {
  const dir = path.join(dshHome, 'profiles');
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'package.json');
    if (!fs.existsSync(file)) continue;
    const pkg = readPackage(file);
    if (pkg.dsh?.profile?.bundles?.includes(BUNDLE) || Object.hasOwn(pkg.dependencies ?? {}, BUNDLE)) {
      result.push(validateProfile(entry.name));
    }
  }
  return result;
}

function assertInstalled({ repoRoot, dshHome, profiles, patches }) {
  if (!profiles.length) throw new Error('未找到已注册的 qq-agent-presets；请先运行 node scripts/setup-dsh.mjs <profile>');
  const bundle = path.join(repoRoot, 'plugins', BUNDLE);
  const plugin = path.join(dshHome, 'plugins', BUNDLE);
  if (!sameDirectory(plugin, bundle)) throw new Error('DSH preset bundle 缺失或指向其他仓库；请先运行本仓库的 scripts/setup-dsh.mjs <profile>');
  const manifest = readPackage(path.join(bundle, 'package.json'));
  for (const name of PRESETS) {
    if (!manifest.dsh?.bundle?.patch?.includes(`./presets/${name}.patch.yml`)) {
      throw new Error(`bundle 未声明 ${name} patch`);
    }
  }
  for (const profile of profiles) {
    const dir = path.join(dshHome, 'profiles', profile);
    const pkg = readPackage(path.join(dir, 'package.json'));
    const dependency = pkg.dependencies?.[BUNDLE];
    if (!pkg.dsh?.profile?.bundles?.includes(BUNDLE) || typeof dependency !== 'string' || !dependency.startsWith('link:')
        || !sameDirectory(path.resolve(dir, dependency.slice(5)), bundle)
        || !sameDirectory(path.join(dir, 'node_modules', BUNDLE), bundle)) {
      throw new Error(`DSH profile ${profile} 的 preset 注册或链接不属于本仓库；请运行 node scripts/setup-dsh.mjs ${profile}`);
    }
    if (!fs.statSync(path.join(dir, 'node_modules', BUNDLE, 'qq-tool-restrict.mjs')).isFile()) {
      throw new Error(`DSH profile ${profile} 缺少 preset 工具守卫`);
    }
    for (const [name, expected] of patches) {
      const installed = path.join(dir, 'node_modules', BUNDLE, 'presets', `${name}.patch.yml`);
      if (fs.readFileSync(installed, 'utf8') !== expected) throw new Error(`DSH profile ${profile} 的 ${name} patch 未同步`);
    }
  }
}

export function inspectPresetPublication({ repoRoot, dshHome, preset }) {
  try {
    const profiles = registeredProfiles(dshHome);
    assertInstalled({ repoRoot, dshHome, profiles, patches: new Map([[preset, renderPatch(preset, { repoRoot })]]) });
    return { installed: true, profiles };
  } catch (error) {
    return { installed: false, error: error.message };
  }
}

function fileEdit(file, content) {
  let previous = null;
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error(`拒绝覆盖非普通文件 ${file}`);
    previous = fs.readFileSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { kind: 'file', file, content: Buffer.from(content), previous };
}

function linkEdit(file, target) {
  let previous = null;
  try {
    if (!fs.lstatSync(file).isSymbolicLink()) throw new Error(`拒绝覆盖非链接目录 ${file}；请先手工移走再重跑 setup`);
    previous = fs.readlinkSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { kind: 'link', file, target, previous };
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function replaceLink(file, target) {
  try {
    if (!fs.lstatSync(file).isSymbolicLink()) throw new Error(`拒绝移除非链接目录 ${file}`);
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (target !== null) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(target, file, process.platform === 'win32' ? 'junction' : 'dir');
  }
}

function installationEdits(repoRoot, dshHome, profile) {
  const bundle = path.join(repoRoot, 'plugins', BUNDLE);
  const plugin = path.join(dshHome, 'plugins', BUNDLE);
  const dir = path.join(dshHome, 'profiles', profile);
  const pkgFile = path.join(dir, 'package.json');
  const pkg = fs.existsSync(pkgFile) ? readPackage(pkgFile) : { name: `dsh-profile-${profile}`, private: true };
  pkg.dependencies = { ...pkg.dependencies, [BUNDLE]: `link:${plugin.replace(/\\/g, '/')}` };
  pkg.dsh ??= {};
  pkg.dsh.profile ??= {};
  const bundles = pkg.dsh.profile.bundles ?? [];
  if (!Array.isArray(bundles)) throw new Error(`${pkgFile} 的 dsh.profile.bundles 必须是数组`);
  pkg.dsh.profile.bundles = [...new Set([...bundles, BUNDLE])];
  return [
    linkEdit(plugin, bundle),
    linkEdit(path.join(dir, 'node_modules', BUNDLE), plugin),
    fileEdit(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`),
  ];
}

export function publishAgentPresets({ repoRoot, dshHome, profile, sourceChanges = {}, install = false }) {
  const bundle = path.join(repoRoot, 'plugins', BUNDLE);
  const lock = path.join(bundle, '.publish-lock');
  try { fs.mkdirSync(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`预设正在发布或上次发布中断；确认没有 setup/保存操作后移除 ${lock} 再重试`);
    throw error;
  }
  const applied = [];
  try {
    for (const name of Object.keys(sourceChanges)) {
      if (!PRESETS.includes(name)) throw new Error(`未知预设 ${name}`);
    }
    const profiles = profile ? [validateProfile(profile)] : registeredProfiles(dshHome);
    const patches = new Map(PRESETS.map((name) => [name, renderPatch(name, { repoRoot, sourceText: sourceChanges[name] })]));
    if (!install) assertInstalled({ repoRoot, dshHome, profiles, patches: new Map() });
    if (install && !profile) throw new Error('安装 preset 必须明确指定 DSH profile');
    const edits = [
      ...Object.entries(sourceChanges).map(([name, content]) => fileEdit(path.join(repoRoot, 'dsh', 'agent-presets', name, 'agent.cordis.yml'), content)),
      ...[...patches].map(([name, content]) => fileEdit(patchFileFor(name, repoRoot), content)),
      ...(install ? installationEdits(repoRoot, dshHome, profile) : []),
    ];
    for (const edit of edits) {
      if (edit.kind === 'file' && edit.previous?.equals(edit.content)) continue;
      if (edit.kind === 'link' && edit.previous !== null) {
        try { if (sameDirectory(edit.file, edit.target)) continue; } catch {}
      }
      applied.push(edit);
      if (edit.kind === 'file') atomicWrite(edit.file, edit.content);
      else replaceLink(edit.file, edit.target);
    }
    assertInstalled({ repoRoot, dshHome, profiles, patches });
    fs.rmdirSync(lock);
    return { synced: true, changed: applied.length > 0, profiles };
  } catch (error) {
    const rollbackErrors = [];
    for (const edit of applied.reverse()) {
      try {
        if (edit.kind === 'link') replaceLink(edit.file, edit.previous);
        else if (edit.previous === null) fs.rmSync(edit.file, { force: true });
        else atomicWrite(edit.file, edit.previous);
        if (edit.kind === 'file' && edit.previous !== null && !fs.readFileSync(edit.file).equals(edit.previous)) {
          throw new Error('恢复后内容不一致');
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${edit.file}: ${rollbackError.message}`);
      }
    }
    let lockError = '';
    try { fs.rmdirSync(lock); } catch (cleanupError) {
      lockError = `；发布锁未清理 ${lock}，请确认没有发布进程后手工移除：${cleanupError.message}`;
    }
    throw new Error(`预设发布失败，${rollbackErrors.length ? `回滚未完成，请手工检查 ${rollbackErrors.join('；')}` : '已保留原文件'}：${error.message}${lockError}`, { cause: error });
  }
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanPrivacy } from './privacy-scan.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-privacy-regression-'));
const scanner = new URL('./privacy-scan.mjs', import.meta.url);
const secret = ['Ab1Cd2Ef3Gh4', 'Ij5Kl6Mn7Op8', 'Qr9St0Uv1Wx2Yz3'].join('');
const qq = String(123_456_789);
const qqRule = 'QQ 号/群号（9-10 位连续数字）';
const tokenRule = '疑似令牌/密钥（高熵串）';
let checks = 0;

function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `fixture git command succeeds: ${result.stderr}`);
}
function write(file, content) {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}
function rules(value) {
  write('scripts/privacy-rules.json', JSON.stringify(value));
}
function scan(options) { return scanPrivacy({ root, ...options }); }
function check(name, assertion) { assertion(); checks++; console.log(`PASS ${name}`); }
function has(report, file, rule) { return report.findings.some((item) => item.file === file && item.rule === rule); }

try {
  git('init', '-q');
  write('.gitignore', 'scripts/privacy-rules.json\n');
  write('fixture.md', 'A harmless fixture.');
  check('clean content produces a complete report', () => {
    const report = scan();
    assert.equal(report.complete, true);
    assert.equal(report.findings.length, 0);
  });
  write('fixture.md', `${'a'.repeat(40)}\n${secret}\n${secret}`);
  check('advances past harmless hashes and reports distinct match lines', () => {
    const report = scan();
    const hits = report.findings.filter((item) => item.file === 'fixture.md' && item.rule === tokenRule);
    assert.deepEqual(hits.map((item) => item.line), [2, 3]);
    assert.equal(report.complete, true);
    assert.equal(JSON.stringify(report).includes(secret), false);
  });
  write('fixture.md', qq);
  check('numeric QQ is not removed by entropy noise filters', () => assert.ok(has(scan(), 'fixture.md', qqRule)));
  write('state/nested/sessions.json', '{}');
  write('audio/nested/voice.mp3', Buffer.from([0]));
  write('nested/diagnostic.log', 'fixture');
  git('add', '-f', 'state/nested/sessions.json', 'audio/nested/voice.mp3', 'nested/diagnostic.log');
  check('forbidden directory descendants and nested basename globs are found', () => {
    const report = scan();
    for (const file of ['state/nested/sessions.json', 'audio/nested/voice.mp3', 'nested/diagnostic.log']) {
      assert.ok(report.findings.some((item) => item.kind === 'file' && item.file === file));
    }
  });
  for (const file of ['src/bridge.js', 'src/dsh-client.js', 'src/sensitive.js', 'scripts/test-fixture.mjs', 'config.example.json', 'docs/guides/PRIVACY.md']) write(file, secret);
  check('previously skipped source, tests, templates and docs are scanned', () => {
    const report = scan();
    for (const file of ['src/bridge.js', 'src/dsh-client.js', 'src/sensitive.js', 'scripts/test-fixture.mjs', 'config.example.json', 'docs/guides/PRIVACY.md']) assert.ok(has(report, file, tokenRule));
  });
  write('src/media-normalize.js', '// AUDIT_2026-10-18_MEDIA_AND_WATERMARK\n' + secret);
  check('document identifier exemption leaves later secrets visible', () => {
    const hits = scan().findings.filter((item) => item.file === 'src/media-normalize.js');
    assert.deepEqual(hits.map((item) => item.line), [2]);
  });
  write('paths.md', 'C:' + '\\' + 'Users' + '\\' + 'FixtureUser');
  for (const file of ['sample.env', 'sample.yaml', 'sample.yml', '.env.local']) write(file, 'API_KEY=' + ['fixture', 'Secret12'].join(''));
  check('unquoted environment and YAML credentials are detected', () => {
    const report = scan();
    for (const file of ['sample.env', 'sample.yaml', 'sample.yml', '.env.local']) assert.ok(has(report, file, '疑似凭据赋值（有实际值）'));
    assert.equal(report.complete, true);
  });
  check('Windows paths remain detectable', () => assert.ok(scan().findings.some((item) => item.file === 'paths.md')));
  write('assignments.js', `accessToken: config.snowlumaToken\nsecret = credentials.secret\npassword: '${'lowercase'.repeat(2)}'`);
  check('credential rule recognizes literals without exempting lowercase passwords', () => {
    const hits = scan().findings.filter((item) => item.file === 'assignments.js');
    assert.deepEqual(hits.map((item) => item.line), [3]);
  });
  rules({ allowMatches: [{ path: 'fixture.md', rule: qqRule, value: qq }] });
  write('fixture.md', `${qq}\n${secret}`);
  write('other.md', qq);
  check('exceptions apply only to the declared file, rule and complete match', () => {
    const report = scan();
    assert.equal(has(report, 'fixture.md', qqRule), false);
    assert.ok(has(report, 'fixture.md', tokenRule));
    assert.ok(has(report, 'other.md', qqRule));
    assert.equal(report.complete, true);
  });
  rules({ allowPaths: ['src/bridge.js'] });
  check('legacy whole-file exemptions fail explicitly and do not hide findings', () => {
    const report = scan();
    assert.equal(report.complete, false);
    assert.ok(has(report, 'src/bridge.js', tokenRule));
    assert.ok(report.incomplete.some((issue) => issue.kind === 'rules'));
  });
  rules({ deny: [{ name: 'fixture literal', pattern: 'fixture', flags: '' }] });
  write('repeat.md', 'fixture fixture fixture fixture');
  check('custom rules use global progress and keep the report limit distinct', () => {
    const report = scan();
    assert.equal(report.findings.filter((item) => item.file === 'repeat.md').length, 3);
    assert.equal(report.complete, true);
  });
  rules({ deny: [{ name: 'empty match', pattern: '(?=f)', flags: '' }] });
  check('zero-width matches advance', () => assert.equal(scan().complete, true));
  rules({ deny: [{ name: 'unicode empty match', pattern: '(?=😀)', flags: 'u' }] });
  write('unicode.md', '😀😀');
  check('zero-width Unicode matches advance by a complete code point', () => assert.equal(scan().complete, true));
  rules({ deny: [{ name: 'invalid', pattern: '[' }] });
  check('invalid regex makes scan incomplete', () => assert.equal(scan().complete, false));
  rules({ deny: [{ name: 'sticky', pattern: 'fixture', flags: 'y' }] });
  check('unsupported sticky regex is rejected', () => assert.equal(scan().complete, false));
  write('scripts/privacy-rules.json', '{');
  check('invalid rules JSON makes scan incomplete', () => assert.equal(scan().complete, false));
  rules({});
  check('iteration exhaustion cannot report a clean scan', () => {
    const report = scan({ maxMatches: 1 });
    assert.equal(report.complete, false);
    assert.ok(report.incomplete.some((issue) => issue.kind === 'limit'));
  });
  check('oversized text makes scan incomplete', () => assert.equal(scan({ maxFileBytes: 1 }).complete, false));
  git('add', '--all');
  fs.unlinkSync(path.join(root, 'other.md'));
  check('unreadable tracked file makes scan incomplete', () => {
    const report = scan({ trackedOnly: true });
    assert.equal(report.complete, false);
    assert.ok(report.incomplete.some((issue) => issue.file === 'other.md'));
  });
  write('other.md', qq);
  fs.copyFileSync(scanner, path.join(root, 'scripts/privacy-scan.mjs'));
  rules({ deny: [{ name: 'invalid', pattern: '[' }] });
  check('CLI reports incomplete with exit 2 and redacted JSON', () => {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/privacy-scan.mjs'), '--json'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).complete, false);
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
  });
  rules({});
  check('CLI reports complete findings with exit 1', () => {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/privacy-scan.mjs'), '--json'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).complete, true);
  });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-privacy-no-git-'));
  try {
    check('unavailable Git candidate list fails instead of a partial directory fallback', () => {
      const report = scanPrivacy({ root: outside });
      assert.equal(report.complete, false);
      assert.ok(report.incomplete.some((issue) => issue.kind === 'listing'));
    });
    const init = spawnSync('git', ['init', '-q'], { cwd: outside, encoding: 'utf8' });
    assert.equal(init.status, 0);
    fs.mkdirSync(path.join(outside, 'scripts'));
    fs.copyFileSync(scanner, path.join(outside, 'scripts/privacy-scan.mjs'));
    check('CLI reports clean self-scan with exit 0', () => {
      const result = spawnSync(process.execPath, [path.join(outside, 'scripts/privacy-scan.mjs'), '--json'], { cwd: outside, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout);
      assert.equal(JSON.parse(result.stdout).complete, true);
    });
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  console.log(`Privacy scanner: ${checks}/${checks} checks passed.`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('SKIP restart safety: Windows PowerShell required');
} else {
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./test-restart-safety.ps1', import.meta.url))], { stdio: 'inherit', windowsHide: true });
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-start-fixture-'));
  try {
    fs.mkdirSync(path.join(fixture, 'scripts'));
    fs.mkdirSync(path.join(fixture, 'src'));
    const launcher = path.join(fixture, 'start.bat');
    fs.copyFileSync(new URL('../start.bat', import.meta.url), launcher);
    const record = "import fs from 'node:fs';fs.appendFileSync('launches.jsonl',JSON.stringify({entry:process.argv[1],args:process.argv.slice(2),cwd:process.cwd()})+'\\n');";
    fs.writeFileSync(path.join(fixture, 'scripts/harden-state-acl.mjs'), record);
    fs.writeFileSync(path.join(fixture, 'src/bridge.js'), record + 'process.exitCode=2;');
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${launcher}"`], {
      cwd: fixture, input: '\n', encoding: 'utf8', timeout: 10000, windowsHide: true, windowsVerbatimArguments: true,
    });
    assert.equal(result.status, 2, result.error?.message || result.stdout + result.stderr);
    const launches = fs.readFileSync(path.join(fixture, 'launches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(launches, [
      { entry: path.join(fixture, 'scripts/harden-state-acl.mjs'), args: ['--quiet'], cwd: fixture },
      { entry: path.join(fixture, 'src/bridge.js'), args: [], cwd: fixture },
    ]);
    console.log('PASS copied start.bat invokes only fixture ACL and bridge entries, in order, by absolute path');
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

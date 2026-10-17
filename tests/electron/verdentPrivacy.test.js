'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { checkPrivateFiles } = require('../../scripts/check-private-files');

test('privacy guard excludes ignored state but detects forced tracking and stale staged identities', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verdent-privacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['init', '-q']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'tmp/\n');
  fs.mkdirSync(path.join(root, 'tmp'));
  fs.writeFileSync(path.join(root, 'tmp', 'verdent-usage.json'), '{}');
  assert.deepEqual(checkPrivateFiles(root), []);
  git(['add', '-f', 'tmp/verdent-usage.json']);
  assert.ok(checkPrivateFiles(root).some(item => item.includes('private runtime state')));
  git(['rm', '--cached', 'tmp/verdent-usage.json']);
  fs.writeFileSync(path.join(root, 'sample.json'), JSON.stringify({ accountKey: 'a'.repeat(64) }));
  git(['add', 'sample.json']);
  fs.writeFileSync(path.join(root, 'sample.json'), '{}');
  const findings = checkPrivateFiles(root);
  assert.ok(findings.some(item => item.startsWith('index: sample.json:')));
  assert.ok(findings.every(item => !item.includes('a'.repeat(64))));
});

test('repository publishable files contain no known Verdent private state', () => {
  assert.deepEqual(checkPrivateFiles(path.resolve(__dirname, '../..')), []);
});

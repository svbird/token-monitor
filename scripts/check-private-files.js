'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function privatePath(file) {
  return /(^|\/)(?:tmp|userData|user-data|Partitions|Local Storage|Session Storage)(\/|$)/i.test(file)
    || /(^|\/)(?:verdent-usage\.json.*|credentials\.json.*|auth\.json|Cookies(?:-.*)?|Login Data(?:-.*)?|Local State)$/i.test(file)
    || /^(?:settings\.json|\.env(?:\..+)?)$/i.test(file) && file !== '.env.example';
}

function privateContent(content) {
  // Persisted account hashes are personal identifiers too. Source fixtures use
  // synthetic short identifiers or compute hashes at runtime, never real ones.
  return /"accountKey"\s*:\s*"[a-f0-9]{64}"/i.test(content);
}

function checkPrivateFiles(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const names = value => value.split('\0').filter(Boolean);
  const findings = [];
  const inspect = (file, content, source) => {
    if (privateContent(content)) findings.push(`${source}: ${file}: serialized account identity`);
  };
  const files = new Set(names(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])));
  for (const file of files) {
    if (privatePath(file)) { findings.push(`publishable path: ${file}: private runtime state`); continue; }
    const absolute = path.join(root, file);
    if (fs.existsSync(absolute) && fs.lstatSync(absolute).isFile()) inspect(file, fs.readFileSync(absolute, 'utf8'), 'working tree');
  }
  // A clean working copy must not hide a previously staged private payload.
  for (const file of names(git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']))) {
    if (!privatePath(file)) inspect(file, git(['show', `:${file}`]), 'index');
  }
  return [...new Set(findings)];
}

if (require.main === module) {
  try {
    const findings = checkPrivateFiles(path.resolve(__dirname, '..'));
    if (findings.length) {
      console.error('Private data must not be committed:\n' + findings.join('\n'));
      process.exitCode = 1;
    } else console.log('Privacy check passed: no known runtime paths or serialized account identities in publishable files.');
  } catch {
    console.error('Privacy check could not complete. Inspect Git and file access before publishing.');
    process.exitCode = 1;
  }
}

module.exports = { checkPrivateFiles };

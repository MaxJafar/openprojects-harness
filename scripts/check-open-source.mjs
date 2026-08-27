#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const failures = [];

function fail(message) {
  failures.push(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');

if (packageJson.license !== 'MIT') fail('package.json must declare SPDX license MIT');
if (packageJson.private !== true) {
  fail('package.json must remain private until intentional npm publication is configured');
}
if (!Array.isArray(packageJson.files) || packageJson.files.length === 0) {
  fail('package.json must contain an explicit files allowlist');
}

const license = readFileSync(join(root, 'LICENSE'), 'utf8');
const holderMatch = license.match(/^Copyright \(c\) 2026 ([^\n<>]+)$/mu);
if (!holderMatch) {
  fail('LICENSE must name the confirmed 2026 copyright holder without a placeholder');
} else {
  const expectedLicense = `MIT License

Copyright (c) 2026 ${holderMatch[1]}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
  if (license.replace(/\r\n/gu, '\n') !== expectedLicense) {
    fail('LICENSE must use the unmodified MIT license text');
  }
}

const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
for (const dependency of ['ajv', 'commander', 'yaml', 'fast-uri', 'MLX-LM', 'FFmpeg', 'Qwen', 'BGE-M3']) {
  if (!notices.includes(dependency)) fail(`THIRD_PARTY_NOTICES.md is missing ${dependency}`);
}

const allowedDependencyLicenses = new Set(['MIT', 'ISC', 'BSD-3-Clause', 'Apache-2.0']);
for (const [dependencyPath, metadata] of Object.entries(packageLock.packages ?? {})) {
  if (!dependencyPath.startsWith('node_modules/')) continue;
  if (!metadata.license) {
    fail(`${dependencyPath} has no license in package-lock.json`);
  } else if (!allowedDependencyLicenses.has(metadata.license)) {
    fail(`${dependencyPath} uses unreviewed license ${metadata.license}`);
  }
}

const lockRoot = packageLock.packages?.[''];
if (lockRoot?.license !== 'MIT') fail('package-lock.json root metadata must declare MIT');

const productionDependencies = new Set();
const pendingDependencies = Object.keys(lockRoot?.dependencies ?? {});
while (pendingDependencies.length > 0) {
  const name = pendingDependencies.pop();
  if (!name || productionDependencies.has(name)) continue;
  const metadata = packageLock.packages?.[`node_modules/${name}`];
  if (!metadata) {
    fail(`package-lock.json is missing production dependency ${name}`);
    continue;
  }
  productionDependencies.add(name);
  pendingDependencies.push(...Object.keys(metadata.dependencies ?? {}));
  pendingDependencies.push(...Object.keys(metadata.optionalDependencies ?? {}));
}
for (const name of [...productionDependencies].sort()) {
  const metadata = packageLock.packages[`node_modules/${name}`];
  const expectedRow = `| \`${name}\` | ${metadata.version} | ${metadata.license} |`;
  if (!notices.split(/\r?\n/u).includes(expectedRow)) {
    fail(`THIRD_PARTY_NOTICES.md does not match locked production package ${name}@${metadata.version} (${metadata.license})`);
  }
}

const criticalIgnoreRules = [
  '.openprojects-appliance/',
  'data/',
  '.env',
  '*.db',
  '*.token',
  'training/models/',
  'training/reviewed-export/',
];
const gitignore = readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/u);
for (const rule of criticalIgnoreRules) {
  if (!gitignore.includes(rule)) fail(`.gitignore is missing critical rule ${rule}`);
}

const gitattributes = readFileSync(join(root, '.gitattributes'), 'utf8').split(/\r?\n/u);
for (const rule of ['* text=auto eol=lf', '*.png binary', '*.wav binary']) {
  if (!gitattributes.includes(rule)) {
    fail(`.gitattributes is missing cross-platform byte-stability rule ${rule}`);
  }
}

function runNpmPack() {
  const npmCli = process.env.npm_execpath ?? (process.platform === 'win32' ? findWindowsNpmCli() : undefined);
  if (process.platform === 'win32' && !npmCli) {
    throw new Error('Unable to locate npm-cli.js for shell-free Windows package inspection');
  }
  const command = npmCli ? process.execPath : 'npm';
  const args = npmCli
    ? [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts']
    : ['pack', '--dry-run', '--json', '--ignore-scripts'];
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_loglevel: 'silent' },
    maxBuffer: 16 * 1024 * 1024,
  });
}

function findWindowsNpmCli() {
  const pathValue = Object.entries(process.env)
    .find(([name]) => name.toUpperCase() === 'PATH')?.[1] ?? '';
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...pathValue
      .split(';')
      .map((entry) => entry.trim().replace(/^"|"$/gu, ''))
      .filter(Boolean)
      .map((directory) => join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

let packedFiles = [];
try {
  const packResult = JSON.parse(runNpmPack());
  packedFiles = packResult[0]?.files?.map((entry) => entry.path) ?? [];
} catch (error) {
  fail(`npm pack inspection failed: ${error instanceof Error ? error.message : String(error)}`);
}

for (const required of [
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'dist/src/index.js',
  'dist/src/cli.js',
  'package.json',
]) {
  if (!packedFiles.includes(required)) fail(`npm package is missing ${required}`);
}

const forbiddenPackagePrefixes = [
  '.github/',
  '.openprojects-appliance/',
  'data/',
  'node_modules/',
  'scripts/',
  'src/',
  'tests/',
  'dist/tests/',
  'examples/frameworks/ai-sdk-mcp/dist/',
  'training/__pycache__/',
  'training/artifacts/',
  'training/models/',
  'training/reviewed-export/',
  'training/tests/',
];
const forbiddenPackageExtensions = new Set([
  '.bin', '.ckpt', '.db', '.db-journal', '.db3', '.gguf', '.h5', '.jsonl', '.key', '.mlmodel', '.npy', '.npz', '.onnx', '.p12', '.pem', '.pfx', '.pt', '.pth', '.pyc', '.pyo', '.safetensors', '.sqlite', '.sqlite-journal', '.sqlite3', '.tflite',
]);

function forbiddenReleasePath(path) {
  if (forbiddenPackagePrefixes.some((prefix) => path.startsWith(prefix))) return true;
  if (forbiddenPackageExtensions.has(extname(path).toLowerCase())) return true;
  if (/(?:^|\/)(?:__pycache__|node_modules)(?:\/|$)/u.test(path)) return true;
  if (path === 'openprojects.local.yaml' || path.startsWith('openprojects.local.yaml.backup-')) return true;
  return /(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]*\.(?:db-(?:shm|wal)|sqlite-(?:shm|wal)|owner\.lock|token|sock))$/u.test(path)
    && path !== '.env.example';
}

const forbiddenGitPrefixes = [
  '.openprojects-appliance/',
  'coverage/',
  'data/',
  'dist/',
  'node_modules/',
  'training/__pycache__/',
  'training/artifacts/',
  'training/models/',
  'training/reviewed-export/',
];
function forbiddenGitPath(path) {
  if (forbiddenGitPrefixes.some((prefix) => path.startsWith(prefix))) return true;
  if (/(?:^|\/)(?:__pycache__|\.venv|venv|node_modules)(?:\/|$)/u.test(path)) return true;
  if (forbiddenPackageExtensions.has(extname(path).toLowerCase())) return true;
  if (path === 'openprojects.local.yaml' || path.startsWith('openprojects.local.yaml.backup-')) return true;
  return /(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]*\.(?:db-(?:shm|wal)|sqlite-(?:shm|wal)|owner\.lock|token|sock))$/u.test(path)
    && path !== '.env.example';
}

for (const path of packedFiles) {
  if (forbiddenReleasePath(path)) fail(`npm package contains forbidden path ${path}`);
}

let trackedFiles;
let gitWorkTree = false;
try {
  const result = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  gitWorkTree = result === 'true';
} catch (error) {
  if (existsSync(join(root, '.git'))) {
    fail(`Git metadata exists but cannot be inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (gitWorkTree) {
  try {
    trackedFiles = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }).split('\0').filter(Boolean);
    for (const path of trackedFiles) {
      if (forbiddenGitPath(path)) fail(`Git index contains forbidden path ${path}`);
    }
  } catch (error) {
    fail(`Git work tree exists but its index cannot be inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const excludedTrees = new Set(['.git', '.openprojects-appliance', 'data', 'node_modules']);
const textExtensions = new Set([
  '', '.css', '.d.ts', '.html', '.ini', '.js', '.json', '.md', '.mjs', '.plist', '.py', '.sh', '.ts', '.txt', '.yaml', '.yml',
]);
const secretPatterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/u],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/u],
  ['OpenAI-style secret', /\bsk-[A-Za-z0-9_-]{20,}\b/u],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/u],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u],
  ['Telegram bot token', /\b\d{8,12}:[A-Za-z0-9_-]{35}\b/u],
  ['personal macOS path', /\/Users\/[A-Za-z0-9._-]+\//u],
  ['personal Windows path', /[A-Za-z]:\\Users\\[^\\]+\\/u],
];

function scanTree(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (directory === root && excludedTrees.has(entry.name)) continue;
    if (
      entry.name === '__pycache__'
      || entry.name === 'node_modules'
      || (entry.name === 'dist' && directory !== root)
    ) continue;
    const absolute = join(directory, entry.name);
    const display = relative(root, absolute).split(sep).join('/');
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      fail(`public source tree contains symbolic link ${display}`);
      continue;
    }
    if (stat.isDirectory()) {
      scanTree(absolute);
      continue;
    }
    if (!stat.isFile()) {
      fail(`public source tree contains non-regular entry ${display}`);
      continue;
    }
    if (stat.size > 2 * 1024 * 1024) {
      fail(`public source file exceeds the review bound: ${display}`);
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    if (forbiddenPackageExtensions.has(extension)) {
      fail(`public source tree contains forbidden artifact ${display}`);
      continue;
    }
    if ((entry.name === '.env' || entry.name.startsWith('.env.') || /(?:\.token|\.sock)$/u.test(entry.name)) && entry.name !== '.env.example') {
      fail(`public source tree contains local credential/state path ${display}`);
      continue;
    }
    if (!textExtensions.has(extension) && !entry.name.startsWith('.env')) continue;
    const contents = readFileSync(absolute, 'utf8');
    for (const [label, pattern] of secretPatterns) {
      if (pattern.test(contents)) fail(`${display} contains a possible ${label}`);
    }
  }
}

scanTree(root);

if (failures.length > 0) {
  for (const message of failures) console.error(`FAIL: ${message}`);
  process.exitCode = 1;
} else {
  const gitStatus = trackedFiles
    ? `${trackedFiles.length} Git-tracked files checked`
    : 'Git index unavailable; index check deferred';
  console.log(`Open-source release check passed: ${packedFiles.length} package files; ${gitStatus}; MIT metadata and permissive dependency licenses verified.`);
}

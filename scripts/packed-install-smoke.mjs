#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unexpectedPackageImportStderr } from './cross-platform-report.mjs';

const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const npmCli = process.env.npm_execpath?.trim();
if (!npmCli) {
  throw new Error('Run this smoke test through `npm run test:package`');
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'openprojects-package-smoke-'));
try {
  const packed = await run(process.execPath, [
    npmCli,
    'pack',
    '--json',
    '--pack-destination',
    temporaryRoot,
  ], root);
  const packResult = parsePackResult(packed.stdout);
  const tarball = resolve(temporaryRoot, packResult.filename);
  if (dirname(tarball) !== temporaryRoot) throw new Error('npm pack returned an unsafe filename');
  const tarballStat = await stat(tarball);
  if (!tarballStat.isFile() || tarballStat.size < 1 || tarballStat.size > 50 * 1024 * 1024) {
    throw new Error('Packed artifact is missing, empty, or unexpectedly large');
  }

  const consumer = join(temporaryRoot, 'consumer');
  await mkdir(consumer);
  await run(process.execPath, [
    npmCli,
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix',
    consumer,
    tarball,
  ], root);

  const cli = join(
    consumer,
    'node_modules',
    'openprojects-harness',
    'dist',
    'src',
    'cli.js',
  );
  const help = await run(process.execPath, [cli, '--help'], consumer);
  requireOutput(help.stdout, 'OpenProjects lightweight durable private agent control plane');
  requireOutput(help.stdout, 'setup|init');

  const setup = await run(process.execPath, [cli, 'setup', '--defaults', '--dry-run'], consumer);
  requireOutput(`${setup.stdout}\n${setup.stderr}`, 'Dry-run plan (no files will be written)');
  await expectAbsent(join(consumer, 'openprojects.local.yaml'));
  await expectAbsent(join(consumer, 'data'));

  const imported = await run(process.execPath, [
    '--input-type=module',
    '--eval',
    `const api = await import('openprojects-harness');
     if (typeof api.createApp !== 'function' || typeof api.createEmbeddingAdapter !== 'function') {
       throw new Error('package root exports are incomplete');
     }`,
  ], consumer);
  const unexpectedStderr = unexpectedPackageImportStderr(imported.stderr);
  if (unexpectedStderr) throw new Error(`Package import wrote unexpected stderr: ${unexpectedStderr}`);

  console.log(
    `Packed install smoke passed: ${packResult.filename}; `
      + `${tarballStat.size} bytes; CLI, dry-run, and package exports verified`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function parsePackResult(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('npm pack did not return JSON');
  }
  const item = Array.isArray(parsed) ? parsed[0] : undefined;
  if (!item || typeof item !== 'object' || typeof item.filename !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(item.filename)) {
    throw new Error('npm pack returned an invalid artifact record');
  }
  return item;
}

async function expectAbsent(path) {
  try {
    await stat(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Dry-run unexpectedly created ${path}`);
}

function requireOutput(output, expected) {
  if (!output.includes(expected)) throw new Error(`Smoke output is missing: ${expected}`);
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const collect = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        reject(new Error('Package smoke command exceeded the output limit'));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0) resolvePromise(result);
      else reject(new Error(
        `Package smoke command failed (${signal ?? code}): ${result.stderr.trim() || result.stdout.trim()}`,
      ));
    });
  });
}

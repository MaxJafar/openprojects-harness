#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { arch, platform, release, tmpdir, totalmem } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  CROSS_PLATFORM_REPORT_SCHEMA,
  EXPECTED_PYTHON_TRAINING_TESTS,
  EXPECTED_VITEST_FILE_TESTS,
  EXPECTED_VITEST_SUITES,
  EXPECTED_VITEST_TESTS,
  WINDOWS_PYTHON_TRAINING_SKIP_REASON,
  parsePythonSkips,
  parsePythonTestCount,
  parseVitestReport,
  platformCoverage,
  renderQualificationSummary,
  validateVitestBaseline,
} from './cross-platform-report.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const npmCli = process.env.npm_execpath?.trim();
if (!npmCli) {
  throw new Error('Run this qualification through `npm run qualify:platform` so npm can be launched without a shell');
}
const explicitOutput = argumentValue('--output') ?? process.env.QUALIFICATION_OUTPUT?.trim();
const outputDirectory = explicitOutput
  ? resolve(explicitOutput)
  : await mkdtemp(join(tmpdir(), 'openprojects-cross-platform-'));

if (explicitOutput) {
  await mkdir(outputDirectory);
}

const startedAt = new Date();
const environment = {
  schema: CROSS_PLATFORM_REPORT_SCHEMA,
  startedAt: startedAt.toISOString(),
  platform: platform(),
  architecture: arch(),
  osRelease: release(),
  totalMemoryBytes: totalmem(),
  runner: {
    os: process.env.RUNNER_OS ?? null,
    architecture: process.env.RUNNER_ARCH ?? null,
    imageOs: process.env.ImageOS ?? null,
    imageVersion: process.env.ImageVersion ?? null,
    repository: process.env.GITHUB_REPOSITORY ?? null,
    sha: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  },
};
await writeExclusive('environment.json', `${JSON.stringify(environment, null, 2)}\n`);

const stages = [];
const expectedPlatform = process.env.OPENPROJECTS_EXPECTED_PLATFORM?.trim();
const expectedArchitecture = process.env.OPENPROJECTS_EXPECTED_ARCH?.trim();
const environmentFailures = [
  ...(expectedPlatform && expectedPlatform !== process.platform
    ? [`expected platform ${expectedPlatform}, observed ${process.platform}`]
    : []),
  ...(expectedArchitecture && expectedArchitecture !== process.arch
    ? [`expected architecture ${expectedArchitecture}, observed ${process.arch}`]
    : []),
];
stages.push({
  id: 'host-contract',
  status: environmentFailures.length === 0 ? 'passed' : 'failed',
  exitCode: environmentFailures.length === 0 ? 0 : 1,
  durationMs: 0,
  command: 'internal host platform/architecture assertion',
  log: 'environment.json',
  ...(environmentFailures.length > 0 ? { error: environmentFailures.join('; ') } : {}),
});

const stagePlans = [
  { id: 'npm-clean-install', command: process.execPath, args: [npmCli, 'ci'] },
  { id: 'qualification-report-tests', command: process.execPath, args: ['--test', 'scripts/cross-platform-report-check.mjs'] },
  { id: 'typecheck', command: process.execPath, args: [npmCli, 'run', 'typecheck'] },
  { id: 'vitest', command: process.execPath, args: [npmCli, 'test', '--', '--reporter=json', `--outputFile=${join(outputDirectory, 'vitest.json')}`] },
  { id: 'build', command: process.execPath, args: [npmCli, 'run', 'build'] },
  { id: 'packed-install-smoke', command: process.execPath, args: [npmCli, 'run', 'test:package'] },
  process.platform === 'win32'
    ? { id: 'python-training-tests', skipReason: WINDOWS_PYTHON_TRAINING_SKIP_REASON }
    : { id: 'python-training-tests', command: process.execPath, args: ['scripts/run-python.mjs', '-m', 'unittest', 'discover', '-s', 'training/tests', '-v'] },
  { id: 'open-source-boundary', command: process.execPath, args: [npmCli, 'run', 'check:opensource'] },
  { id: 'production-audit', command: process.execPath, args: [npmCli, 'run', 'audit:production'] },
];

for (const [index, plan] of stagePlans.entries()) {
  stages.push(plan.skipReason
    ? await skipStage(index + 1, plan.id, plan.skipReason)
    : await runStage(index + 1, plan.id, plan.command, plan.args));
}

const pythonStage = stages.find((stage) => stage.id === 'python-training-tests');
const pythonOutput = pythonStage?.log
  ? await readFile(join(outputDirectory, pythonStage.log), 'utf8').catch(() => '')
  : '';
const pythonTestCount = parsePythonTestCount(pythonOutput);
const pythonSkips = parsePythonSkips(pythonOutput);
if (
  process.platform !== 'win32'
  && pythonStage?.status === 'passed'
  && (pythonTestCount !== EXPECTED_PYTHON_TRAINING_TESTS || pythonSkips.length !== 0)
) {
  const error = pythonTestCount !== EXPECTED_PYTHON_TRAINING_TESTS
    ? `expected ${EXPECTED_PYTHON_TRAINING_TESTS} Python training safety tests, observed ${pythonTestCount ?? 'no unittest total'}`
    : `expected zero skipped Python training safety tests, observed ${pythonSkips.length}`;
  pythonStage.status = 'failed';
  pythonStage.exitCode = 1;
  pythonStage.error = error;
  await appendFile(join(outputDirectory, pythonStage.log), `\nqualification error: ${error}\n`, 'utf8');
  console.error(`[qualification] python-training-tests: ${error}`);
}

const nodeVersion = process.version;
const pythonVersion = process.platform === 'win32'
  ? 'not run (Windows training N/A)'
  : await commandVersion(process.execPath, ['scripts/run-python.mjs', '--version']);
const npmVersion = await commandVersion(process.execPath, [npmCli, '--version']);
const vitestPath = join(outputDirectory, 'vitest.json');
let vitest;
try {
  vitest = parseVitestReport(JSON.parse(await readFile(vitestPath, 'utf8')), root);
} catch (error) {
  vitest = {
    totalSuites: 0,
    passedSuites: 0,
    failedSuites: 0,
    pendingSuites: 0,
    totalTests: 0,
    passedTests: 0,
    failedTests: 0,
    pendingTests: 0,
    todoTests: 0,
    success: false,
    skipped: [],
    parseError: message(error),
  };
}
const vitestBaselineFailures = validateVitestBaseline(vitest, process.platform);
const vitestStage = stages.find((stage) => stage.id === 'vitest');
if (vitestStage?.status === 'passed' && vitestBaselineFailures.length > 0) {
  const error = `Vitest corpus baseline failed: ${vitestBaselineFailures.join(' | ')}`;
  vitestStage.status = 'failed';
  vitestStage.exitCode = 1;
  vitestStage.error = error;
  await appendFile(join(outputDirectory, vitestStage.log), `\nqualification error: ${error}\n`, 'utf8');
  console.error(`[qualification] vitest: ${error}`);
}
vitest.baseline = {
  status: vitestBaselineFailures.length === 0 ? 'passed' : 'failed',
  expectedSuites: EXPECTED_VITEST_SUITES,
  expectedTests: EXPECTED_VITEST_TESTS,
  expectedFiles: Object.keys(EXPECTED_VITEST_FILE_TESTS).length,
  failures: vitestBaselineFailures,
};

const pythonEvidence = {
  status: pythonStage?.status ?? 'failed',
  testCount: pythonTestCount,
  expectedTestCount: EXPECTED_PYTHON_TRAINING_TESTS,
  skipped: pythonSkips,
  ...(pythonStage?.reason ? { reason: pythonStage.reason } : {}),
};
const finishedAt = new Date();
const allPassed = stages.every((stage) => ['passed', 'skipped'].includes(stage.status)) && vitest.success;
const report = {
  schema: CROSS_PLATFORM_REPORT_SCHEMA,
  generatedAt: finishedAt.toISOString(),
  overall: allPassed ? 'passed' : 'failed',
  host: {
    platform: process.platform,
    architecture: process.arch,
    osRelease: release(),
    totalMemoryBytes: totalmem(),
    nodeVersion,
    npmVersion,
    pythonVersion,
  },
  source: environment.runner,
  durationMs: finishedAt.getTime() - startedAt.getTime(),
  stages,
  vitest,
  python: pythonEvidence,
  coverage: platformCoverage(process.platform, process.arch),
  limitations: [
    process.platform === 'win32'
      ? 'A passing artifact covers native dependency installation, Node/TypeScript unit and integration behavior, TypeScript compilation, the MIT release boundary, and the production dependency audit on this Windows host. It explicitly does not include the POSIX-dependent MLX Python training safety suite.'
      : `A passing artifact covers native dependency installation, unit/integration behavior, TypeScript compilation, all ${EXPECTED_PYTHON_TRAINING_TESTS} Python training safety tests, the MIT release boundary, and the production dependency audit only on the host recorded above.`,
    'It does not certify total-system operation on 4 GiB RAM; hosted-runner memory is recorded only as context.',
    'It does not install or qualify Ollama, llama.cpp, MLX, Qwen, Granite, embedding, vision, or Whisper model artifacts.',
    'Real Windows and Mac hardware smoke/soak evidence should be retained separately; Linux cgroup-v2 certification can run in CI later or on borrowed/rented target hardware.',
  ],
};
const summary = renderQualificationSummary(report);
await writeExclusive('qualification.json', `${JSON.stringify(report, null, 2)}\n`);
await writeExclusive('summary.md', summary);
await writeEvidenceManifest();

if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
}

console.log(`\nCross-platform qualification ${report.overall}: ${outputDirectory}`);
if (!allPassed) process.exitCode = 1;

async function runStage(number, id, command, args) {
  const logName = `${String(number).padStart(2, '0')}-${id}.log`;
  const logPath = join(outputDirectory, logName);
  const log = createWriteStream(logPath, { flags: 'wx', encoding: 'utf8' });
  const commandText = [command, ...args].join(' ');
  log.write(`$ ${commandText}\n`);
  console.log(`\n[qualification] ${id}: ${commandText}`);
  const started = performance.now();

  const exitCode = await new Promise((resolveExit) => {
    const child = spawn(command, args, {
      cwd: root,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      log.write(chunk);
    });
    child.once('error', (error) => {
      log.write(`\nspawn error: ${message(error)}\n`);
      resolveExit(127);
    });
    child.once('close', (code, signal) => {
      if (signal) log.write(`\nterminated by ${signal}\n`);
      resolveExit(code ?? 1);
    });
  });

  await new Promise((resolveClose, reject) => {
    log.once('error', reject);
    log.end(resolveClose);
  });
  const durationMs = Math.round(performance.now() - started);
  return {
    id,
    status: exitCode === 0 ? 'passed' : 'failed',
    exitCode,
    durationMs,
    command: commandText,
    log: logName,
  };
}

async function skipStage(number, id, reason) {
  const logName = `${String(number).padStart(2, '0')}-${id}.log`;
  const detail = `[qualification] ${id}: skipped (Windows N/A)\nReason: ${reason}\n`;
  await writeExclusive(logName, detail);
  console.log(`\n${detail.trimEnd()}`);
  return {
    id,
    status: 'skipped',
    exitCode: null,
    durationMs: 0,
    command: 'not run on native Windows',
    log: logName,
    reason,
  };
}

async function commandVersion(command, args) {
  return await new Promise((resolveVersion) => {
    let output = '';
    const child = spawn(command, args, { cwd: root, windowsHide: true });
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.once('error', () => resolveVersion('unavailable'));
    child.once('close', (code) => resolveVersion(code === 0 ? output.trim() : 'unavailable'));
  });
}

async function writeEvidenceManifest() {
  const entries = [];
  for (const stage of stages) {
    if (!stage.log || stage.log === 'environment.json') continue;
    entries.push(await digestEntry(stage.log));
  }
  for (const name of ['environment.json', 'vitest.json', 'qualification.json', 'summary.md']) {
    try {
      entries.push(await digestEntry(name));
    } catch {
      // A failed test command may not have emitted its framework-native report.
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  await writeExclusive('evidence-manifest.json', `${JSON.stringify({
    schema: 'openprojects.cross-platform-evidence-manifest.v1',
    files: entries,
  }, null, 2)}\n`);
}

async function digestEntry(name) {
  const path = join(outputDirectory, name);
  const [bytes, metadata] = await Promise.all([readFile(path), stat(path)]);
  return {
    path: relative(outputDirectory, path).split('\\').join('/'),
    bytes: metadata.size,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function writeExclusive(name, contents) {
  await writeFile(join(outputDirectory, name), contents, { encoding: 'utf8', flag: 'wx' });
}

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

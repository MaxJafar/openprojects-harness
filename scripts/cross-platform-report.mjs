import { relative, resolve, sep } from 'node:path';

export const CROSS_PLATFORM_REPORT_SCHEMA = 'openprojects.cross-platform-qualification.v1';
export const EXPECTED_PYTHON_TRAINING_TESTS = 38;
export const EXPECTED_VITEST_SUITES = 123;
export const EXPECTED_VITEST_TESTS = 473;
export const WINDOWS_PYTHON_TRAINING_SKIP_REASON =
  'The reviewed MLX training safety suite depends on POSIX dir_fd and symlink-race semantics that the lab does not implement equivalently on native Windows; it remains a macOS/Linux-only gate.';

const NODE_SQLITE_EXPERIMENTAL_WARNING = /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)$/u;

export const EXPECTED_VITEST_FILE_TESTS = Object.freeze({
  'tests/api-client.test.ts': 23,
  'tests/configured-integrations.test.ts': 4,
  'tests/control-auth.test.ts': 16,
  'tests/corporate-oracle.test.ts': 7,
  'tests/doctor.test.ts': 8,
  'tests/eval-gates.test.ts': 2,
  'tests/harness-footprint-eval.test.ts': 5,
  'tests/integration-manifest.test.ts': 13,
  'tests/integration-policy.test.ts': 2,
  'tests/json-api-integration.test.ts': 13,
  'tests/kernel.test.ts': 10,
  'tests/learning.test.ts': 15,
  'tests/local-4gb-eval.test.ts': 19,
  'tests/local-ai.test.ts': 40,
  'tests/mcp-client.test.ts': 10,
  'tests/mcp-gateway.test.ts': 14,
  'tests/owner-lock.test.ts': 10,
  'tests/privacy.test.ts': 9,
  'tests/project-analyst.test.ts': 5,
  'tests/qualification.test.ts': 33,
  'tests/recovery-isolation.test.ts': 3,
  'tests/representative-eval.test.ts': 3,
  'tests/run-admission.test.ts': 5,
  'tests/run-snapshots.test.ts': 8,
  'tests/runtime-batch-atomicity.test.ts': 2,
  'tests/runtime.test.ts': 19,
  'tests/scheduler.test.ts': 6,
  'tests/semantic-embedding-eval.test.ts': 4,
  'tests/sqlite-migrations.test.ts': 8,
  'tests/storage.test.ts': 20,
  'tests/strict-json.test.ts': 5,
  'tests/subagents.test.ts': 3,
  'tests/telegram.test.ts': 13,
  'tests/tool-call-preflight.test.ts': 5,
  'tests/tui.test.ts': 18,
  'tests/unix-transport.test.ts': 10,
  'tests/vision-adapter.test.ts': 12,
  'tests/vision-eval.test.ts': 22,
  'tests/vision-media.test.ts': 10,
  'tests/windows-portability.test.ts': 3,
  'tests/wizard.test.ts': 36,
});

const POSIX_CASE_ALIAS_SKIP = Object.freeze({
  file: 'tests/qualification.test.ts',
  title: 'refuses case-only macOS aliases across model and runtime evidence roles',
});

const MACOS_WIZARD_CASE_ALIAS_SKIP = Object.freeze({
  file: 'tests/wizard.test.ts',
  title: 'refuses case-only aliases between protected artifacts on macOS',
});

const WINDOWS_VITEST_SKIPS = Object.freeze([
  ['tests/control-auth.test.ts', 'rejects group- or world-readable credentials'],
  ['tests/control-auth.test.ts', 'refuses symbolic links even when their target is protected'],
  ['tests/owner-lock.test.ts', 'refuses a symbolic-link SQLite alias'],
  ['tests/owner-lock.test.ts', 'refuses a symbolic-link lock without following it'],
  ['tests/owner-lock.test.ts', 'does not unlink a replacement that is not the held file'],
  ['tests/doctor.test.ts', 'validates a protected Unix endpoint and multiple least-privilege principals'],
  ['tests/doctor.test.ts', 'accepts reviewed PATH symlinks whose final transcription executables are regular and protected'],
  ['tests/wizard.test.ts', 'publishes a loadable protected Unix-socket installation plan'],
  ['tests/wizard.test.ts', 'does not follow or overwrite a symlink when force is requested'],
  ['tests/wizard.test.ts', 'refuses an unprotected existing control token before publishing configuration'],
  ['tests/wizard.test.ts', 'rejects an intermediate symbolic-link component in reviewed artifact paths'],
  ['tests/wizard.test.ts', 'rejects an existing database symlink before publishing configuration'],
  ['tests/wizard.test.ts', 'rejects an existing owner-only directory that is not mode 0700'],
  [MACOS_WIZARD_CASE_ALIAS_SKIP.file, MACOS_WIZARD_CASE_ALIAS_SKIP.title],
  [POSIX_CASE_ALIAS_SKIP.file, POSIX_CASE_ALIAS_SKIP.title],
  ['tests/qualification.test.ts', 'qualifies whisper.cpp only after a known-audio transcript and reports exact hashes'],
  ['tests/api-client.test.ts', 'attaches the authenticated API client through a protected Unix socket'],
  ['tests/integration-manifest.test.ts', 'rejects symbolic-link integration manifest paths'],
  ['tests/qualification.test.ts', 'rejects symbolic-link qualification manifest paths'],
  ['tests/unix-transport.test.ts', 'sends bounded JSON and returns a fetch-compatible JSON response'],
  ['tests/unix-transport.test.ts', 'streams SSE response chunks and propagates AbortSignal after headers'],
  ['tests/unix-transport.test.ts', 'maps pre-response aborts and response-header timeouts without leaking the path'],
  ['tests/unix-transport.test.ts', 'rejects oversized/non-JSON bodies, forbidden headers, methods, and other origins'],
  ['tests/unix-transport.test.ts', 'never follows redirects and maps an absent socket to a sanitized unavailable error'],
  ['tests/unix-transport.test.ts', 'requires an owner-only parent and refuses every existing leaf as occupied'],
  ['tests/unix-transport.test.ts', 'listens with mode 0600 and cleans the endpoint after server shutdown'],
  ['tests/unix-transport.test.ts', 'refuses to unlink a replacement socket inode'],
  ['tests/unix-transport.test.ts', 'sanitizes listen failures into endpoint-specific errors'],
  ['tests/unix-transport.test.ts', 'diagnoses but never removes an unresponsive crash-left socket'],
].map(([file, title]) => Object.freeze({ file, title })));

const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32']);

export function platformCoverage(platform, architecture) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`Unsupported qualification platform: ${platform}`);
  }

  const isWindows = platform === 'win32';
  const isMac = platform === 'darwin';
  const isLinux = platform === 'linux';
  const skipped = (id, detail) => ({ id, status: 'skipped', detail });
  const run = (id, evidence, detail) => ({ id, status: 'run', evidence, detail });
  const portableCoreEvidence = [
    'npm-clean-install',
    'qualification-report-tests',
    'typecheck',
    'vitest',
    'build',
    'packed-install-smoke',
    ...(!isWindows ? ['python-training-tests'] : []),
  ];

  return [
    run(
      'portable-core',
      portableCoreEvidence,
      isWindows
        ? 'Portable TypeScript, SQLite, policy, runtime, API, and integration coverage. The Python/MLX training safety suite is an explicit Windows N/A lane below.'
        : 'Portable TypeScript, SQLite, policy, runtime, API, integration, and standard-library Python training-safety coverage.',
    ),
    run(
      'portable-file-identity-hardening',
      ['vitest'],
      'Regular-file, bounded-input, and available file-identity/link defenses run through the native test suite on every host.',
    ),
    isWindows
      ? skipped('posix-mode-and-uid-semantics', 'POSIX chmod/geteuid ownership semantics and privileged Unix link fixtures do not apply to Windows; portable Windows file-identity defenses still run above.')
      : run('posix-mode-and-uid-semantics', ['vitest'], 'Owner-only mode and uid-sensitive filesystem assertions run on this POSIX host.'),
    isWindows
      ? skipped(
          'windows-ntfs-acl-isolation',
          'The portable suite validates regular-file, single-link, and no-follow behavior, but does not certify NTFS DACL inheritance or service-identity isolation. Review and retain native icacls/ACL evidence before deployment.',
        )
      : skipped(
          'windows-ntfs-acl-isolation',
          'Windows-only manual deployment gate; this non-Windows artifact contains no NTFS ACL evidence.',
        ),
    isWindows
      ? skipped('unix-domain-socket-control', 'Windows uses loopback TCP; Unix-domain control-socket tests are explicitly skipped by Vitest.')
      : run('unix-domain-socket-control', ['vitest'], 'Unix-domain HTTP transport, stale-socket probing, and endpoint cleanup run on this host.'),
    isWindows
      ? skipped('shell-whisper-fixture', 'The qualification fixture is a POSIX shell executable and is explicitly skipped on Windows.')
      : run('shell-whisper-fixture', ['vitest'], 'The bounded whisper.cpp/FFmpeg shell fixture runs on this POSIX host.'),
    isWindows
      ? skipped('mlx-python-training-safety-tests', WINDOWS_PYTHON_TRAINING_SKIP_REASON)
      : run(
          'mlx-python-training-safety-tests',
          ['python-training-tests'],
          `All ${EXPECTED_PYTHON_TRAINING_TESTS} standard-library MLX training safety tests run on this POSIX host; no model or MLX runtime is downloaded.`,
        ),
    isWindows
      ? run('windows-native-node', ['vitest', 'build'], `Native Windows ${architecture} Node/core execution; TCP control paths remain in the portable suite.`)
      : skipped('windows-native-node', 'Scheduled in the separate Windows matrix job; this host artifact contains no Windows result.'),
    isMac
      ? run('macos-apple-silicon-core', ['vitest', 'build'], `Native macOS ${architecture} core execution; architecture is checked by the workflow.`)
      : skipped('macos-apple-silicon-core', 'Scheduled in the separate macOS arm64 matrix job; this host artifact contains no macOS result.'),
    isLinux
      ? run('linux-native-node', ['vitest', 'build', 'python-training-tests'], `Native Linux ${architecture} execution; model/cgroup certification remains separate.`)
      : skipped('linux-native-node', 'Scheduled in the separate Ubuntu matrix job; this host artifact contains no Linux result.'),
    skipped(
      'mlx-local-model-qualification',
      'Lightweight CI does not download MLX or model weights. Run the pinned MLX appliance lane on owned Apple Silicon hardware.',
    ),
    skipped(
      'linux-4gb-cgroup-model-soak',
      'Hosted CI does not prove a 4 GiB combined harness/model envelope. Run the cgroup-v2 soak on a real 4 GiB Linux target.',
    ),
    skipped(
      'real-vision-embedding-whisper-models',
      'No external model artifacts or services are fetched in the dependency-only CI lane; real capability qualification remains a hardware gate.',
    ),
  ];
}

export function parseVitestReport(value, rootDirectory) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Vitest report must be an object');
  }

  const report = value;
  const suites = Array.isArray(report.testResults) ? report.testResults : [];
  const skipped = [];
  const files = [];
  for (const suite of suites) {
    if (!suite || typeof suite !== 'object' || Array.isArray(suite)) continue;
    const file = displayPath(typeof suite.name === 'string' ? suite.name : 'unknown', rootDirectory);
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    files.push({ file, tests: assertions.length });
    for (const assertion of assertions) {
      if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) continue;
      if (!['pending', 'skipped', 'todo'].includes(assertion.status)) continue;
      skipped.push({
        file,
        title: typeof assertion.title === 'string' ? assertion.title : 'unnamed skipped assertion',
        name: typeof assertion.fullName === 'string'
          ? assertion.fullName
          : typeof assertion.title === 'string'
            ? assertion.title
            : 'unnamed skipped assertion',
        status: assertion.status,
      });
    }
  }

  return {
    totalSuites: integer(report.numTotalTestSuites),
    passedSuites: integer(report.numPassedTestSuites),
    failedSuites: integer(report.numFailedTestSuites),
    pendingSuites: integer(report.numPendingTestSuites),
    totalTests: integer(report.numTotalTests),
    passedTests: integer(report.numPassedTests),
    failedTests: integer(report.numFailedTests),
    pendingTests: integer(report.numPendingTests),
    todoTests: integer(report.numTodoTests),
    success: report.success === true,
    files: files.sort((left, right) => left.file.localeCompare(right.file)),
    skipped,
  };
}

export function validateVitestBaseline(vitest, platform) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    return [`unsupported Vitest baseline platform: ${platform}`];
  }
  const failures = [];
  if (vitest.totalSuites !== EXPECTED_VITEST_SUITES) {
    failures.push(`expected ${EXPECTED_VITEST_SUITES} Vitest suites, observed ${vitest.totalSuites}`);
  }
  if (vitest.totalTests !== EXPECTED_VITEST_TESTS) {
    failures.push(`expected ${EXPECTED_VITEST_TESTS} Vitest tests, observed ${vitest.totalTests}`);
  }

  const expectedFiles = new Map(Object.entries(EXPECTED_VITEST_FILE_TESTS));
  const observedFiles = new Map();
  for (const item of vitest.files ?? []) {
    if (observedFiles.has(item.file)) failures.push(`duplicate Vitest file report: ${item.file}`);
    observedFiles.set(item.file, item.tests);
  }
  for (const [file, tests] of expectedFiles) {
    if (!observedFiles.has(file)) failures.push(`missing Vitest file: ${file}`);
    else if (observedFiles.get(file) !== tests) {
      failures.push(`expected ${tests} tests in ${file}, observed ${observedFiles.get(file)}`);
    }
  }
  for (const file of observedFiles.keys()) {
    if (!expectedFiles.has(file)) failures.push(`unexpected Vitest file: ${file}`);
  }

  if (vitest.todoTests !== 0) failures.push(`expected no todo tests, observed ${vitest.todoTests}`);
  const expectedSkips = expectedVitestSkips(platform);
  const expectedSkipKeys = expectedSkips.map(skipKey).sort();
  const observedSkipKeys = (vitest.skipped ?? []).map(skipKey).sort();
  if (JSON.stringify(observedSkipKeys) !== JSON.stringify(expectedSkipKeys)) {
    const missing = expectedSkipKeys.filter((key) => !observedSkipKeys.includes(key));
    const unexpected = observedSkipKeys.filter((key) => !expectedSkipKeys.includes(key));
    failures.push([
      `expected ${expectedSkipKeys.length} platform skips, observed ${observedSkipKeys.length}`,
      ...(missing.length > 0 ? [`missing: ${missing.join(', ')}`] : []),
      ...(unexpected.length > 0 ? [`unexpected: ${unexpected.join(', ')}`] : []),
    ].join('; '));
  }
  if (vitest.pendingTests !== observedSkipKeys.length) {
    failures.push(`Vitest pending count ${vitest.pendingTests} does not match ${observedSkipKeys.length} reported skips`);
  }
  return failures;
}

export function expectedVitestSkips(platform) {
  if (platform === 'win32') return [...WINDOWS_VITEST_SKIPS];
  if (platform === 'linux') return [POSIX_CASE_ALIAS_SKIP, MACOS_WIZARD_CASE_ALIAS_SKIP];
  if (platform === 'darwin') return [];
  return [];
}

export function parsePythonSkips(output) {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /\.\.\. skipped (?:'[^']*'|"[^"]*")$/u.test(line));
}

export function parsePythonTestCount(output) {
  const match = /^Ran\s+(\d+)\s+tests?\s+in\b/mu.exec(output);
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function unexpectedPackageImportStderr(output) {
  const stderr = String(output).trim();
  if (!stderr || NODE_SQLITE_EXPERIMENTAL_WARNING.test(stderr)) return '';
  return stderr;
}

export function renderQualificationSummary(report) {
  const lines = [
    `# Cross-platform qualification: ${report.overall}`,
    '',
    `Host: \`${report.host.platform}/${report.host.architecture}\` · Node \`${report.host.nodeVersion}\` · Python \`${report.host.pythonVersion}\``,
    '',
    '| Stage | Result | Duration |',
    '| --- | --- | ---: |',
    ...report.stages.map((stage) => `| ${escapeCell(stage.id)} | ${stage.status} | ${stage.durationMs} ms |`),
    '',
    `Vitest: ${report.vitest.passedTests}/${report.vitest.totalTests} passed, ${report.vitest.failedTests} failed, ${report.vitest.pendingTests} skipped/pending, ${report.vitest.todoTests} todo.`,
    `Vitest corpus baseline: ${report.vitest.baseline?.status ?? 'not recorded'} (${report.vitest.baseline?.expectedFiles ?? 0} files, ${report.vitest.baseline?.expectedSuites ?? 0} suites, ${report.vitest.baseline?.expectedTests ?? 0} registered tests expected).`,
    ...(report.python.status === 'skipped'
      ? [`Python training safety: skipped (Windows N/A) — ${report.python.reason}`]
      : report.python.status === 'passed'
        ? [`Python training safety: ${report.python.testCount}/${EXPECTED_PYTHON_TRAINING_TESTS} tests passed.`]
        : []),
    '',
    '## Platform coverage and explicit exclusions',
    '',
    '| Capability | Disposition | Detail |',
    '| --- | --- | --- |',
    ...report.coverage.map((item) => `| ${escapeCell(item.id)} | ${item.status} | ${escapeCell(item.detail)} |`),
    '',
    '## Skipped tests reported by the runners',
    '',
  ];

  if (
    report.vitest.skipped.length === 0
    && report.python.skipped.length === 0
    && report.python.status !== 'skipped'
  ) {
    lines.push('No framework-level tests were skipped on this host. The capability table above still records hardware/model lanes intentionally outside lightweight CI.');
  } else {
    if (report.python.status === 'skipped') {
      lines.push(`- Python training safety stage: Windows N/A — ${report.python.reason}`);
    }
    for (const test of report.vitest.skipped) {
      lines.push(`- Vitest \`${test.file}\`: ${test.name} (${test.status})`);
    }
    for (const test of report.python.skipped) lines.push(`- Python: ${test}`);
  }

  lines.push(
    '',
    '## Scope',
    '',
    ...report.limitations.map((item) => `- ${item}`),
    '',
  );
  return lines.join('\n');
}

function displayPath(path, rootDirectory) {
  const absolute = resolve(path);
  const root = resolve(rootDirectory);
  const local = relative(root, absolute);
  if (local && local !== '..' && !local.startsWith(`..${sep}`)) return local.split(sep).join('/');
  return absolute.split(sep).join('/');
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function skipKey(item) {
  return `${item.file}\0${item.title}`;
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

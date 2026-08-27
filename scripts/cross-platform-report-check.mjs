import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXPECTED_PYTHON_TRAINING_TESTS,
  EXPECTED_VITEST_FILE_TESTS,
  EXPECTED_VITEST_SUITES,
  EXPECTED_VITEST_TESTS,
  WINDOWS_PYTHON_TRAINING_SKIP_REASON,
  expectedVitestSkips,
  parsePythonSkips,
  parsePythonTestCount,
  parseVitestReport,
  platformCoverage,
  renderQualificationSummary,
  unexpectedPackageImportStderr,
  validateVitestBaseline,
} from './cross-platform-report.mjs';

test('makes every Windows-only exclusion explicit', () => {
  const coverage = platformCoverage('win32', 'x64');
  const status = new Map(coverage.map((item) => [item.id, item.status]));
  const byId = new Map(coverage.map((item) => [item.id, item]));

  assert.equal(status.get('portable-core'), 'run');
  assert.equal(status.get('windows-native-node'), 'run');
  assert.equal(status.get('portable-file-identity-hardening'), 'run');
  assert.equal(status.get('posix-mode-and-uid-semantics'), 'skipped');
  assert.equal(status.get('windows-ntfs-acl-isolation'), 'skipped');
  assert.match(byId.get('windows-ntfs-acl-isolation').detail, /does not certify NTFS DACL/u);
  assert.equal(status.get('unix-domain-socket-control'), 'skipped');
  assert.equal(status.get('shell-whisper-fixture'), 'skipped');
  assert.equal(status.get('mlx-python-training-safety-tests'), 'skipped');
  assert.equal(status.get('linux-4gb-cgroup-model-soak'), 'skipped');
  assert.equal(byId.get('mlx-python-training-safety-tests').detail, WINDOWS_PYTHON_TRAINING_SKIP_REASON);
  assert.equal(byId.get('portable-core').evidence.includes('python-training-tests'), false);
  assert.equal(byId.get('portable-core').evidence.includes('packed-install-smoke'), true);
  assert.equal(byId.get('windows-native-node').evidence.includes('python-training-tests'), false);
});

test('keeps Mac and Linux hardware claims narrower than CI coverage', () => {
  const mac = new Map(platformCoverage('darwin', 'arm64').map((item) => [item.id, item.status]));
  const linux = new Map(platformCoverage('linux', 'x64').map((item) => [item.id, item.status]));

  assert.equal(mac.get('macos-apple-silicon-core'), 'run');
  assert.equal(mac.get('mlx-python-training-safety-tests'), 'run');
  assert.equal(mac.get('mlx-local-model-qualification'), 'skipped');
  assert.equal(linux.get('linux-native-node'), 'run');
  assert.equal(linux.get('mlx-python-training-safety-tests'), 'run');
  assert.equal(linux.get('linux-4gb-cgroup-model-soak'), 'skipped');
});

test('records the exact Python training safety test count', () => {
  assert.equal(parsePythonTestCount(`Ran ${EXPECTED_PYTHON_TRAINING_TESTS} tests in 0.481s\n\nOK\n`), 38);
  assert.equal(parsePythonTestCount('test_example ... ok\nOK\n'), null);
});

test('permits only Node\'s exact node:sqlite import warning on stderr', () => {
  const warning = [
    '(node:3674) ExperimentalWarning: SQLite is an experimental feature and might change at any time',
    '(Use `node --trace-warnings ...` to show where the warning was created)',
  ].join('\n');

  assert.equal(unexpectedPackageImportStderr(''), '');
  assert.equal(unexpectedPackageImportStderr(`${warning}\n`), '');
  assert.equal(unexpectedPackageImportStderr(warning.replaceAll('\n', '\r\n')), '');
  assert.equal(unexpectedPackageImportStderr(`${warning}\n${warning}`), `${warning}\n${warning}`);
  assert.equal(unexpectedPackageImportStderr(`application log\n${warning}`), `application log\n${warning}`);
  assert.equal(unexpectedPackageImportStderr(`${warning}\napplication log`), `${warning}\napplication log`);
  assert.equal(
    unexpectedPackageImportStderr('(node:1) DeprecationWarning: unexpected'),
    '(node:1) DeprecationWarning: unexpected',
  );
});

test('pins the complete Vitest corpus and exact platform skip multisets', () => {
  assert.equal(Object.values(EXPECTED_VITEST_FILE_TESTS).reduce((sum, count) => sum + count, 0), EXPECTED_VITEST_TESTS);
  assert.equal(expectedVitestSkips('darwin').length, 0);
  assert.equal(expectedVitestSkips('linux').length, 2);
  assert.equal(expectedVitestSkips('win32').length, 33);

  for (const platform of ['darwin', 'linux', 'win32']) {
    const skipped = expectedVitestSkips(platform).map((item) => ({
      ...item,
      name: item.title,
      status: 'pending',
    }));
    const report = {
      totalSuites: EXPECTED_VITEST_SUITES,
      totalTests: EXPECTED_VITEST_TESTS,
      todoTests: 0,
      pendingTests: skipped.length,
      files: Object.entries(EXPECTED_VITEST_FILE_TESTS).map(([file, tests]) => ({ file, tests })),
      skipped,
    };
    assert.deepEqual(validateVitestBaseline(report, platform), []);
    assert.match(
      validateVitestBaseline({ ...report, totalTests: EXPECTED_VITEST_TESTS - 1 }, platform)[0],
      new RegExp(`expected ${EXPECTED_VITEST_TESTS} Vitest tests`, 'u'),
    );
    assert.match(
      validateVitestBaseline({
        ...report,
        pendingTests: skipped.length + 1,
        skipped: [...skipped, {
          file: 'tests/runtime.test.ts',
          title: 'unexpected skip',
          name: 'unexpected skip',
          status: 'pending',
        }],
      }, platform).join('\n'),
      /unexpected/u,
    );
  }
});

test('extracts skipped Vitest and Python cases into the rendered evidence', () => {
  const vitest = parseVitestReport({
    numTotalTestSuites: 1,
    numPassedTestSuites: 1,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 2,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 1,
    numTodoTests: 0,
    success: true,
    testResults: [{
      name: '/workspace/tests/transport.test.ts',
      assertionResults: [
        { title: 'portable behavior', fullName: 'portable behavior', status: 'passed' },
        { title: 'Unix socket behavior', fullName: 'Unix socket behavior', status: 'pending' },
      ],
    }],
  }, '/workspace');
  const pythonSkipped = parsePythonSkips("test_optional (...) ... skipped 'requires MLX'\nOK (skipped=1)\n");
  const summary = renderQualificationSummary({
    overall: 'passed',
    host: { platform: 'win32', architecture: 'x64', nodeVersion: 'v24.11.1', pythonVersion: '3.12.10' },
    stages: [{ id: 'vitest', status: 'passed', durationMs: 12 }],
    vitest,
    python: {
      status: 'skipped',
      testCount: null,
      expectedTestCount: EXPECTED_PYTHON_TRAINING_TESTS,
      skipped: pythonSkipped,
      reason: WINDOWS_PYTHON_TRAINING_SKIP_REASON,
    },
    coverage: platformCoverage('win32', 'x64'),
    limitations: ['Hosted CI is not a 4 GiB hardware certification.'],
  });

  assert.deepEqual(vitest.skipped, [{
    file: 'tests/transport.test.ts',
    title: 'Unix socket behavior',
    name: 'Unix socket behavior',
    status: 'pending',
  }]);
  assert.equal(pythonSkipped.length, 1);
  assert.match(summary, /Unix socket behavior/);
  assert.match(summary, /Python training safety: skipped \(Windows N\/A\)/);
  assert.match(summary, /Python training safety stage: Windows N\/A/);
  assert.match(summary, /POSIX dir_fd/);
  assert.doesNotMatch(summary, /No framework-level tests were skipped/);
  assert.match(summary, /linux-4gb-cgroup-model-soak \| skipped/);
});

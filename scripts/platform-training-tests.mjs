#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { WINDOWS_PYTHON_TRAINING_SKIP_REASON } from './cross-platform-report.mjs';

if (process.platform === 'win32') {
  console.log(`SKIP python-training-tests (Windows N/A): ${WINDOWS_PYTHON_TRAINING_SKIP_REASON}`);
  process.exit(0);
}

const launcher = fileURLToPath(new URL('./run-python.mjs', import.meta.url));
const result = spawnSync(
  process.execPath,
  [launcher, '-m', 'unittest', 'discover', '-s', 'training/tests', '-v'],
  {
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  },
);

if (result.error) {
  process.stderr.write(`Could not start the Python training safety suite: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);

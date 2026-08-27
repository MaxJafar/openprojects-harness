import { spawnSync } from 'node:child_process';

const requested = process.env.OPENPROJECTS_PYTHON?.trim();
if (requested?.includes('\0')) {
  process.stderr.write('OPENPROJECTS_PYTHON contains a forbidden NUL byte\n');
  process.exit(1);
}

const candidates = requested
  ? [{ command: requested, prefix: [] }]
  : process.platform === 'win32'
    ? [
        { command: 'py', prefix: ['-3'] },
        { command: 'python', prefix: [] },
      ]
    : [
        { command: 'python3', prefix: [] },
        { command: 'python', prefix: [] },
      ];

for (const candidate of candidates) {
  const result = spawnSync(candidate.command, [...candidate.prefix, ...process.argv.slice(2)], {
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error?.code === 'ENOENT') continue;
  if (result.error) {
    process.stderr.write(`Could not start the configured Python interpreter: ${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

process.stderr.write(
  'Python 3 was not found. Install it or set OPENPROJECTS_PYTHON to the reviewed interpreter path.\n',
);
process.exit(1);

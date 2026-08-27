import { delimiter, extname, join, win32 } from 'node:path';

const WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS = Object.freeze(['.COM', '.EXE']);

/**
 * Returns the explicit files that may satisfy one PATH entry for a command.
 * Windows CreateProcess does not execute .cmd/.bat files without a shell, so
 * this deliberately keeps the shell-free contract to native .com/.exe files.
 */
export function executablePathCandidates(
  directory: string,
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const exact = platform === 'win32' ? win32.join(directory, command) : join(directory, command);
  const extension = platform === 'win32' ? win32.extname(command) : extname(command);
  if (platform !== 'win32') return [exact];
  if (extension) return isShellFreeExecutablePath(command, platform) ? [exact] : [];
  return windowsExecutableExtensions(environment).map((extension) => `${exact}${extension}`);
}

/**
 * Whether a configured path can be launched by this harness without a shell.
 * Extensionless Windows paths are retained for compatibility with CreateProcess;
 * an explicit extension must identify a native .exe/.com image.
 */
export function isShellFreeExecutablePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return true;
  const extension = win32.extname(path).toUpperCase();
  return extension === '' || WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS.includes(
    extension as (typeof WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS)[number],
  );
}

/** Empty PATH entries are ignored so executable inspection never falls back to cwd. */
export function executableSearchDirectories(
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const pathValue = environmentValue(environment, 'PATH') ?? '';
  const separator = platform === 'win32' ? ';' : delimiter;
  return pathValue
    .split(separator)
    .map((entry) => unquoteWindowsPath(entry.trim(), platform))
    .filter(Boolean);
}

function windowsExecutableExtensions(
  environment: Readonly<Record<string, string | undefined>>,
): string[] {
  const configured = environmentValue(environment, 'PATHEXT');
  const values = (configured ?? WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS.join(';'))
    .split(';')
    .map((value) => value.trim().toUpperCase())
    .filter((value) => /^\.[A-Z0-9]{1,16}$/u.test(value))
    .filter((value) => WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS.includes(
      value as (typeof WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS)[number],
    ));
  return [...new Set(values.length ? values : WINDOWS_DIRECT_EXECUTABLE_EXTENSIONS)];
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const exact = environment[name];
  if (exact !== undefined) return exact;
  const key = Object.keys(environment).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : environment[key];
}

function unquoteWindowsPath(value: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32' || value.length < 2 || value[0] !== '"' || value.at(-1) !== '"') return value;
  return value.slice(1, -1);
}

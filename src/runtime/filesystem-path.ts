/**
 * Stable conservative comparison key for already-resolved filesystem paths.
 * Windows and default macOS volumes are case-insensitive; macOS also treats
 * canonically equivalent Unicode spellings as aliases. False rejection on a
 * case-sensitive Mac volume is preferable to bypassing a protected-path check.
 */
export function filesystemPathKey(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') return path.toLowerCase();
  if (platform === 'darwin') return path.normalize('NFD').toLowerCase();
  return path;
}

import { describe, expect, it } from 'vitest';

import {
  executablePathCandidates,
  executableSearchDirectories,
  isShellFreeExecutablePath,
} from '../src/runtime/executable-path.js';
import { filesystemPathKey } from '../src/runtime/filesystem-path.js';

describe('Windows process portability', () => {
  it('discovers case-insensitive PATH and only direct shell-free PATHEXT executables', () => {
    const environment = {
      Path: '"C:\\Program Files\\OpenProjects";C:\\Tools;;',
      PathExt: '.CMD;.EXE;.COM;.BAT;.EXE',
    };

    expect(executableSearchDirectories('win32', environment)).toEqual([
      'C:\\Program Files\\OpenProjects',
      'C:\\Tools',
    ]);
    expect(executablePathCandidates('C:\\Tools', 'ffmpeg', 'win32', environment)).toEqual([
      'C:\\Tools\\ffmpeg.EXE',
      'C:\\Tools\\ffmpeg.COM',
    ]);
    expect(executablePathCandidates('C:\\Tools', 'ffmpeg.exe', 'win32', environment)).toEqual([
      'C:\\Tools\\ffmpeg.exe',
    ]);
    expect(executablePathCandidates('C:\\Tools', 'ffmpeg.cmd', 'win32', environment)).toEqual([]);
    expect(executablePathCandidates('C:\\Tools', 'ffmpeg.BAT', 'win32', environment)).toEqual([]);
    expect(isShellFreeExecutablePath('C:\\Tools\\ffmpeg.COM', 'win32')).toBe(true);
    expect(isShellFreeExecutablePath('C:\\Tools\\ffmpeg.ps1', 'win32')).toBe(false);
    expect(isShellFreeExecutablePath('.\\ffmpeg.cmd', 'win32')).toBe(false);
    expect(isShellFreeExecutablePath('/usr/local/bin/ffmpeg.cmd', 'linux')).toBe(true);
  });

  it('uses safe executable defaults when PATHEXT is absent or unusable', () => {
    expect(executablePathCandidates('C:\\Tools', 'worker', 'win32', {})).toEqual([
      'C:\\Tools\\worker.COM',
      'C:\\Tools\\worker.EXE',
    ]);
    expect(executablePathCandidates('C:\\Tools', 'worker', 'win32', { PATHEXT: '.CMD;.BAT' })).toEqual([
      'C:\\Tools\\worker.COM',
      'C:\\Tools\\worker.EXE',
    ]);
  });

  it('conservatively folds Windows and macOS path aliases for collision checks', () => {
    expect(filesystemPathKey('C:\\OpenProjects\\Data.db', 'win32'))
      .toBe(filesystemPathKey('c:\\openprojects\\data.DB', 'win32'));
    expect(filesystemPathKey('/Volumes/Project/RÉSUMÉ.db', 'darwin'))
      .toBe(filesystemPathKey('/volumes/project/re\u0301sume\u0301.DB', 'darwin'));
    expect(filesystemPathKey('/OpenProjects/Data.db', 'linux'))
      .not.toBe(filesystemPathKey('/openprojects/data.db', 'linux'));
  });
});

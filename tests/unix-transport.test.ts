import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createUnixSocketFetch,
  UnixTransportError,
} from '../src/api/unix-fetch.js';
import {
  closeUnixSocketServer,
  assertUnixSocketPathAvailable,
  listenOnUnixSocket,
  probeUnixSocketPath,
  resolveProtectedUnixSocketClientPath,
  resolveUnixSocketPath,
  UnixSocketLiveEndpointError,
  UnixSocketPathOccupiedError,
  UnixSocketStaleCandidateError,
  type UnixSocketLease,
} from '../src/server-endpoint.js';

const POSIX = process.platform !== 'win32' && process.geteuid !== undefined;
const temporaryDirectories = new Set<string>();
const openEndpoints = new Set<{ server: Server; lease: UnixSocketLease }>();

afterEach(async () => {
  for (const endpoint of openEndpoints) {
    if (endpoint.server.listening) {
      endpoint.server.closeAllConnections();
      await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
    }
    try {
      endpoint.lease.cleanup();
    } catch {
      // A specific test may intentionally replace the socket inode.
    }
  }
  openEndpoints.clear();
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe.skipIf(!POSIX)('Unix-domain-socket HTTP transport', () => {
  it('sends bounded JSON and returns a fetch-compatible JSON response', async () => {
    const endpoint = await startEndpoint(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
      }));
    });
    const fetch = createUnixSocketFetch({ socketPath: endpoint.lease.socketPath });

    const response = await fetch('http://localhost/api/runs?workspaceId=local', {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: 'Bearer local-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: 'hello' }),
    });

    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({
      method: 'POST',
      url: '/api/runs?workspaceId=local',
      authorization: 'Bearer local-secret',
      body: { message: 'hello' },
    });
  });

  it('streams SSE response chunks and propagates AbortSignal after headers', async () => {
    const endpoint = await startEndpoint((request, response) => {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      response.write('event: ready\ndata: {}\n\n');
      const interval = setInterval(() => response.write(': keepalive\n\n'), 20);
      request.once('close', () => clearInterval(interval));
    });
    const fetch = createUnixSocketFetch({ socketPath: endpoint.lease.socketPath });
    const controller = new AbortController();

    const response = await fetch('http://localhost/api/events/stream', {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: ready');

    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('maps pre-response aborts and response-header timeouts without leaking the path', async () => {
    const endpoint = await startEndpoint(() => undefined);
    const controller = new AbortController();
    const fetch = createUnixSocketFetch({
      socketPath: endpoint.lease.socketPath,
      headerTimeoutMs: 100,
    });
    const pending = fetch('http://localhost/api/hang', { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    const timeout = await captureError(fetch('http://localhost/api/hang'));
    expect(timeout).toMatchObject({ code: 'TIMEOUT' });
    expect((timeout as Error).message).not.toContain(endpoint.lease.socketPath);
  });

  it('rejects oversized/non-JSON bodies, forbidden headers, methods, and other origins', async () => {
    const endpoint = await startEndpoint((_request, response) => response.end('{}'));
    const fetch = createUnixSocketFetch({
      socketPath: endpoint.lease.socketPath,
      maxRequestBodyBytes: 8,
    });

    await expect(fetch('http://localhost/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '123456789',
    })).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    await expect(fetch('http://localhost/api', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(fetch('http://localhost/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken',
    })).rejects.toThrow('must contain valid JSON');
    await expect(fetch('http://localhost/api', {
      headers: { connection: 'close' },
    })).rejects.toThrow('header connection is forbidden');
    await expect(fetch('http://localhost/api', { method: 'TRACE' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    await expect(fetch('http://example.test/api')).rejects.toThrow('escaped its virtual origin');
  });

  it('never follows redirects and maps an absent socket to a sanitized unavailable error', async () => {
    const endpoint = await startEndpoint((_request, response) => {
      response.writeHead(302, { location: 'http://example.test/exfiltrate' });
      response.end();
    });
    const fetch = createUnixSocketFetch({ socketPath: endpoint.lease.socketPath });
    await expect(fetch('http://localhost/api')).rejects.toMatchObject({ code: 'REDIRECT_REFUSED' });

    const absentPath = join(protectedDirectory(), 'absent.sock');
    const absentFetch = createUnixSocketFetch({ socketPath: absentPath });
    const error = await captureError(absentFetch('http://localhost/api'));
    expect(error).toMatchObject({ code: 'UNAVAILABLE' });
    expect((error as Error).message).not.toContain(absentPath);
  });
});

describe.skipIf(!POSIX)('Unix control server endpoint', () => {
  it('requires an owner-only parent and refuses every existing leaf as occupied', () => {
    const permissive = protectedDirectory();
    chmodSync(permissive, 0o755);
    expect(() => resolveUnixSocketPath(join(permissive, 'control.sock'))).toThrow('mode 0700');

    const protectedParent = protectedDirectory();
    const existing = join(protectedParent, 'control.sock');
    writeFileSync(existing, 'not a socket');
    expect(() => resolveUnixSocketPath(existing)).toThrow(UnixSocketPathOccupiedError);
    expect(() => resolveUnixSocketPath('relative.sock')).toThrow('normalized and absolute');
  });

  it('listens with mode 0600 and cleans the endpoint after server shutdown', async () => {
    const endpoint = await startEndpoint((_request, response) => response.end('ok'));
    expect(lstatSync(endpoint.lease.socketPath).isSocket()).toBe(true);
    expect(lstatSync(endpoint.lease.socketPath).mode & 0o7777).toBe(0o600);
    expect(resolveProtectedUnixSocketClientPath(endpoint.lease.socketPath)).toBe(
      endpoint.lease.socketPath,
    );

    chmodSync(endpoint.lease.socketPath, 0o666);
    expect(() => resolveProtectedUnixSocketClientPath(endpoint.lease.socketPath)).toThrow(
      'mode 0600',
    );
    chmodSync(endpoint.lease.socketPath, 0o600);
    chmodSync(dirname(endpoint.lease.socketPath), 0o755);
    expect(() => resolveProtectedUnixSocketClientPath(endpoint.lease.socketPath)).toThrow(
      'parent must have mode 0700',
    );
    chmodSync(dirname(endpoint.lease.socketPath), 0o700);

    const fetch = createUnixSocketFetch({ socketPath: endpoint.lease.socketPath });
    expect(await (await fetch('http://localhost/health')).text()).toBe('ok');

    openEndpoints.delete(endpoint);
    await closeUnixSocketServer(endpoint.server, endpoint.lease);
    expect(existsSync(endpoint.lease.socketPath)).toBe(false);
    expect(readdirSync(dirname(endpoint.lease.socketPath))).toEqual([]);
    expect(() => endpoint.lease.cleanup()).not.toThrow();
  });

  it('refuses to unlink a replacement socket inode', async () => {
    const parent = protectedDirectory();
    const path = join(parent, 'control.sock');
    const firstServer = createServer();
    const firstLease = await listenOnUnixSocket(firstServer, path);
    const firstIdentity = lstatSync(path);
    await new Promise<void>((resolve) => firstServer.close(() => resolve()));

    const replacementServer = createServer();
    const replacementLease = await listenOnUnixSocket(replacementServer, path);
    const replacement = { server: replacementServer, lease: replacementLease };
    openEndpoints.add(replacement);

    const replacementIdentity = lstatSync(path);
    expect([replacementIdentity.dev, replacementIdentity.ino]).not.toEqual([
      firstIdentity.dev,
      firstIdentity.ino,
    ]);
    expect(() => firstLease.cleanup()).toThrow('identity changed');
    expect(lstatSync(path).isSocket()).toBe(true);
    expect(readdirSync(parent).some((entry) => {
      const stats = lstatSync(join(parent, entry));
      return stats.dev === firstIdentity.dev && stats.ino === firstIdentity.ino;
    })).toBe(false);
    expect(() => firstLease.cleanup()).not.toThrow();
  });

  it('sanitizes listen failures into endpoint-specific errors', async () => {
    const path = join(protectedDirectory(), 'control.sock');
    const first = createServer();
    const firstLease = await listenOnUnixSocket(first, path);
    const endpoint = { server: first, lease: firstLease };
    openEndpoints.add(endpoint);

    const second = createServer();
    await expect(listenOnUnixSocket(second, path)).rejects.toBeInstanceOf(UnixSocketLiveEndpointError);
    expect(lstatSync(path).isSocket()).toBe(true);
  });

  it('diagnoses but never removes an unresponsive crash-left socket', async () => {
    const path = join(protectedDirectory(), 'control.sock');
    await leaveCrashSocket(path);

    await expect(probeUnixSocketPath(path, 250)).resolves.toMatchObject({ status: 'unresponsive' });
    await expect(assertUnixSocketPathAvailable(path)).rejects.toBeInstanceOf(
      UnixSocketStaleCandidateError,
    );
    expect(lstatSync(path).isSocket()).toBe(true);
  });
});

async function startEndpoint(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; lease: UnixSocketLease }> {
  const server = createServer(handler);
  const lease = await listenOnUnixSocket(server, join(protectedDirectory(), 'control.sock'));
  const endpoint = { server, lease };
  openEndpoints.add(endpoint);
  return endpoint;
}

function protectedDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'op-unix-'));
  chmodSync(directory, 0o700);
  temporaryDirectories.add(directory);
  return directory;
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error('Expected operation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(UnixTransportError);
    return error;
  }
}

async function leaveCrashSocket(path: string): Promise<void> {
  const script = [
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    "const server = net.createServer();",
    "server.listen(process.argv[1], () => {",
    "  fs.chmodSync(process.argv[1], 0o600);",
    "  process.stdout.write('ready\\n');",
    "});",
    'setInterval(() => undefined, 1000);',
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script, path], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Crash-socket fixture did not start')), 2_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.once('data', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  child.kill('SIGKILL');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

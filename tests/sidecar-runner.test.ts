import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp, type OpenProjectsApp } from '../src/app.js';
import type { ControlClientCredential } from '../src/auth/control-auth.js';
import type { AppConfig, ServerAuthConfig } from '../src/core/types.js';
import type { CorporateRecordInput } from '../src/oracle/corporate-oracle.js';
import {
  OracleSidecarClient,
  OracleSyncAmbiguousError,
} from '../src/sidecars/oracle-client.js';
import type {
  SidecarProviderAdapter,
  SidecarReadWindow,
} from '../src/sidecars/providers/provider.js';
import {
  decodeSidecarCursor,
  renderSidecarReport,
  runSidecarSync,
  sidecarCheckReport,
  sidecarFailureReport,
} from '../src/sidecars/runner.js';
import { openSidecarState, type SidecarState } from '../src/sidecars/state.js';
import type {
  LoadedSidecarConfig,
  PendingSidecarPage,
  SidecarCheckpoint,
  SidecarProviderPage,
  SidecarSyncReceipt,
} from '../src/sidecars/types.js';
import { startServer, type StartedServer } from '../src/server.js';

const CONNECTOR_ID = 'linear-sidecar';
const WORKSPACE_ID = 'workspace-a';
const ACCOUNT_ID = 'linear-org-123';
const STREAM = 'issues';
const NOW = '2026-08-27T12:00:00.000Z';
const CONTRACT_SHA256 = 'b'.repeat(64);
const CONFIG_SHA256 = 'a'.repeat(64);
const TOKEN = 'sidecar-control-token-1234567890abcdef';

const identityRequest = Object.freeze({
  method: 'POST' as const,
  origin: 'https://api.linear.app',
  path: '/graphql',
  operation: 'identity-read' as const,
});

const recordsRequest = Object.freeze({
  method: 'POST' as const,
  origin: 'https://api.linear.app',
  path: '/graphql',
  operation: 'records-read' as const,
});

const temporaryDirectories = new Set<string>();

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe('OracleSidecarClient and sidecar runner', () => {
  it('syncs two finite pages through the real authenticated server and enforces CAS and scope binding', async () => {
    const fixture = await createLiveFixture('openprojects-sidecar-e2e-');
    const complete = vi.spyOn(fixture.app.kernel.model('mock'), 'complete');
    const provider = sequencedProvider([
      providerPage([corporateRecord('issue-1')], 'provider-page-2'),
      providerPage([corporateRecord('issue-2')]),
    ]);

    try {
      const report = await runSidecarSync(fixture.loaded, {
        provider,
        oracle: new OracleSidecarClient(fixture.loaded, {
          allowInsecureLoopbackTestOnly: true,
        }),
        clock: () => new Date(NOW),
        uuid: () => 'cycle-e2e',
      });

      expect(provider.fetchPage).toHaveBeenCalledTimes(2);
      expect(provider.assertCredentialAbsent).toHaveBeenCalledTimes(2);
      expect(provider.fetchPage).toHaveBeenNthCalledWith(1, { until: NOW });
      expect(provider.fetchPage).toHaveBeenNthCalledWith(2, {
        until: NOW,
        cursor: 'provider-page-2',
      });
      expect(provider.probeIdentity).toHaveBeenCalledTimes(2);
      expect(report).toMatchObject({
        schema: 'openprojects.sidecar-report.v1',
        mode: 'sync',
        overall: 'not_ready',
        testSeam: true,
        provider: {
          kind: 'linear',
          readOnly: true,
          providerWritesAttempted: false,
          credentialLifecycle: 'externally-managed',
          oauthFlowInvoked: false,
        },
        oracle: {
          connected: true,
          ingestionWritesAttempted: true,
          pagesAcknowledged: 2,
          pagesPossiblyCommitted: 2,
          lastWriteOutcome: 'acknowledged',
          recordsReceived: 2,
          inserted: 2,
          updated: 0,
          unchanged: 0,
          stale: 0,
          embeddings: {
            invoked: true,
            invocationOutcome: 'observed',
            stored: 2,
            failed: 0,
            models: [fixture.app.embedding.id],
            dataBoundaries: ['local'],
            errorCount: 0,
            errors: [],
            evidenceTruncated: false,
          },
          finalCheckpoint: {
            cursorSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            sourceWatermark: NOW,
            recordsSeen: 2,
          },
        },
      });
      expect(report.provider.requests).toEqual([
        identityRequest,
        recordsRequest,
        recordsRequest,
        identityRequest,
      ]);
      expect(report.remainingUnqualified).toEqual(expect.arrayContaining([
        expect.stringContaining('provider OAuth'),
        expect.stringContaining('4 GB'),
        expect.stringContaining('Windows'),
        expect.stringContaining('Linux VM'),
        expect.stringContaining('vision'),
      ]));
      expect(renderSidecarReport(report)).toContain(
        'Live qualification disallowed: an injected test seam was present.',
      );
      expect(renderSidecarReport(report)).toContain(
        'Oracle pages acknowledged: 2; possibly committed: 2; last write: acknowledged',
      );
      expect(renderSidecarReport(report)).toContain('boundaries: local');

      const finalCursor = fixture.app.oracle
        .getCheckpoint(WORKSPACE_ID, CONNECTOR_ID, STREAM)?.cursor;
      expect(finalCursor).toBeDefined();
      expect(report.oracle.finalCheckpoint?.cursorSha256).toBe(sha256(finalCursor!));
      expect(JSON.stringify(report)).not.toContain(ACCOUNT_ID);
      expect(decodeSidecarCursor(finalCursor!)).toMatchObject({
        cycleId: 'cycle-e2e',
        page: 2,
        next: null,
        until: NOW,
      });
      const client = new OracleSidecarClient(fixture.loaded, {
        allowInsecureLoopbackTestOnly: true,
      });
      const rollbackProvider = sequencedProvider([
        providerPage([corporateRecord('must-not-fetch-after-clock-rollback')]),
      ]);
      let rollbackError: unknown;
      try {
        await runSidecarSync(fixture.loaded, {
          provider: rollbackProvider,
          oracle: client,
          clock: () => new Date('2026-08-27T11:59:59.000Z'),
          uuid: () => 'rollback-cycle',
        });
      } catch (error) {
        rollbackError = error;
      }
      expect(rollbackError).toMatchObject({
        message: 'Sidecar clock is earlier than the completed Oracle source watermark',
      });
      expect(rollbackProvider.fetchPage).not.toHaveBeenCalled();
      expect(sidecarFailureReport(
        fixture.loaded,
        'sync',
        rollbackError,
        () => new Date(NOW),
      )).toMatchObject({
        oracle: { lastWriteOutcome: 'not_attempted', pagesPossiblyCommitted: 0 },
      });
      expect(fixture.app.oracle.listSources(WORKSPACE_ID)).toMatchObject([{
        source: CONNECTOR_ID,
        sourceAccountId: ACCOUNT_ID,
        stream: STREAM,
        activeRecords: 2,
      }]);
      expect(complete).not.toHaveBeenCalled();
      expect(fixture.app.storage.listRuns(WORKSPACE_ID)).toEqual([]);

      const staleBody = JSON.stringify({
        workspaceId: WORKSPACE_ID,
        source: CONNECTOR_ID,
        sourceAccountId: ACCOUNT_ID,
        stream: STREAM,
        previousCursor: 'stale-cursor',
        cursor: 'cas-must-not-advance',
        records: [],
      });
      await expect(client.submit(pendingPage(staleBody))).rejects.toMatchObject({
        code: 'ORACLE_RESPONSE',
        status: 409,
      });
      expect((await client.getCheckpoint())?.cursor).toBe(finalCursor);

      const wrongAccount = new OracleSidecarClient(loadedConfig({
        directory: fixture.directory,
        baseUrl: fixture.server.url,
        tokenFile: fixture.tokenFile,
        accountId: 'forged-account',
      }), { allowInsecureLoopbackTestOnly: true });
      await expect(wrongAccount.getCheckpoint()).rejects.toMatchObject({
        code: 'ORACLE_SCOPE_DRIFT',
      });
      const wrongAccountBody = JSON.stringify({
        workspaceId: WORKSPACE_ID,
        source: CONNECTOR_ID,
        sourceAccountId: 'forged-account',
        stream: STREAM,
        previousCursor: finalCursor,
        cursor: 'wrong-account-must-not-advance',
        records: [],
      });
      await expect(wrongAccount.submit(pendingPage(wrongAccountBody))).rejects.toMatchObject({
        code: 'ORACLE_RESPONSE',
        status: 409,
      });

      const wrongSource = new OracleSidecarClient(loadedConfig({
        directory: fixture.directory,
        baseUrl: fixture.server.url,
        tokenFile: fixture.tokenFile,
        id: 'forged-source',
      }), { allowInsecureLoopbackTestOnly: true });
      await expect(wrongSource.getCheckpoint()).rejects.toMatchObject({
        code: 'ORACLE_AUTH',
        status: 403,
      });

      const wrongWorkspace = new OracleSidecarClient(loadedConfig({
        directory: fixture.directory,
        baseUrl: fixture.server.url,
        tokenFile: fixture.tokenFile,
        workspaceId: 'workspace-other',
      }), { allowInsecureLoopbackTestOnly: true });
      await expect(wrongWorkspace.getCheckpoint()).rejects.toMatchObject({
        code: 'ORACLE_AUTH',
        status: 403,
      });
      expect((await client.getCheckpoint())?.cursor).toBe(finalCursor);
    } finally {
      await fixture.close();
    }
  });

  it('retains an ambiguous committed page and replays the exact staged bytes on restart', async () => {
    const fixture = await createLiveFixture('openprojects-sidecar-replay-');
    const complete = vi.spyOn(fixture.app.kernel.model('mock'), 'complete');
    const postedBodies: string[] = [];
    let failAfterCommit = true;
    const commitThenDropFetch: typeof globalThis.fetch = async (input, init) => {
      if (requestPath(input) === '/api/oracle/sync' && init?.method === 'POST') {
        const body = stringBody(init.body);
        postedBodies.push(body);
        const response = await globalThis.fetch(input, init);
        if (failAfterCommit) {
          failAfterCommit = false;
          await response.arrayBuffer();
          throw new TypeError('connection closed after the server committed');
        }
        return response;
      }
      return globalThis.fetch(input, init);
    };
    const firstClient = new OracleSidecarClient(fixture.loaded, {
      fetch: commitThenDropFetch,
      allowInsecureLoopbackTestOnly: true,
    });
    const provider = sequencedProvider([
      providerPage([corporateRecord('ambiguous-issue')]),
    ]);

    try {
      let firstError: unknown;
      try {
        await runSidecarSync(fixture.loaded, {
          provider,
          oracle: firstClient,
          clock: () => new Date(NOW),
          uuid: () => 'ambiguous-cycle',
        });
      } catch (error) {
        firstError = error;
      }
      expect(firstError).toBeInstanceOf(OracleSyncAmbiguousError);
      const ambiguousReport = sidecarFailureReport(
        fixture.loaded,
        'sync',
        firstError,
        () => new Date(NOW),
      );
      expect(ambiguousReport).toMatchObject({
        overall: 'not_ready',
        testSeam: true,
        provider: { requests: [identityRequest, recordsRequest] },
        oracle: {
          connected: true,
          ingestionWritesAttempted: true,
          pagesAcknowledged: 0,
          pagesPossiblyCommitted: 1,
          lastWriteOutcome: 'ambiguous',
          recordsReceived: 1,
          cycleComplete: false,
          embeddings: {
            invoked: false,
            invocationOutcome: 'unknown',
            dataBoundaries: [],
          },
        },
      });
      expect(renderSidecarReport(ambiguousReport)).toContain('invocation outcome: unknown');
      expect(renderSidecarReport(ambiguousReport)).toContain(
        'boundaries: unknown (receipt unavailable)',
      );

      expect(postedBodies).toHaveLength(1);
      const retainedState = openSidecarState(fixture.loaded);
      const retained = retainedState.loadPending();
      retainedState.close();
      expect(retained?.body).toBe(postedBodies[0]);
      expect(fixture.app.oracle.getCheckpoint(WORKSPACE_ID, CONNECTOR_ID, STREAM)).toMatchObject({
        cursor: JSON.parse(postedBodies[0]!)['cursor'] as string,
        recordsSeen: 1,
      });

      const replayBodies: string[] = [];
      const replayFetch: typeof globalThis.fetch = async (input, init) => {
        if (requestPath(input) === '/api/oracle/sync' && init?.method === 'POST') {
          replayBodies.push(stringBody(init.body));
        }
        return globalThis.fetch(input, init);
      };
      const replayClient = new OracleSidecarClient(fixture.loaded, {
        fetch: replayFetch,
        allowInsecureLoopbackTestOnly: true,
      });
      const stopAfterReplay = stoppingProvider('stop after retained replay');
      let replayError: unknown;
      try {
        await runSidecarSync(fixture.loaded, {
          provider: stopAfterReplay,
          oracle: replayClient,
          clock: () => new Date(NOW),
          uuid: () => 'unused-cycle',
        });
      } catch (error) {
        replayError = error;
      }
      expect(replayError).toBeInstanceOf(Error);
      expect((replayError as Error).message).toBe('stop after retained replay');
      expect(sidecarFailureReport(fixture.loaded, 'sync', replayError, () => new Date(NOW))).toMatchObject({
        overall: 'not_ready',
        testSeam: true,
        oracle: {
          connected: true,
          ingestionWritesAttempted: true,
          pagesAcknowledged: 1,
          pagesPossiblyCommitted: 1,
          lastWriteOutcome: 'acknowledged',
          recordsReceived: 1,
          cycleComplete: false,
          embeddings: { invocationOutcome: 'not_observed' },
        },
      });

      expect(replayBodies).toEqual([postedBodies[0]]);
      expect(stopAfterReplay.assertCredentialAbsent).toHaveBeenCalledWith(postedBodies[0]);
      expect(stopAfterReplay.probeIdentity).toHaveBeenCalledTimes(1);
      expect(stopAfterReplay.fetchPage).not.toHaveBeenCalled();
      const clearedState = openSidecarState(fixture.loaded);
      expect(clearedState.loadPending()).toBeUndefined();
      clearedState.close();
      expect(fixture.app.oracle.getCheckpoint(WORKSPACE_ID, CONNECTOR_ID, STREAM)).toMatchObject({
        recordsSeen: 1,
      });
      expect(fixture.app.oracle.listSources(WORKSPACE_ID)).toMatchObject([{
        activeRecords: 1,
      }]);
      expect(complete).not.toHaveBeenCalled();
      expect(fixture.app.storage.listRuns(WORKSPACE_ID)).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it('stops at maxPagesPerRun, carries the exact predecessor cursor, and cannot self-qualify through test seams', async () => {
    const directory = temporaryDirectory('openprojects-sidecar-bounded-');
    const loaded = loadedConfig({
      directory,
      baseUrl: 'http://127.0.0.1:9',
      tokenFile: join(directory, 'unused.token'),
      maxPages: 2,
    });
    const submittedBodies: Array<Record<string, unknown>> = [];
    let checkpoint: SidecarCheckpoint | undefined;
    let rejectWrites = false;
    const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
      if (init?.method === 'GET') return jsonResponse({ checkpoint: checkpoint ?? null });
      if (rejectWrites) return jsonResponse({ error: 'rejected fixture page' }, 409);
      const body = JSON.parse(stringBody(init?.body)) as Record<string, unknown>;
      submittedBodies.push(body);
      checkpoint = checkpointFor(loaded, body.cursor as string, {
        recordsSeen: submittedBodies.length,
        ...(typeof body.sourceWatermark === 'string'
          ? { sourceWatermark: body.sourceWatermark }
          : {}),
      });
      return jsonResponse(receiptFor(
        checkpoint,
        { inserted: 1 },
        (body.records as Array<{ externalId: string }>).map((record) => record.externalId),
        submittedBodies.length === 1
          ? {
              model: 'local-embedding-v1',
              dataBoundary: 'local',
              stored: 1,
            }
          : {
              model: 'external-embedding-v2',
              dataBoundary: 'external',
              failed: 1,
              error: 'External embedding failed with Bearer abcdefghijklmnop',
            },
      ));
    };
    const client = new OracleSidecarClient(loaded, {
      fetch: fakeFetch,
      credential: inertCredential(),
      allowInsecureLoopbackTestOnly: true,
    });
    let page = 0;
    const provider: SidecarProviderAdapter = {
      kind: 'linear',
      assertCredentialAbsent: vi.fn(),
      probeIdentity: vi.fn(async () => ({ accountId: ACCOUNT_ID, requests: [identityRequest] })),
      fetchPage: vi.fn(async (): Promise<SidecarProviderPage> => {
        page += 1;
        return providerPage([corporateRecord(`bounded-${page}`)], `provider-next-${page}`);
      }),
    };
    const state = memoryState(loaded);

    const report = await runSidecarSync(loaded, {
      provider,
      oracle: client,
      state,
      clock: () => new Date(NOW),
      uuid: () => 'bounded-cycle',
      testSeam: false,
    });

    expect(provider.fetchPage).toHaveBeenCalledTimes(2);
    expect(provider.probeIdentity).toHaveBeenCalledTimes(2);
    expect(submittedBodies).toHaveLength(2);
    expect(submittedBodies[0]).not.toHaveProperty('previousCursor');
    expect(submittedBodies[1]).toMatchObject({
      previousCursor: submittedBodies[0]?.['cursor'],
    });
    expect(decodeSidecarCursor(submittedBodies[0]?.['cursor'] as string)).toMatchObject({
      page: 1,
      next: 'provider-next-1',
    });
    expect(decodeSidecarCursor(submittedBodies[1]?.['cursor'] as string)).toMatchObject({
      page: 2,
      next: 'provider-next-2',
    });
    const reversedWindowCursor = `opsc1.${Buffer.from(JSON.stringify({
      schema: 'openprojects.sidecar-cursor.v1',
      contractSha256: CONTRACT_SHA256,
      provider: 'linear',
      cycleId: 'reversed-window',
      page: 1,
      from: '2026-08-27T13:00:00.000Z',
      until: '2026-08-27T12:00:00.000Z',
      next: null,
    })).toString('base64url')}`;
    expect(() => decodeSidecarCursor(reversedWindowCursor)).toThrow(
      'Oracle checkpoint sidecar cursor failed validation',
    );
    expect(report).toMatchObject({
      overall: 'not_ready',
      testSeam: true,
      oracle: {
        pagesAcknowledged: 2,
        pagesPossiblyCommitted: 2,
        lastWriteOutcome: 'acknowledged',
        recordsReceived: 2,
        inserted: 2,
        embeddings: {
          invoked: true,
          invocationOutcome: 'observed',
          stored: 1,
          failed: 1,
          models: ['local-embedding-v1', 'external-embedding-v2'],
          dataBoundaries: ['local', 'external'],
          errorCount: 1,
          errors: ['External embedding failed with Bearer [REDACTED:TOKEN]'],
          evidenceTruncated: false,
        },
      },
      provider: {
        readOnly: true,
        providerWritesAttempted: false,
        oauthFlowInvoked: false,
      },
    });
    expect(renderSidecarReport({
      ...report,
      oracle: {
        ...report.oracle,
        embeddings: {
          ...report.oracle.embeddings,
          invocationOutcome: 'unknown',
        },
      },
    })).toContain('boundaries: local, external; ambiguous receipt boundary unknown');
    expect(state.loadPending()).toBeUndefined();

    const check = sidecarCheckReport(loaded, () => new Date(NOW));
    expect(check).toMatchObject({
      mode: 'check',
      overall: 'not_ready',
      testSeam: false,
      error: expect.stringContaining('CA-authenticated loopback HTTPS'),
      oracle: {
        connected: false,
        ingestionWritesAttempted: false,
        pagesAcknowledged: 0,
        pagesPossiblyCommitted: 0,
        lastWriteOutcome: 'not_attempted',
        embeddings: { invocationOutcome: 'not_observed' },
      },
      provider: {
        readOnly: true,
        providerWritesAttempted: false,
        credentialLifecycle: 'externally-managed',
        oauthFlowInvoked: false,
      },
    });

    rejectWrites = true;
    const rejectedProvider = sequencedProvider([
      providerPage([corporateRecord('definitively-rejected')]),
    ]);
    let rejectedError: unknown;
    try {
      await runSidecarSync(loaded, {
        provider: rejectedProvider,
        oracle: client,
        state: memoryState(loaded),
        clock: () => new Date(NOW),
        uuid: () => 'rejected-cycle',
      });
    } catch (error) {
      rejectedError = error;
    }
    expect(sidecarFailureReport(loaded, 'sync', rejectedError, () => new Date(NOW))).toMatchObject({
      oracle: {
        pagesAcknowledged: 0,
        pagesPossiblyCommitted: 0,
        lastWriteOutcome: 'rejected',
      },
    });

    rejectWrites = false;
    const clearFailureProvider = sequencedProvider([
      providerPage([corporateRecord('acknowledged-before-clear-failure')]),
    ]);
    let clearError: unknown;
    try {
      await runSidecarSync(loaded, {
        provider: clearFailureProvider,
        oracle: client,
        state: memoryState(loaded, new Error('fixture spool clear failed')),
        clock: () => new Date(NOW),
        uuid: () => 'clear-failure-cycle',
      });
    } catch (error) {
      clearError = error;
    }
    const clearFailureReport = sidecarFailureReport(
      loaded,
      'sync',
      clearError,
      () => new Date(NOW),
    );
    expect(clearFailureReport).toMatchObject({
      oracle: {
        pagesAcknowledged: 1,
        pagesPossiblyCommitted: 1,
        lastWriteOutcome: 'acknowledged',
      },
    });
    expect(renderSidecarReport(clearFailureReport)).toContain(
      'Oracle pages acknowledged: 1; possibly committed: 1; last write: acknowledged',
    );
  });

  it('rejects staged scope drift and receipts that claim a model or agent run', async () => {
    const directory = temporaryDirectory('openprojects-sidecar-client-');
    const loaded = loadedConfig({
      directory,
      baseUrl: 'http://127.0.0.1:9',
      tokenFile: join(directory, 'unused.token'),
    });
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    expect(() => new OracleSidecarClient(loaded, {
      credential: inertCredential(),
    })).toThrow('CA-authenticated loopback HTTPS');
    const missingSocketLoaded: LoadedSidecarConfig = {
      ...loaded,
      config: {
        ...loaded.config,
        oracle: {
          ...loaded.config.oracle,
          socketPath: join(directory, 'missing.sock'),
        },
      },
    };
    let socketError: unknown;
    try {
      new OracleSidecarClient(missingSocketLoaded);
    } catch (error) {
      socketError = error;
    }
    expect(socketError).toMatchObject({
      code: 'ORACLE_SERVER_AUTH_UNQUALIFIED',
      message: 'Oracle sync requires a protected POSIX socket or CA-authenticated loopback HTTPS',
    });
    const client = new OracleSidecarClient(loaded, {
      fetch: fetchMock,
      credential: inertCredential(),
      allowInsecureLoopbackTestOnly: true,
    });
    const wrongWorkspaceBody = JSON.stringify({
      workspaceId: 'workspace-other',
      source: CONNECTOR_ID,
      sourceAccountId: ACCOUNT_ID,
      stream: STREAM,
      cursor: 'page-1',
      records: [],
    });

    await expect(client.submit(pendingPage(wrongWorkspaceBody))).rejects.toMatchObject({
      code: 'ORACLE_REQUEST_SCOPE',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const cursor = 'page-1';
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...receiptFor(checkpointFor(loaded, cursor), { inserted: 0 }),
      agentRunInvoked: true,
    }));
    const validBody = JSON.stringify({
      workspaceId: WORKSPACE_ID,
      source: CONNECTOR_ID,
      sourceAccountId: ACCOUNT_ID,
      stream: STREAM,
      cursor,
      records: [],
    });
    await expect(client.submit(pendingPage(validBody))).rejects.toMatchObject({
      code: 'ORACLE_SYNC_AMBIGUOUS',
      cause: { code: 'ORACLE_RECEIPT_SCHEMA' },
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(
      receiptFor(checkpointFor(loaded, cursor), { inserted: 1 }),
    ));
    await expect(client.submit(pendingPage(validBody))).rejects.toMatchObject({
      code: 'ORACLE_SYNC_AMBIGUOUS',
      cause: { code: 'ORACLE_RECEIPT_MISMATCH' },
    });
    const validReceipt = receiptFor(checkpointFor(loaded, cursor), { inserted: 0 });
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...validReceipt,
      embeddings: { ...validReceipt.embeddings, dataBoundary: 'elsewhere' },
    }));
    await expect(client.submit(pendingPage(validBody))).rejects.toMatchObject({
      code: 'ORACLE_SYNC_AMBIGUOUS',
      cause: { code: 'ORACLE_RECEIPT_SCHEMA' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const redacted = sidecarFailureReport(
      loaded,
      'probe',
      new Error(`transport exposed Bearer abcdefghijklmnop${String.fromCharCode(0)}detail`),
      () => new Date(NOW),
    );
    expect(redacted.error).toContain('Bearer [REDACTED:TOKEN]');
    expect(redacted.error).not.toContain('abcdefghijklmnop');
    expect(redacted.error).not.toContain(String.fromCharCode(0));
  });
});

interface LoadedConfigOptions {
  readonly directory: string;
  readonly baseUrl: string;
  readonly tokenFile: string;
  readonly id?: string;
  readonly workspaceId?: string;
  readonly accountId?: string;
  readonly maxPages?: number;
}

function loadedConfig(options: LoadedConfigOptions): LoadedSidecarConfig {
  return {
    path: join(options.directory, 'sidecar.yaml'),
    sha256: CONFIG_SHA256,
    contractSha256: CONTRACT_SHA256,
    config: {
      schema: 'openprojects.sidecar.v1',
      id: options.id ?? CONNECTOR_ID,
      workspaceId: options.workspaceId ?? WORKSPACE_ID,
      stream: STREAM,
      oracle: {
        baseUrl: options.baseUrl,
        tokenFile: options.tokenFile,
      },
      state: { directory: join(options.directory, 'sidecar-state') },
      provider: {
        kind: 'linear',
        tokenEnv: 'LINEAR_READ_TOKEN',
        authorization: 'api-key',
        expectedAccountId: options.accountId ?? ACCOUNT_ID,
        teamId: 'linear-team-123',
      },
      limits: {
        pageSize: 50,
        timeoutMs: 5_000,
        maxResponseBytes: 1_000_000,
        overlapSeconds: 60,
        maxPagesPerRun: options.maxPages ?? 4,
      },
    },
  };
}

function corporateRecord(externalId: string): CorporateRecordInput {
  return {
    externalId,
    domain: 'project',
    recordType: 'issue',
    projectId: 'project-atlas',
    title: `Issue ${externalId}`,
    content: `Read-only evidence for ${externalId}`,
    sourceUrl: `https://linear.app/acme/issue/${externalId}`,
    sourceVersion: '1',
    occurredAt: '2026-08-27T10:00:00.000Z',
    sourceUpdatedAt: '2026-08-27T11:00:00.000Z',
    metadata: { provider: 'linear' },
  };
}

function providerPage(
  records: readonly CorporateRecordInput[],
  nextCursor?: string,
): SidecarProviderPage {
  return {
    accountId: ACCOUNT_ID,
    records,
    ...(nextCursor ? { nextCursor } : {}),
    requests: [recordsRequest],
  };
}

function sequencedProvider(pages: readonly SidecarProviderPage[]): SidecarProviderAdapter {
  let index = 0;
  return {
    kind: 'linear',
    assertCredentialAbsent: vi.fn(),
    probeIdentity: vi.fn(async () => ({ accountId: ACCOUNT_ID, requests: [identityRequest] })),
    fetchPage: vi.fn(async (_window: SidecarReadWindow) => {
      const page = pages[index];
      if (!page) throw new Error('Provider received an unexpected extra page request');
      index += 1;
      return page;
    }),
  };
}

function stoppingProvider(message: string): SidecarProviderAdapter {
  return {
    kind: 'linear',
    assertCredentialAbsent: vi.fn(),
    probeIdentity: vi.fn(async () => {
      throw new Error(message);
    }),
    fetchPage: vi.fn(async () => {
      throw new Error('fetchPage must not run');
    }),
  };
}

function pendingPage(body: string): PendingSidecarPage {
  return {
    schema: 'openprojects.sidecar-pending-page.v1',
    contractSha256: CONTRACT_SHA256,
    createdAt: NOW,
    bodySha256: sha256(body),
    body,
  };
}

function checkpointFor(
  loaded: LoadedSidecarConfig,
  cursor: string,
  options: { readonly recordsSeen?: number; readonly sourceWatermark?: string } = {},
): SidecarCheckpoint {
  return {
    workspaceId: loaded.config.workspaceId,
    source: loaded.config.id,
    sourceAccountId: loaded.config.provider.expectedAccountId,
    stream: loaded.config.stream,
    cursor,
    ...(options.sourceWatermark ? { sourceWatermark: options.sourceWatermark } : {}),
    lastBatchSha256: sha256(cursor),
    recordsSeen: options.recordsSeen ?? 0,
    lastSuccessAt: NOW,
  };
}

function receiptFor(
  checkpoint: SidecarCheckpoint,
  counts: Partial<Pick<SidecarSyncReceipt, 'inserted' | 'updated' | 'unchanged' | 'stale'>> = {},
  externalIds: readonly string[] = [],
  embedding: Partial<SidecarSyncReceipt['embeddings']> = {},
): SidecarSyncReceipt {
  const inserted = counts.inserted ?? 0;
  const updated = counts.updated ?? 0;
  const unchanged = counts.unchanged ?? 0;
  const stale = counts.stale ?? 0;
  const recordCount = inserted + updated + unchanged + stale;
  const embeddingStored = embedding.stored ?? 0;
  const embeddingFailed = embedding.failed ?? 0;
  return {
    schema: 'openprojects.corporate-sync-receipt.v1',
    inserted,
    updated,
    unchanged,
    stale,
    records: Array.from({ length: recordCount }, (_, index) => ({
      id: `record-${index + 1}`,
      externalId: externalIds[index] ?? `record-${index + 1}`,
      revision: 1,
      status: 'active' as const,
      contentSha256: sha256(`record-${index + 1}`),
    })),
    checkpoint,
    embeddings: {
      model: embedding.model ?? 'test-embedding-v1',
      dataBoundary: embedding.dataBoundary ?? 'local',
      stored: embeddingStored,
      failed: embeddingFailed,
      error: embedding.error ?? null,
    },
    agentRunInvoked: false,
    chatModelInvoked: false,
    embeddingInvoked: embeddingStored + embeddingFailed > 0,
    modelInvoked: false,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function inertCredential(): ControlClientCredential {
  return Object.freeze({
    authorizationHeader: () => 'Bearer inert-test-token',
  });
}

function memoryState(loaded: LoadedSidecarConfig, clearError?: Error): SidecarState {
  let pending: PendingSidecarPage | undefined;
  return {
    directory: loaded.config.state.directory,
    pendingPath: join(loaded.config.state.directory, 'pending-page.json'),
    loadPending: () => pending,
    stage(body, createdAt) {
      if (pending) throw new Error('pending page already exists');
      pending = {
        schema: 'openprojects.sidecar-pending-page.v1',
        contractSha256: loaded.contractSha256,
        createdAt,
        bodySha256: sha256(body),
        body,
      };
      return pending;
    },
    clear(expectedBodySha256) {
      if (pending && pending.bodySha256 !== expectedBodySha256) {
        throw new Error('refused to clear another page');
      }
      if (clearError) throw clearError;
      pending = undefined;
    },
    close() {},
  };
}

interface LiveFixture {
  readonly directory: string;
  readonly tokenFile: string;
  readonly app: OpenProjectsApp;
  readonly server: StartedServer;
  readonly loaded: LoadedSidecarConfig;
  close(): Promise<void>;
}

async function createLiveFixture(prefix: string): Promise<LiveFixture> {
  const directory = temporaryDirectory(prefix);
  const tokenFile = join(directory, 'connector.token');
  const databasePath = join(directory, 'openprojects.sqlite');
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const auth: ServerAuthConfig = {
    principals: [{
      id: CONNECTOR_ID,
      tokenFile,
      capabilities: ['ingest'],
      workspaces: [WORKSPACE_ID],
    }],
  };
  const app = await createApp({
    config: serverConfig(auth, databasePath),
    skills: [],
    seedDemo: false,
  });
  let server: StartedServer;
  try {
    server = await startServer(app);
  } catch (error) {
    await app.close();
    throw error;
  }
  let closed = false;
  return {
    directory,
    tokenFile,
    app,
    server,
    loaded: loadedConfig({ directory, baseUrl: server.url, tokenFile }),
    async close() {
      if (closed) return;
      closed = true;
      await server.close();
      await app.close();
    },
  };
}

function serverConfig(auth: ServerAuthConfig, databasePath: string): AppConfig {
  return {
    version: 1,
    agent: {
      id: 'sidecar-test-agent',
      version: '1.0.0',
      name: 'Sidecar test agent',
      system: 'Test.',
      skills: [],
      tools: [],
      budgets: {
        maxSteps: 4,
        maxToolCalls: 8,
        maxWallTimeMs: 10_000,
        maxInputTokens: 8_000,
        reservedOutputTokens: 512,
      },
    },
    policy: {
      read: 'allow',
      draft: 'allow',
      memory_write: 'allow',
      internal_write: 'ask',
      external_write: 'ask',
      destructive: 'deny',
    },
    server: { host: '127.0.0.1', port: 0, auth },
    storage: { database: databasePath },
    model: { provider: 'mock', model: 'project-ops-v1' },
    memory: { retrievalLimit: 4, maxContextCharacters: 4_000 },
    notifications: { enabled: false, intervalMs: 60_000, lookaheadHours: 48 },
  };
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === 'string') return new URL(input).pathname;
  if (input instanceof URL) return input.pathname;
  return new URL(input.url).pathname;
}

function stringBody(body: BodyInit | null | undefined): string {
  if (typeof body !== 'string') throw new Error('Expected a serialized JSON request body');
  return body;
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

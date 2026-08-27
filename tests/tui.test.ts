import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp, type OpenProjectsApp } from '../src/app.js';
import type { AppConfig } from '../src/core/types.js';
import { canonicalizeToolArguments } from '../src/runtime/tool-arguments.js';
import {
  captureTuiSnapshot,
  createTuiState,
  interpretKey,
  approvalArgumentPages,
  reduceTuiState,
  renderTui,
  renderTuiSummary,
  runTui,
  sanitizeTerminalText,
  shouldUseColor,
  type TuiInput,
  type TuiBackend,
  type TuiOutput,
  type TuiSnapshot,
  type TuiSnapshotOptions,
} from '../src/tui/index.js';

const apps = new Set<OpenProjectsApp>();
const SAMPLE_ARGUMENTS_DIGEST = `sha256:${'a'.repeat(64)}`;

afterEach(async () => {
  for (const app of apps) await app.close();
  apps.clear();
});

describe('TUI state and rendering', () => {
  it('renders every workspace with explicit status labels and bounded dimensions', () => {
    const snapshot = sampleSnapshot();
    for (const page of ['overview', 'runs', 'approvals', 'memory', 'projects'] as const) {
      const screen = renderTui(createTuiState(page), snapshot, { columns: 88, rows: 24 }, { color: false });
      expect(screen).not.toContain('\u001b');
      expect(screen.split('\n')).toHaveLength(24);
      expect(screen.toLocaleLowerCase()).toContain(page === 'overview' ? 'mission control' : page);
      expect(Math.max(...screen.split('\n').map((line) => Array.from(line).length))).toBeLessThanOrEqual(88);
    }
    expect(renderTui(createTuiState('runs'), snapshot, { columns: 88, rows: 24 }, { color: false })).toContain('[SUCCESS]');
    expect(renderTui(createTuiState('approvals'), snapshot, { columns: 88, rows: 24 }, { color: false })).toContain('[PENDING]');
  });

  it('never labels an allowlisted or Telegram-enabled posture as sealed local-only', () => {
    const snapshot = sampleSnapshot();
    snapshot.privacy.allowedOrigins = 1;
    expect(renderTuiSummary(snapshot)).toContain('Status: HYBRID');
    const screen = renderTui(createTuiState(), snapshot, { columns: 100, rows: 24 }, { color: false });
    expect(screen).toContain('[HYBRID]');
    expect(screen).toContain('1 external origin');
    expect(screen).not.toContain('SEALED');
  });

  it('supports page navigation, composer editing, and gated approval decisions', () => {
    const snapshot = sampleSnapshot();
    let state = createTuiState();
    const next = interpretKey(state, snapshot, { name: 'tab', sequence: '\t' });
    expect(next).toEqual({ type: 'dispatch', action: { type: 'next_page' } });
    if (next.type === 'dispatch') state = reduceTuiState(state, next.action, snapshot);
    expect(state.page).toBe('runs');

    state = reduceTuiState(state, { type: 'open_composer', projectId: 'project-1' }, snapshot);
    state = reduceTuiState(state, { type: 'composer_insert', text: 'Ship\u001b]52;c;payload\u0007 now' }, snapshot);
    expect(state.composer?.text).not.toMatch(/[\u001b\u0007]/u);
    const typedQ = interpretKey(state, snapshot, { name: 'q', sequence: 'q' });
    expect(typedQ).toEqual({ type: 'dispatch', action: { type: 'composer_insert', text: 'q' } });
    expect(interpretKey(state, snapshot, { name: 'return', sequence: '\r' })).toEqual({ type: 'submit_composer' });

    state = reduceTuiState(createTuiState('approvals'), {
      type: 'request_approval',
      approvalId: 'approval-1',
      decision: 'approve',
    }, snapshot);
    expect(state.confirmation?.argumentsDigest).toBe(SAMPLE_ARGUMENTS_DIGEST);
    expect(interpretKey(state, snapshot, { sequence: 'x' })).toEqual({ type: 'none' });
    expect(interpretKey(state, snapshot, { sequence: 'y' })).toEqual({ type: 'execute_approval' });
    expect(interpretKey({ ...state, busy: true }, snapshot, { sequence: 'q' })).toEqual({ type: 'quit' });

    snapshot.approvalPage.nextCursor = 'opaque-next-page';
    const approvalList = createTuiState('approvals');
    expect(interpretKey(approvalList, snapshot, { sequence: ']' })).toEqual({ type: 'next_approval_page' });
    expect(interpretKey(approvalList, snapshot, { sequence: '[' })).toEqual({
      type: 'dispatch',
      action: { type: 'set_notice', tone: 'info', message: 'Already on the first approval page' },
    });
    const secondPage = reduceTuiState(approvalList, { type: 'set_approval_page', page: 1 }, snapshot);
    expect(interpretKey(secondPage, snapshot, { sequence: '[' })).toEqual({ type: 'previous_approval_page' });
    expect(renderTui(secondPage, snapshot, { columns: 100, rows: 24 }, { color: false }))
      .toContain('page 2');
  });

  it('renders and enforces a read-only service principal without mutation shortcuts', () => {
    const snapshot = sampleSnapshot();
    snapshot.control = {
      authenticated: true,
      principalId: 'auditor',
      capabilities: ['read'],
      workspaceScope: 'scoped',
    };
    const compose = interpretKey(createTuiState(), snapshot, { sequence: 'c' });
    expect(compose).toEqual({
      type: 'dispatch',
      action: { type: 'set_notice', tone: 'danger', message: 'This principal cannot start runs' },
    });
    const approval = interpretKey(createTuiState('approvals'), snapshot, { sequence: 'a' });
    expect(approval).toEqual({
      type: 'dispatch',
      action: { type: 'set_notice', tone: 'danger', message: 'This principal cannot resolve approvals' },
    });
    const screen = renderTui(createTuiState('approvals'), snapshot, { columns: 100, rows: 24 }, { color: false });
    expect(screen).toContain('auditor');
    expect(screen).not.toContain('a approve');
    expect(screen).not.toContain('c compose');
    expect(renderTuiSummary(snapshot)).toContain('Control: auditor; read; scoped workspace scope');
  });

  it('paginates long approval arguments and requires reviewing every page', () => {
    const snapshot = sampleSnapshot();
    const argumentsText = `${'A'.repeat(160)}${'B'.repeat(160)}${'C'.repeat(40)}`;
    snapshot.approvals[0]!.arguments = argumentsText;
    expect(approvalArgumentPages(argumentsText)).toHaveLength(3);
    expect(approvalArgumentPages(argumentsText).join('')).toBe(argumentsText);

    let state = reduceTuiState(createTuiState('approvals'), {
      type: 'request_approval',
      approvalId: 'approval-1',
      decision: 'approve',
    }, snapshot);
    expect(renderTui(state, snapshot, { columns: 88, rows: 24 }, { color: false })).toContain('ARGUMENTS 1/3');
    const firstAttempt = interpretKey(state, snapshot, { sequence: 'y' });
    expect(firstAttempt).toEqual({ type: 'dispatch', action: { type: 'next_confirmation_page' } });
    if (firstAttempt.type === 'dispatch') state = reduceTuiState(state, firstAttempt.action, snapshot);
    expect(renderTui(state, snapshot, { columns: 88, rows: 24 }, { color: false })).toContain('ARGUMENTS 2/3');
    const secondAttempt = interpretKey(state, snapshot, { sequence: 'y' });
    if (secondAttempt.type === 'dispatch') state = reduceTuiState(state, secondAttempt.action, snapshot);
    expect(renderTui(state, snapshot, { columns: 88, rows: 24 }, { color: false })).toContain('ARGUMENTS 3/3');
    expect(interpretKey(state, snapshot, { sequence: 'y' })).toEqual({ type: 'execute_approval' });
  });

  it('shows legacy approvals as rejection-only and never opens an approve confirmation', () => {
    const snapshot = sampleSnapshot();
    delete snapshot.approvals[0]!.argumentsDigest;
    const state = createTuiState('approvals');

    expect(interpretKey(state, snapshot, { sequence: 'a' })).toEqual({
      type: 'dispatch',
      action: {
        type: 'set_notice',
        tone: 'danger',
        message: 'Legacy approval has no bound argument digest and cannot be approved',
      },
    });
    expect(interpretKey(state, snapshot, { sequence: 'x' })).toEqual({
      type: 'dispatch',
      action: { type: 'request_approval', approvalId: 'approval-1', decision: 'reject' },
    });
    const rejecting = reduceTuiState(state, {
      type: 'request_approval',
      approvalId: 'approval-1',
      decision: 'reject',
    }, snapshot);
    expect(renderTui(rejecting, snapshot, { columns: 100, rows: 24 }, { color: false }))
      .toContain('DIGEST LEGACY-UNBOUND — REJECTION ONLY');
  });

  it('never truncates stored approval arguments at the ordinary display-text limit', () => {
    const argumentsText = JSON.stringify({ body: 'x'.repeat(8_000), destination: 'reviewed-channel' });
    const pages = approvalArgumentPages(argumentsText);
    expect(pages.join('')).toBe(argumentsText);
    expect(pages.length).toBeGreaterThan(25);
  });

  it('shows trusted approval context and keeps the worst-case page inside its safe viewport', () => {
    const snapshot = sampleSnapshot();
    snapshot.approvals[0]!.arguments = '界'.repeat(160);
    const state = reduceTuiState(createTuiState('approvals'), {
      type: 'request_approval',
      approvalId: 'approval-1',
      decision: 'approve',
    }, snapshot);
    const screen = renderTui(state, snapshot, { columns: 48, rows: 22 }, { color: false });
    expect(screen.split('\n')).toHaveLength(22);
    expect(screen).toContain('EFFECT EXTERNAL_WRITE');
    expect(screen).toContain('ACTOR local-user');
    expect(screen).toContain('REQUEST Send the reviewed');
    expect(screen).toContain('ARGUMENTS 1/1');
    expect(renderTui(state, snapshot, { columns: 100, rows: 24 }, { color: false }))
      .toContain(SAMPLE_ARGUMENTS_DIGEST);
    expect(screen).toContain('y/Enter confirm');
  });

  it('neutralizes terminal title, clipboard, CSI, C0/C1, and bidi injection', () => {
    const hostile = '\u001b]52;c;c2VjcmV0\u0007\u001b]0;owned\u0007hello\u001b[2J\u009b31m\u202Etxt';
    const sanitized = sanitizeTerminalText(hostile);
    expect(sanitized).not.toMatch(/[\u001b\u0007\u009b\u202e]/u);
    expect(sanitized).not.toMatch(/c2VjcmV0|owned|\[2J|31m/u);
    const snapshot = sampleSnapshot();
    snapshot.runs[0]!.input = hostile;
    snapshot.memories[0]!.content = hostile;
    snapshot.projects[0]!.name = hostile;
    snapshot.approvals[0]!.arguments = hostile;
    for (const page of ['runs', 'approvals', 'memory', 'projects'] as const) {
      const screen = renderTui(createTuiState(page), snapshot, { columns: 100, rows: 24 }, { color: false });
      expect(screen).not.toContain('\u001b');
      expect(screen).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u);
      if (page !== 'approvals') expect(screen).not.toMatch(/c2VjcmV0|owned|\[2J|31m/u);
    }

    let approvalState = reduceTuiState(createTuiState('approvals'), {
      type: 'request_approval',
      approvalId: 'approval-1',
      decision: 'approve',
    }, snapshot);
    const approvalPages: string[] = [];
    for (let index = 0; index < approvalState.confirmation!.pages; index += 1) {
      approvalPages.push(renderTui(approvalState, snapshot, { columns: 100, rows: 24 }, { color: false }));
      approvalState = reduceTuiState(approvalState, { type: 'next_confirmation_page' }, snapshot);
    }
    const visibleApproval = approvalPages.join('\n');
    expect(visibleApproval).toContain('\\u001B');
    expect(visibleApproval).toContain('c2VjcmV0');
    expect(visibleApproval).not.toMatch(/[\u001b\u0007\u009b\u202e]/u);
  });

  it('honors NO_COLOR and emits a control-free noninteractive summary', () => {
    expect(shouldUseColor({ NO_COLOR: '1', TERM: 'xterm-256color' }, true)).toBe(false);
    expect(shouldUseColor({ TERM: 'dumb' }, true)).toBe(false);
    expect(shouldUseColor({ TERM: 'xterm-256color' }, false)).toBe(false);
    const summary = renderTuiSummary(sampleSnapshot());
    expect(summary).toContain('OpenProjects - private project operations');
    expect(summary).toContain('[PENDING]');
    expect(summary).not.toMatch(/[\u001b\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u);
  });
});

describe('TUI integration boundary', () => {
  it('scopes approvals to runs in the active workspace', async () => {
    const app = await testApp();
    createPendingApproval(app, 'local', 'visible-tool');
    createPendingApproval(app, 'other-company', 'secret-tool');

    const local = captureTuiSnapshot(app, 'local');
    expect(local.approvals.map((approval) => approval.toolName)).toEqual(['visible-tool']);
    const other = captureTuiSnapshot(app, 'other-company');
    expect(other.approvals.map((approval) => approval.toolName)).toEqual(['secret-tool']);
  });

  it('keeps an older pending approval visible beyond the recent-runs window', async () => {
    const app = await testApp();
    createPendingApproval(app, 'local', 'older-important-tool');
    for (let index = 0; index < 105; index += 1) createRun(app, 'local', `newer-${index}`);

    const snapshot = captureTuiSnapshot(app, 'local');
    expect(snapshot.runs).toHaveLength(100);
    expect(snapshot.approvals.map((approval) => approval.toolName)).toContain('older-important-tool');
  });

  it('returns bounded approval pages with an opaque continuation cursor', async () => {
    const app = await testApp();
    for (let index = 0; index < 101; index += 1) {
      createPendingApproval(app, 'local', `pending-${index}`);
    }
    createPendingApproval(app, 'other-company', 'tenant-secret');

    const first = captureTuiSnapshot(app, 'local', { approvalLimit: 100 });
    expect(first.approvals).toHaveLength(100);
    expect(first.approvals.some((approval) => approval.toolName === 'tenant-secret')).toBe(false);
    expect(first.approvalPage.nextCursor).toBeTruthy();

    const second = captureTuiSnapshot(app, 'local', {
      approvalLimit: 100,
      approvalCursor: first.approvalPage.nextCursor!,
    });
    expect(second.approvals).toHaveLength(1);
    expect(second.approvalPage.nextCursor).toBeUndefined();
    expect(new Set([...first.approvals, ...second.approvals].map((approval) => approval.id)).size).toBe(101);
  });

  it('prints plain output without taking terminal control when noninteractive', async () => {
    const app = await testApp();
    const input = new PassThrough() as TuiInput;
    const output = new PassThrough() as TuiOutput;
    input.isTTY = false;
    output.isTTY = false;
    let rendered = '';
    output.on('data', (chunk: Buffer) => { rendered += chunk.toString(); });
    await runTui(app, { input, output, environment: { TERM: 'xterm-256color' } });
    expect(rendered).toContain('OpenProjects - private project operations');
    expect(rendered).not.toContain('\u001b');
  });

  it('supports an explicit plain screen-reader summary even on a TTY', async () => {
    const app = await testApp();
    const input = new PassThrough() as TuiInput;
    const output = new PassThrough() as TuiOutput;
    input.isTTY = true;
    output.isTTY = true;
    let rendered = '';
    output.on('data', (chunk: Buffer) => { rendered += chunk.toString(); });
    await runTui(app, { input, output, plain: true, environment: { TERM: 'xterm-256color' } });
    expect(rendered).toContain('OpenProjects - private project operations');
    expect(rendered).not.toContain('\u001b');
  });

  it('restores raw mode, cursor, and the alternate screen on quit', async () => {
    const app = await testApp();
    const input = new PassThrough() as TuiInput;
    const output = new PassThrough() as TuiOutput;
    const rawModes: boolean[] = [];
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = function setRawMode(mode: boolean): TuiInput {
      rawModes.push(mode);
      this.isRaw = mode;
      return this;
    };
    output.isTTY = true;
    output.columns = 90;
    output.rows = 24;
    let rendered = '';
    output.on('data', (chunk: Buffer) => { rendered += chunk.toString(); });

    const running = runTui(app, { input, output, environment: { TERM: 'xterm-256color', NO_COLOR: '1' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.emit('keypress', 'q', { name: 'q', sequence: 'q' });
    await running;

    expect(rawModes).toEqual([true, false]);
    expect(rendered).toContain('\u001b[?1049h');
    expect(rendered).toContain('\u001b[?25l');
    expect(rendered).toContain('\u001b[?25h');
    expect(rendered).toContain('\u001b[?1049l');
  });

  it('loads forward and backward approval pages instead of hiding the queue tail', async () => {
    const first = sampleSnapshot();
    first.approvalPage.nextCursor = 'opaque-page-2';
    const second = sampleSnapshot();
    second.approvals[0]!.id = 'approval-page-2';
    second.approvals[0]!.toolName = 'page-two-tool';
    second.approvalPage = { limit: 100 };
    const cursors: Array<string | undefined> = [];
    const backend: TuiBackend = {
      async snapshot(_workspaceId: string, options: TuiSnapshotOptions = {}) {
        cursors.push(options.approvalCursor);
        return options.approvalCursor ? second : first;
      },
      async startRun() { throw new Error('not used'); },
      async resolveApproval() { throw new Error('not used'); },
      subscribe() { return () => undefined; },
    };
    const input = new PassThrough() as TuiInput;
    const output = new PassThrough() as TuiOutput;
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = function setRawMode(mode: boolean): TuiInput {
      this.isRaw = mode;
      return this;
    };
    output.isTTY = true;
    output.columns = 100;
    output.rows = 24;

    const running = runTui(backend, { input, output, environment: { TERM: 'xterm-256color', NO_COLOR: '1' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.emit('keypress', '3', { name: '3', sequence: '3' });
    input.emit('keypress', ']', { name: ']', sequence: ']' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.emit('keypress', '[', { name: '[', sequence: '[' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.emit('keypress', 'q', { name: 'q', sequence: 'q' });
    await running;

    expect(cursors).toEqual([undefined, 'opaque-page-2', undefined]);
  });

  it('removes listeners and attempts every restoration step when TTY initialization throws', async () => {
    const app = await testApp();
    const input = new PassThrough() as TuiInput;
    const output = new PassThrough() as TuiOutput;
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = () => { throw new Error('raw mode unavailable'); };
    output.isTTY = true;
    output.columns = 90;
    output.rows = 24;
    let rendered = '';
    output.on('data', (chunk: Buffer) => { rendered += chunk.toString(); });
    const sigintListeners = process.listenerCount('SIGINT');
    const sigtermListeners = process.listenerCount('SIGTERM');
    const sigbreakListeners = process.platform === 'win32' ? process.listenerCount('SIGBREAK') : undefined;

    await expect(runTui(app, { input, output, environment: { TERM: 'xterm-256color' } }))
      .rejects.toThrow('raw mode unavailable');

    expect(input.listenerCount('keypress')).toBe(0);
    expect(output.listenerCount('resize')).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
    if (sigbreakListeners !== undefined) expect(process.listenerCount('SIGBREAK')).toBe(sigbreakListeners);
    expect(rendered).toContain('\u001b[?1049l');
  });
});

function sampleSnapshot(): TuiSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    workspaceId: 'local',
    agent: { name: 'Project colleague', version: '1.0.0' },
    model: { provider: 'ollama', name: 'qwen3.5:4b', routeCount: 2 },
    privacy: { localOnly: true, allowedOrigins: 0, telegramEnabled: false },
    services: { embeddings: 'qwen-embed-local', transcription: 'whisper.cpp' },
    runs: [{
      id: 'run-12345678',
      sessionId: 'session-1',
      workspaceId: 'local',
      actorId: 'local-user',
      projectId: 'project-1',
      agentId: 'agent-1',
      agentVersion: '1.0.0',
      status: 'succeeded',
      input: 'Summarize launch blockers',
      output: 'Done',
      step: 2,
      toolCalls: 3,
      activeMs: 120,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    }],
    approvals: [{
      id: 'approval-1',
      invocationId: 'invocation-1',
      runId: 'run-12345678',
      toolName: 'notify.send',
      arguments: '{"channel":"launch"}',
      argumentsDigest: SAMPLE_ARGUMENTS_DIGEST,
      status: 'pending',
      requestedAt: new Date().toISOString(),
      effect: 'external_write',
      policyDecision: 'ask',
      actorId: 'local-user',
      projectId: 'project-1',
      runInput: 'Send the reviewed launch follow-up',
    }],
    approvalPage: { limit: 100 },
    memories: [{
      id: 'memory-1',
      workspaceId: 'local',
      projectId: 'project-1',
      kind: 'semantic',
      content: 'The demo date is fixed.',
      importance: 0.9,
      strength: 0.8,
      reward: 0.2,
      accessCount: 3,
      sourceType: 'reviewed',
      sourceId: 'source-1',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
    projects: [{
      id: 'project-1',
      workspaceId: 'local',
      name: 'Atlas launch',
      status: 'at_risk',
      summary: 'Analytics launch for the August demo.',
      owner: 'Maya',
      dueAt: '2026-08-28T10:00:00.000Z',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [{
        id: 'task-1',
        workspaceId: 'local',
        projectId: 'project-1',
        title: 'Provision credentials',
        status: 'blocked',
        priority: 'critical',
        assignee: 'Nadia',
        dueAt: '2026-08-26T10:00:00.000Z',
        blockedReason: 'Security review',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    }],
  };
}

async function testApp(): Promise<OpenProjectsApp> {
  const app = await createApp({
    config: testConfig(),
    databasePath: ':memory:',
    skills: [],
    seedDemo: true,
  });
  apps.add(app);
  return app;
}

function testConfig(): AppConfig {
  return {
    version: 1,
    agent: {
      id: 'tui-test',
      version: '1.0.0',
      name: 'TUI test agent',
      system: 'Test.',
      skills: [],
      tools: [],
      budgets: {
        maxSteps: 2,
        maxToolCalls: 2,
        maxWallTimeMs: 10_000,
        maxInputTokens: 2_000,
        reservedOutputTokens: 100,
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
    server: { host: '127.0.0.1', port: 4310 },
    storage: { database: ':memory:' },
    model: { provider: 'mock', model: 'project-ops-v1' },
    memory: { retrievalLimit: 4, maxContextCharacters: 4_000 },
  };
}

function createPendingApproval(app: OpenProjectsApp, workspaceId: string, toolName: string): void {
  const session = app.storage.createSession({
    workspaceId,
    actorId: 'local-user',
    channel: 'test',
  });
  const run = app.storage.createRun({
    sessionId: session.id,
    workspaceId,
    actorId: 'local-user',
    agentId: 'tui-test',
    agentVersion: '1.0.0',
    input: 'test',
  });
  const batch = app.storage.createToolBatch(run.id, 1);
  const canonicalArguments = canonicalizeToolArguments({});
  const invocation = app.storage.createToolInvocation({
    batchId: batch.id,
    runId: run.id,
    callId: `call-${workspaceId}-${toolName}`,
    callIndex: 0,
    toolName,
    arguments: canonicalArguments.arguments,
    argumentsDigest: canonicalArguments.argumentsDigest,
    effect: 'external_write',
    policyDecision: 'ask',
    status: 'pending_approval',
    idempotencyKey: `idempotency-${workspaceId}-${toolName}`,
  });
  app.storage.createApproval(invocation);
}

function createRun(app: OpenProjectsApp, workspaceId: string, input: string): void {
  const session = app.storage.createSession({
    workspaceId,
    actorId: 'local-user',
    channel: 'test',
  });
  app.storage.createRun({
    sessionId: session.id,
    workspaceId,
    actorId: 'local-user',
    agentId: 'tui-test',
    agentVersion: '1.0.0',
    input,
  });
}

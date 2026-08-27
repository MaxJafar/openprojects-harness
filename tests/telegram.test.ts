import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp, type OpenProjectsApp } from '../src/app.js';
import type {
  AppConfig,
  JsonObject,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
} from '../src/core/types.js';
import { modelPlugin } from '../src/plugins/builtin.js';
import { captureRunSnapshots } from '../src/runtime/run-snapshots.js';
import { canonicalizeToolArguments } from '../src/runtime/tool-arguments.js';
import { startServer } from '../src/server.js';
import { TelegramAdapter, type TelegramUpdate } from '../src/telegram.js';

const ORIGINAL_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ORIGINAL_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const ORIGINAL_USERNAME = process.env.TELEGRAM_BOT_USERNAME;
const ORIGINAL_ALLOWED_USERS = process.env.TELEGRAM_ALLOWED_USER_IDS;
const ORIGINAL_API_BASE_URL = process.env.TELEGRAM_API_BASE_URL;
const GROUP_ID = '-1000123';
const ADMIN_ID = 100;

const openApps = new Set<OpenProjectsApp>();

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = '123456:telegram-test-token';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'telegram-test-secret';
  process.env.TELEGRAM_BOT_USERNAME = 'openprojects_bot';
  process.env.TELEGRAM_ALLOWED_USER_IDS = String(ADMIN_ID);
  delete process.env.TELEGRAM_API_BASE_URL;
});

afterEach(async () => {
  for (const app of openApps) await app.close();
  openApps.clear();
  restoreEnvironment('TELEGRAM_BOT_TOKEN', ORIGINAL_TOKEN);
  restoreEnvironment('TELEGRAM_WEBHOOK_SECRET', ORIGINAL_SECRET);
  restoreEnvironment('TELEGRAM_BOT_USERNAME', ORIGINAL_USERNAME);
  restoreEnvironment('TELEGRAM_ALLOWED_USER_IDS', ORIGINAL_ALLOWED_USERS);
  restoreEnvironment('TELEGRAM_API_BASE_URL', ORIGINAL_API_BASE_URL);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface TelegramApiCall {
  method: string;
  body: Record<string, unknown>;
}

class CountingTelegramModel implements ModelAdapter {
  readonly id = 'mock';
  readonly requests: ModelRequest[] = [];

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      message: {
        role: 'assistant',
        content: `Handled Telegram run ${request.runId}.`,
      },
      model: 'telegram-test-model',
    };
  }
}

describe('TelegramAdapter group privacy and consent', () => {
  it('authenticates the fixed webhook route with the header secret only', async () => {
    const { telegram } = await createTelegramApp();
    expect(telegram.authenticates('telegram-test-secret')).toBe(true);
    expect(telegram.authenticates('wrong-secret')).toBe(false);
    expect(telegram.authenticates(undefined)).toBe(false);
  });

  it('accepts only the fixed header-authenticated webhook endpoint', async () => {
    const { app } = await createTelegramApp();
    app.config.server.port = 0;
    const started = await startServer(app);
    try {
      const request = (path: string, secret?: string) => fetch(`${started.url}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}),
        },
        body: JSON.stringify({ update_id: 991 }),
      });
      expect((await request('/webhooks/telegram/telegram-test-secret', 'telegram-test-secret')).status).toBe(404);
      expect((await request('/webhooks/telegram')).status).toBe(404);
      expect((await request('/webhooks/telegram', 'telegram-test-secret')).status).toBe(202);
    } finally {
      await started.close();
    }
  });

  it('stores no unconsented body, starts no run, and lets an administrator create a sanitized binding', async () => {
    const apiCalls = installTelegramFetch();
    const { app, model, telegram } = await createTelegramApp();
    const unconsentedBody = 'UNCONSENTED_PRIVATE_MESSAGE_BODY';

    await telegram.handle(groupMessage({
      updateId: 1,
      messageId: 11,
      fromId: 200,
      text: unconsentedBody,
    }));

    expect(app.storage.findGroupSpace('telegram', GROUP_ID)).toBeUndefined();
    expect(groupMessageCount(app)).toBe(0);
    expect(groupObservationMemories(app)).toEqual([]);
    expect(app.storage.listRuns('local')).toEqual([]);
    expect(model.requests).toEqual([]);
    expect(JSON.stringify(inboundPayload(app, 1))).not.toContain(unconsentedBody);

    const enableText = '/openprojects_enable project-atlas';
    await telegram.handle(groupMessage({
      updateId: 2,
      messageId: 12,
      fromId: ADMIN_ID,
      text: enableText,
    }));

    expect(app.storage.findGroupSpace('telegram', GROUP_ID)).toMatchObject({
      workspaceId: 'local',
      externalId: GROUP_ID,
      projectId: 'project-atlas',
      learningEnabled: true,
      notificationsEnabled: true,
      createdBy: `telegram-user:${ADMIN_ID}`,
    });
    expect(inboundPayload(app, 2)).toEqual({
      updateId: 2,
      messageId: 12,
      chatId: GROUP_ID,
      chatType: 'supergroup',
      fromId: String(ADMIN_ID),
      content: 'text',
    });
    expect(JSON.stringify(inboundPayload(app, 2))).not.toContain(enableText);
    expect(app.storage.listRuns('local')).toEqual([]);
    expect(model.requests).toEqual([]);
    expect(apiCalls.map((call) => call.method)).toEqual(['getChatMember', 'sendMessage']);
  });

  it('turns a salient passive message into redacted proposed memory without a model run', async () => {
    const apiCalls = installTelegramFetch();
    const { app, model, telegram } = await createTelegramApp();
    await enableGroup(telegram);
    const callsAfterEnable = apiCalls.length;
    const secret = 'hunterhunter';

    await telegram.handle(groupMessage({
      updateId: 11,
      messageId: 21,
      fromId: 200,
      text: `Important: we will deliver Atlas by 2026-09-01. password=${secret}`,
    }));

    const binding = app.storage.findGroupSpace('telegram', GROUP_ID);
    if (!binding) throw new Error('Expected enabled group binding');
    expect(app.storage.listGroupMessages(binding.id)).toEqual([
      expect.objectContaining({
        externalMessageId: '21',
        actorId: 'telegram-user:200',
        salient: true,
        text: expect.stringContaining('password=[REDACTED:SECRET]'),
      }),
    ]);
    const memories = groupObservationMemories(app);
    expect(memories).toEqual([
      expect.objectContaining({
        workspaceId: 'local',
        projectId: 'project-atlas',
        status: 'proposed',
        sourceType: 'group_observation',
        content: expect.stringContaining('[REDACTED:SECRET]'),
      }),
    ]);
    expect(memories[0]?.content).not.toContain(secret);
    expect(JSON.stringify(inboundPayload(app, 11))).not.toContain(secret);
    expect(app.storage.listRuns('local')).toEqual([]);
    expect(model.requests).toEqual([]);
    expect(apiCalls).toHaveLength(callsAfterEnable);
  });
});

describe('TelegramAdapter operator allowlist', () => {
  it('fails closed when no operator IDs are configured', async () => {
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    const apiCalls = installTelegramFetch();
    const { app, model, telegram } = await createTelegramApp();

    await telegram.handle(directMessage({
      updateId: 30,
      messageId: 40,
      fromId: ADMIN_ID,
      text: 'This DM must remain disabled.',
    }));
    await telegram.handle(groupMessage({
      updateId: 31,
      messageId: 41,
      fromId: ADMIN_ID,
      text: '/openprojects_enable project-atlas',
    }));

    expect(app.storage.listRuns('local')).toEqual([]);
    expect(app.storage.findGroupSpace('telegram', GROUP_ID)).toBeUndefined();
    expect(model.requests).toEqual([]);
    expect(apiCalls).toEqual([]);
  });

  it('denies an arbitrary-user DM without inference and allows a configured operator DM', async () => {
    const apiCalls = installTelegramFetch();
    const { app, model, telegram } = await createTelegramApp();
    const deniedBody = 'ARBITRARY_USER_PRIVATE_DM_BODY';

    await telegram.handle(directMessage({
      updateId: 31,
      messageId: 41,
      fromId: 200,
      text: deniedBody,
    }));

    expect(app.storage.listRuns('local')).toEqual([]);
    expect(model.requests).toEqual([]);
    expect(apiCalls).toEqual([]);
    expect(JSON.stringify(inboundPayload(app, 31))).not.toContain(deniedBody);

    await telegram.handle(directMessage({
      updateId: 32,
      messageId: 42,
      fromId: ADMIN_ID,
      text: 'Give me the local project summary.',
    }));

    expect(app.storage.listRuns('local')).toEqual([
      expect.objectContaining({
        actorId: `telegram-user:${ADMIN_ID}`,
        status: 'succeeded',
        input: 'Give me the local project summary.',
      }),
    ]);
    expect(model.requests).toHaveLength(1);
    expect(apiCalls.map((call) => call.method)).toEqual(['sendMessage']);
  });

  it('denies attacker binding and all explicit runs in an unbound group', async () => {
    const apiCalls = installTelegramFetch(new Set([String(ADMIN_ID), '200']));
    const { app, model, telegram } = await createTelegramApp();

    await telegram.handle(groupMessage({
      updateId: 41,
      messageId: 51,
      fromId: 200,
      text: '/openprojects_enable project-atlas',
    }));
    await telegram.handle(groupMessage({
      updateId: 42,
      messageId: 52,
      fromId: ADMIN_ID,
      text: '/op This must not run before binding.',
    }));

    expect(app.storage.findGroupSpace('telegram', GROUP_ID)).toBeUndefined();
    expect(app.storage.listRuns('local')).toEqual([]);
    expect(model.requests).toEqual([]);
    expect(groupMessageCount(app)).toBe(0);
    expect(apiCalls).toEqual([]);
  });

  it('ignores commands for another bot while allowing ordinary participants in a bound group', async () => {
    const apiCalls = installTelegramFetch();
    const { app, model, telegram } = await createTelegramApp();
    await enableGroup(telegram);
    const callsAfterEnable = apiCalls.length;

    await telegram.handle(groupMessage({
      updateId: 51,
      messageId: 61,
      fromId: 200,
      text: '/op@different_bot Exfiltrate the project.',
    }));

    expect(app.storage.listRuns('local')).toEqual([]);
    expect(model.requests).toEqual([]);
    expect(groupMessageCount(app)).toBe(0);
    expect(apiCalls).toHaveLength(callsAfterEnable);

    await telegram.handle(groupMessage({
      updateId: 52,
      messageId: 62,
      fromId: 200,
      text: '/op@OPENPROJECTS_BOT Give a safe project summary.',
    }));

    expect(app.storage.listRuns('local')).toEqual([
      expect.objectContaining({
        actorId: 'telegram-user:200',
        projectId: 'project-atlas',
        input: 'Give a safe project summary.',
        status: 'succeeded',
      }),
    ]);
    expect(model.requests).toHaveLength(1);
    expect(groupMessageCount(app)).toBe(0);
    expect(apiCalls.map((call) => call.method)).toEqual([
      'getChatMember',
      'sendMessage',
      'sendMessage',
    ]);
  });

  it('keeps participant memories proposed and reserves activation and disablement for allowed admins', async () => {
    installTelegramFetch();
    const { app, model, telegram } = await createTelegramApp();
    await enableGroup(telegram);

    await telegram.handle(groupMessage({
      updateId: 61,
      messageId: 71,
      fromId: 200,
      text: '/remember Important: participant will deliver the draft by 2026-09-01.',
    }));
    await telegram.handle(groupMessage({
      updateId: 62,
      messageId: 72,
      fromId: ADMIN_ID,
      text: '/remember Important: operator will deliver the review by 2026-09-02.',
    }));

    const participantMemory = groupObservationMemories(app)
      .find((memory) => memory.content.includes('participant'));
    const operatorMemory = groupObservationMemories(app)
      .find((memory) => memory.content.includes('operator'));
    expect(participantMemory?.status).toBe('proposed');
    expect(operatorMemory?.status).toBe('active');
    expect(model.requests).toEqual([]);

    await telegram.handle(groupMessage({
      updateId: 63,
      messageId: 73,
      fromId: 200,
      text: '/openprojects_disable',
    }));
    expect(app.storage.findGroupSpace('telegram', GROUP_ID)?.learningEnabled).toBe(true);

    await telegram.handle(groupMessage({
      updateId: 64,
      messageId: 74,
      fromId: ADMIN_ID,
      text: '/openprojects_disable',
    }));
    expect(app.storage.findGroupSpace('telegram', GROUP_ID)).toMatchObject({
      learningEnabled: false,
      notificationsEnabled: false,
    });
  });

  it('keeps approval authority from participants and grants it only to an allowed group admin', async () => {
    const apiCalls = installTelegramFetch();
    const { app, telegram } = await createTelegramApp();
    await enableGroup(telegram);
    const approvalId = createPendingTelegramApproval(app, 'telegram-user:200');
    const callbackData = await renderPendingApproval(telegram, app, approvalId, apiCalls, 'Approve once');
    const approvalMessage = [...apiCalls].reverse().find((call) => call.method === 'sendMessage')!;
    expect(String(approvalMessage.body.text)).toContain(app.storage.getApproval(approvalId).arguments);
    expect(String(approvalMessage.body.text)).toContain(app.storage.getApproval(approvalId).argumentsDigest!);
    expect(Buffer.byteLength(callbackData, 'utf8')).toBeLessThanOrEqual(64);

    await telegram.handle(approvalCallback(70, callbackData, 200));
    expect(app.storage.getApproval(approvalId).status).toBe('pending');

    const staleData = `${callbackData.slice(0, -1)}${callbackData.endsWith('A') ? 'B' : 'A'}`;
    await telegram.handle(approvalCallback(71, staleData, ADMIN_ID));
    expect(app.storage.getApproval(approvalId).status).toBe('pending');

    const rejectData = await renderPendingApproval(telegram, app, approvalId, apiCalls, 'Reject');
    await telegram.handle(approvalCallback(72, rejectData, ADMIN_ID));
    expect(app.storage.getApproval(approvalId)).toMatchObject({
      status: 'rejected',
      resolvedBy: `telegram-user:${ADMIN_ID}`,
    });
    expect(app.storage.getRun(app.storage.getApproval(approvalId).runId).status).toBe('succeeded');
  });

  it('never truncates an oversized approval into an actionable Telegram review', async () => {
    const apiCalls = installTelegramFetch();
    const { app, telegram } = await createTelegramApp();
    const hiddenTail = 'HIDDEN-DESTINATION-AT-END';
    const approvalId = createPendingTelegramApproval(
      app,
      `telegram-user:${ADMIN_ID}`,
      JSON.stringify({ body: 'x'.repeat(8_000), destination: hiddenTail }),
    );

    await renderPendingApprovalMessage(telegram, app, approvalId);
    const message = [...apiCalls].reverse().find((call) => call.method === 'sendMessage')!;
    const text = String(message.body.text);
    expect(text.length).toBeLessThanOrEqual(4_096);
    expect(text).toContain(app.storage.getApproval(approvalId).argumentsDigest!);
    expect(text).toContain('No Approve action is available here');
    expect(text).not.toContain(hiddenTail);
    expect(message.body.reply_markup).toBeUndefined();
    expect(app.storage.getApproval(approvalId).status).toBe('pending');
  });

  it('renders a legacy approval as rejection-only and never recovers it into execution', async () => {
    const apiCalls = installTelegramFetch();
    const { app, telegram } = await createTelegramApp();
    await enableGroup(telegram);
    const approvalId = createPendingTelegramApproval(
      app,
      `telegram-user:${ADMIN_ID}`,
      JSON.stringify({ destination: 'legacy.example.test' }),
      false,
    );

    const rejectData = await renderPendingApproval(telegram, app, approvalId, apiCalls, 'Reject');
    const message = [...apiCalls].reverse().find((call) => call.method === 'sendMessage')!;
    const markup = message.body.reply_markup as {
      inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
    };
    expect(String(message.body.text)).toContain('has no bound argument digest');
    expect(markup.inline_keyboard?.flat().map((button) => button.text)).toEqual(['Reject']);

    const forgedApprove = rejectData.replace('ap:n:', 'ap:y:');
    await telegram.handle(approvalCallback(73, forgedApprove, ADMIN_ID));
    expect(app.storage.getApproval(approvalId).status).toBe('pending');

    await telegram.handle(approvalCallback(74, rejectData, ADMIN_ID));
    expect(app.storage.getApproval(approvalId).status).toBe('rejected');
    expect(app.storage.outboxCount()).toBe(0);
  });
});

describe('TelegramAdapter run identity and deduplication', () => {
  it('isolates group sessions per user, reuses each user session, and ignores duplicate updates', async () => {
    installTelegramFetch();
    const { app, model, telegram } = await createTelegramApp();
    await enableGroup(telegram);
    const firstUserUpdate = groupMessage({
      updateId: 21,
      messageId: 31,
      fromId: 200,
      text: '/op Assess Atlas risk.',
    });

    await telegram.handle(firstUserUpdate);
    await telegram.handle(firstUserUpdate);
    await telegram.handle(groupMessage({
      updateId: 22,
      messageId: 32,
      fromId: 200,
      text: '/op Assess Atlas risk again.',
    }));
    await telegram.handle(groupMessage({
      updateId: 23,
      messageId: 33,
      fromId: 201,
      text: '/op Assess Atlas delivery.',
    }));

    const runs = app.storage.listRuns('local', 20);
    const user200 = runs.filter((run) => run.actorId === 'telegram-user:200');
    const user201 = runs.filter((run) => run.actorId === 'telegram-user:201');
    expect(runs).toHaveLength(3);
    expect(user200).toHaveLength(2);
    expect(user201).toHaveLength(1);
    expect(new Set(user200.map((run) => run.sessionId)).size).toBe(1);
    expect(user201[0]?.sessionId).not.toBe(user200[0]?.sessionId);
    expect(app.storage.findSessionByExternal('telegram', `${GROUP_ID}:200`)).toMatchObject({
      actorId: 'telegram-user:200',
      id: user200[0]?.sessionId,
    });
    expect(app.storage.findSessionByExternal('telegram', `${GROUP_ID}:201`)).toMatchObject({
      actorId: 'telegram-user:201',
      id: user201[0]?.sessionId,
    });
    expect(model.requests).toHaveLength(3);
    expect(new Set(model.requests.map((request) => request.runId))).toEqual(new Set(runs.map((run) => run.id)));

    const binding = app.storage.findGroupSpace('telegram', GROUP_ID);
    if (!binding) throw new Error('Expected enabled group binding');
    expect(app.storage.listGroupMessages(binding.id)).toHaveLength(0);
    expect(inboundEventCount(app)).toBe(4);
    expect(inboundRunCount(app)).toBe(3);
  });
});

async function createTelegramApp(): Promise<{
  app: OpenProjectsApp;
  model: CountingTelegramModel;
  telegram: TelegramAdapter;
}> {
  const app = await createApp({
    config: telegramConfig(),
    databasePath: ':memory:',
    skills: [],
    seedDemo: true,
  });
  openApps.add(app);
  const model = new CountingTelegramModel();
  await app.kernel.unmount('model:mock');
  await app.kernel.mount(modelPlugin(model));
  return { app, model, telegram: new TelegramAdapter(app) };
}

function telegramConfig(): AppConfig {
  return {
    version: 1,
    agent: {
      id: 'telegram-test-agent',
      version: '1.0.0',
      name: 'Telegram Test Agent',
      system: 'Reply concisely to explicit Telegram requests.',
      skills: [],
      tools: [],
      budgets: {
        maxSteps: 4,
        maxToolCalls: 4,
        maxWallTimeMs: 30_000,
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
    server: { host: '127.0.0.1', port: 4310 },
    storage: { database: ':memory:' },
    model: { provider: 'mock', model: 'telegram-test-model' },
    privacy: { localOnly: true, allowedOrigins: ['https://api.telegram.org'] },
    telegram: { enabled: true, apiBaseUrl: 'https://api.telegram.org' },
    memory: { retrievalLimit: 4, maxContextCharacters: 4_000 },
    learning: {
      enabled: true,
      groupObservation: true,
      minimumSalience: 0.55,
      feedbackLearningRate: 0.2,
      retentionDays: 180,
    },
    embeddings: {
      provider: 'builtin',
      model: 'builtin-hash-v1',
      dimensions: 64,
      timeoutMs: 30_000,
    },
    transcription: {
      provider: 'disabled',
      command: 'whisper-cli',
      ffmpegCommand: 'ffmpeg',
      timeoutMs: 30_000,
      maxBytes: 25_000_000,
      maxDurationSeconds: 1_200,
    },
  };
}

function installTelegramFetch(administrators = new Set([String(ADMIN_ID)])): TelegramApiCall[] {
  const calls: TelegramApiCall[] = [];
  const mockedFetch = vi.fn(async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawUrl = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    const method = new URL(rawUrl).pathname.split('/').at(-1) ?? '';
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : {};
    calls.push({ method, body });

    let result: Record<string, unknown> = {};
    if (method === 'getChatMember') {
      result = {
        status: administrators.has(String(body.user_id)) ? 'administrator' : 'member',
      };
    } else if (method === 'sendMessage') {
      result = { message_id: calls.length };
    } else if (method === 'getMe') {
      result = { id: 999, username: 'openprojects_bot' };
    }
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', mockedFetch);
  return calls;
}

async function enableGroup(telegram: TelegramAdapter): Promise<void> {
  await telegram.handle(groupMessage({
    updateId: 10,
    messageId: 20,
    fromId: ADMIN_ID,
    text: '/openprojects_enable project-atlas',
  }));
}

function groupMessage(input: {
  updateId: number;
  messageId: number;
  fromId: number;
  text: string;
}): TelegramUpdate {
  return {
    update_id: input.updateId,
    message: {
      message_id: input.messageId,
      date: 1_787_645_600,
      text: input.text,
      chat: {
        id: GROUP_ID,
        type: 'supergroup',
        title: 'Project Atlas',
      },
      from: {
        id: input.fromId,
        is_bot: false,
        username: `user_${input.fromId}`,
      },
    },
  };
}

function directMessage(input: {
  updateId: number;
  messageId: number;
  fromId: number;
  text: string;
}): TelegramUpdate {
  return {
    update_id: input.updateId,
    message: {
      message_id: input.messageId,
      date: 1_787_645_600,
      text: input.text,
      chat: {
        id: input.fromId,
        type: 'private',
      },
      from: {
        id: input.fromId,
        is_bot: false,
        username: `user_${input.fromId}`,
      },
    },
  };
}

function approvalCallback(updateId: number, data: string, fromId: number): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      data,
      from: { id: fromId, is_bot: false },
      message: {
        chat: { id: GROUP_ID, type: 'supergroup', title: 'Project Atlas' },
      },
    },
  };
}

function createPendingTelegramApproval(
  app: OpenProjectsApp,
  actorId: string,
  argumentsJson = JSON.stringify({ destination: 'example.test' }),
  bindArguments = true,
): string {
  const session = app.storage.createSession({ workspaceId: 'local', actorId, channel: 'telegram' });
  const agent = { ...app.config.agent, system: app.config.agent.system ?? '' };
  const run = app.storage.createRun({
    sessionId: session.id,
    workspaceId: 'local',
    actorId,
    projectId: 'project-atlas',
    agentId: agent.id,
    agentVersion: agent.version,
    input: 'Participant requested a consequential action',
    snapshots: captureRunSnapshots({
      agent,
      runtimeProfile: { task: 'supervisor', retrieveMemory: true, maxModelAttempts: 2 },
      skills: app.skills,
      tools: agent.tools.map((name) => {
        const tool = app.kernel.tool(name);
        if (!tool) throw new Error(`Missing test tool: ${name}`);
        return tool;
      }),
      policy: app.config.policy,
      policyGuards: app.kernel.listToolGuardPlugins(),
    }),
  });
  app.storage.transitionRun(run.id, ['queued'], 'running');
  const batch = app.storage.createToolBatch(run.id, 1);
  const canonicalArguments = canonicalizeToolArguments(JSON.parse(argumentsJson) as JsonObject);
  const invocation = app.storage.createToolInvocation({
    batchId: batch.id,
    runId: run.id,
    callId: 'telegram-approval-call',
    callIndex: 0,
    toolName: 'send_followup',
    arguments: canonicalArguments.arguments,
    ...(bindArguments ? { argumentsDigest: canonicalArguments.argumentsDigest } : {}),
    effect: 'external_write',
    policyDecision: 'ask',
    status: 'pending_approval',
    idempotencyKey: `${run.id}:telegram-approval-call`,
  });
  const approval = app.storage.createApproval(invocation);
  app.storage.transitionRun(run.id, ['running'], 'waiting_for_approval');
  return approval.id;
}

async function renderPendingApproval(
  telegram: TelegramAdapter,
  app: OpenProjectsApp,
  approvalId: string,
  calls: TelegramApiCall[],
  buttonText: string,
): Promise<string> {
  await renderPendingApprovalMessage(telegram, app, approvalId);
  const message = [...calls].reverse().find((call) => call.method === 'sendMessage');
  const markup = message?.body.reply_markup as {
    inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>>;
  } | undefined;
  const button = markup?.inline_keyboard?.flat().find((item) => item.text === buttonText);
  if (!button?.callback_data) throw new Error(`Missing Telegram ${buttonText} callback`);
  return button.callback_data;
}

async function renderPendingApprovalMessage(
  telegram: TelegramAdapter,
  app: OpenProjectsApp,
  approvalId: string,
): Promise<void> {
  const runId = app.storage.getApproval(approvalId).runId;
  await (telegram as unknown as { sendOutcome(chatId: string, runId: string): Promise<void> })
    .sendOutcome(GROUP_ID, runId);
}

function inboundPayload(app: OpenProjectsApp, updateId: number): Record<string, unknown> {
  const row = app.storage.db.prepare(`SELECT payload_json FROM inbound_events
    WHERE source = 'telegram' AND dedupe_key = ?`).get(String(updateId)) as Record<string, unknown> | undefined;
  if (!row || typeof row.payload_json !== 'string') throw new Error(`Missing inbound update ${updateId}`);
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

function groupMessageCount(app: OpenProjectsApp): number {
  return numericCount(app, 'SELECT COUNT(*) AS count FROM group_messages');
}

function inboundEventCount(app: OpenProjectsApp): number {
  return numericCount(app, "SELECT COUNT(*) AS count FROM inbound_events WHERE source = 'telegram'");
}

function inboundRunCount(app: OpenProjectsApp): number {
  return numericCount(app, "SELECT COUNT(*) AS count FROM inbound_events WHERE source = 'telegram' AND run_id IS NOT NULL");
}

function numericCount(app: OpenProjectsApp, sql: string): number {
  const row = app.storage.db.prepare(sql).get() as Record<string, unknown>;
  if (typeof row.count !== 'number') throw new Error('Expected a numeric count');
  return row.count;
}

function groupObservationMemories(app: OpenProjectsApp) {
  return app.storage.listMemories('local', 'project-atlas', 100)
    .filter((memory) => memory.sourceType === 'group_observation');
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

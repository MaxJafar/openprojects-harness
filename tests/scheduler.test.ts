import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DeadlineScheduler } from '../src/runtime/scheduler.js';
import { SqliteStorage } from '../src/storage/sqlite.js';

const AS_OF = '2026-08-25T08:00:00.000Z';
const DUE_AT = '2026-08-26T08:00:00.000Z';

let storage: SqliteStorage;

beforeEach(() => {
  storage = new SqliteStorage(':memory:');
});

afterEach(() => {
  storage.close();
});

describe('DeadlineScheduler', () => {
  it('queues and sends exactly once across overlapping, repeated, and started ticks', async () => {
    seedProjectAndTask();
    bindGroup('chat-enabled', true);
    const deliveries: Array<{ destination: string; body: string }> = [];
    const scheduler = new DeadlineScheduler({
      storage,
      sender: async (destination, body) => {
        deliveries.push({ destination, body });
      },
      intervalMs: 60_000,
      lookaheadHours: 48,
      now: () => AS_OF,
    });

    const first = scheduler.tick();
    const overlapping = scheduler.tick();
    expect(overlapping).toBe(first);
    await Promise.all([first, overlapping]);
    await scheduler.tick(AS_OF);
    await scheduler.start();
    expect(scheduler.running).toBe(true);
    await scheduler.stop();

    expect(scheduler.running).toBe(false);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ destination: 'chat-enabled' });
    expect(deliveries[0]?.body).toContain('Ship the release');
    expect(storage.listNotifications('workspace-a')).toEqual([
      expect.objectContaining({
        destination: 'chat-enabled',
        taskId: 'task-a',
        status: 'sent',
        scheduledAt: AS_OF,
      }),
    ]);
  });

  it('does not queue or send deadline notifications for an opted-out group', async () => {
    seedProjectAndTask();
    bindGroup('chat-opted-out', false);
    const deliveries: string[] = [];
    const scheduler = schedulerWith(async (destination) => {
      deliveries.push(destination);
    });

    await scheduler.tick(AS_OF);
    await scheduler.tick(AS_OF);

    expect(deliveries).toEqual([]);
    expect(storage.listNotifications('workspace-a')).toEqual([]);
  });

  it('finishes each notification independently and never retries a terminal failure', async () => {
    seedProjectAndTask();
    bindGroup('chat-failing', true);
    bindGroup('chat-successful', true);
    const attempts: string[] = [];
    const errors: unknown[] = [];
    const scheduler = schedulerWith(
      async (destination) => {
        attempts.push(destination);
        if (destination === 'chat-failing') throw new Error('transport unavailable');
      },
      errors,
    );

    await scheduler.tick(AS_OF);
    await scheduler.tick(AS_OF);

    expect(attempts.sort()).toEqual(['chat-failing', 'chat-successful']);
    const notifications = storage.listNotifications('workspace-a');
    expect(notifications).toHaveLength(2);
    expect(notifications.find((item) => item.destination === 'chat-failing')).toMatchObject({
      status: 'failed',
      error: 'transport unavailable',
    });
    expect(notifications.find((item) => item.destination === 'chat-successful')).toMatchObject({
      status: 'sent',
    });
    expect(errors).toEqual([expect.objectContaining({ message: 'transport unavailable' })]);
  });

  it('recovers an in-flight delivery as unknown outcome after restart without resending it', async () => {
    seedProjectAndTask();
    bindGroup('chat-restart', true);
    storage.planDeadlineNotifications(AS_OF, 48);
    const claimed = storage.claimNotifications(AS_OF, 1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe('sending');
    const deliveries: string[] = [];
    const restarted = schedulerWith(async (destination) => {
      deliveries.push(destination);
    });

    await restarted.tick(AS_OF);
    await restarted.tick(AS_OF);

    expect(deliveries).toEqual([]);
    expect(restarted.recoveredUnknownOutcomes).toBe(1);
    expect(storage.listNotifications('workspace-a')).toEqual([
      expect.objectContaining({
        id: claimed[0]?.id,
        destination: 'chat-restart',
        status: 'unknown_outcome',
        error: 'UNKNOWN_OUTCOME_AFTER_RESTART',
      }),
    ]);
  });

  it('bounds shutdown and preserves an ambiguous claimed delivery as unknown outcome', async () => {
    seedProjectAndTask();
    bindGroup('chat-slow', true);
    let releaseSender!: () => void;
    let senderStarted!: () => void;
    const started = new Promise<void>((resolve) => { senderStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseSender = resolve; });
    let deliverySignal: AbortSignal | undefined;
    let attempts = 0;
    const scheduler = new DeadlineScheduler({
      storage,
      sender: async (_destination, _body, signal) => {
        attempts += 1;
        deliverySignal = signal;
        senderStarted();
        // Deliberately ignore the signal to exercise the non-cooperative path.
        await blocked;
      },
      shutdownTimeoutMs: 20,
      now: () => AS_OF,
    });

    const activeTick = scheduler.tick(AS_OF);
    await started;
    const result = await scheduler.stop();

    expect(result).toMatchObject({ settled: false });
    expect(result.unknownOutcomeNotificationId).toBeTruthy();
    expect(deliverySignal?.aborted).toBe(true);
    expect(storage.listNotifications('workspace-a')).toEqual([
      expect.objectContaining({
        id: result.unknownOutcomeNotificationId,
        status: 'unknown_outcome',
        error: 'UNKNOWN_OUTCOME_AFTER_SHUTDOWN_TIMEOUT',
      }),
    ]);

    releaseSender();
    await activeTick;
    await scheduler.tick(AS_OF);
    expect(attempts).toBe(1);
    expect(storage.listNotifications('workspace-a')[0]).toMatchObject({
      status: 'unknown_outcome',
      error: 'UNKNOWN_OUTCOME_AFTER_SHUTDOWN_TIMEOUT',
    });
  });

  it('lets a cooperative in-flight delivery settle inside the shutdown budget', async () => {
    seedProjectAndTask();
    bindGroup('chat-fast', true);
    let senderStarted!: () => void;
    let releaseSender!: () => void;
    const started = new Promise<void>((resolve) => { senderStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseSender = resolve; });
    const scheduler = new DeadlineScheduler({
      storage,
      sender: async () => {
        senderStarted();
        await blocked;
      },
      shutdownTimeoutMs: 1_000,
      now: () => AS_OF,
    });

    const activeTick = scheduler.tick(AS_OF);
    await started;
    const stopping = scheduler.stop();
    releaseSender();

    await expect(stopping).resolves.toEqual({ settled: true });
    await activeTick;
    expect(storage.listNotifications('workspace-a')[0]).toMatchObject({ status: 'sent' });
  });
});

function seedProjectAndTask(): void {
  storage.putProject({
    id: 'project-a',
    workspaceId: 'workspace-a',
    name: 'Project A',
    status: 'active',
    summary: 'Test project',
    owner: 'alice',
    dueAt: DUE_AT,
  });
  storage.putTask({
    id: 'task-a',
    workspaceId: 'workspace-a',
    projectId: 'project-a',
    title: 'Ship the release',
    status: 'todo',
    priority: 'high',
    assignee: 'alice',
    dueAt: DUE_AT,
  });
}

function bindGroup(externalId: string, notificationsEnabled: boolean): void {
  storage.upsertGroupSpace({
    workspaceId: 'workspace-a',
    source: 'telegram',
    externalId,
    title: externalId,
    projectId: 'project-a',
    learningEnabled: false,
    notificationsEnabled,
    createdBy: 'admin',
  });
}

function schedulerWith(
  sender: (destination: string, body: string) => Promise<void>,
  errors?: unknown[],
): DeadlineScheduler {
  return new DeadlineScheduler({
    storage,
    sender,
    intervalMs: 60_000,
    lookaheadHours: 48,
    now: () => AS_OF,
    ...(errors ? { onError: (error: unknown) => errors.push(error) } : {}),
  });
}

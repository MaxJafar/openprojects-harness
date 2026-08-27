import type { SqliteStorage } from '../storage/sqlite.js';

export const DEFAULT_DEADLINE_SCHEDULER_INTERVAL_MS = 60_000;
export const DEFAULT_DEADLINE_LOOKAHEAD_HOURS = 48;
export const DEFAULT_DEADLINE_CLAIM_LIMIT = 20;
export const DEFAULT_DEADLINE_SHUTDOWN_TIMEOUT_MS = 10_000;

export type NotificationSender = (
  destination: string,
  body: string,
  signal: AbortSignal,
) => Promise<void>;
export type DeadlineNotificationSender = NotificationSender;

export type DeadlineSchedulerStorage = Pick<
  SqliteStorage,
  | 'planDeadlineNotifications'
  | 'claimNotifications'
  | 'finishNotification'
  | 'markNotificationUnknownOutcome'
  | 'recoverSendingNotifications'
>;

export interface DeadlineSchedulerConfig {
  intervalMs?: number;
  lookaheadHours?: number;
  claimLimit?: number;
  shutdownTimeoutMs?: number;
  now?: () => Date | string;
  onError?: (error: unknown) => void;
}

export interface DeadlineSchedulerOptions extends DeadlineSchedulerConfig {
  storage: DeadlineSchedulerStorage;
  sender: NotificationSender;
}

export interface DeadlineSchedulerStopResult {
  /** True when the active pass settled within the shutdown budget. */
  settled: boolean;
  /** Exact claimed delivery conservatively classified as ambiguous, if any. */
  unknownOutcomeNotificationId?: string;
}

/**
 * Plans and delivers persisted deadline notifications without involving a model.
 *
 * A notification is claimed immediately before it is sent. If the process exits
 * while that send is in progress, a new scheduler instance conservatively moves
 * the stranded `sending` row to `unknown_outcome` and never retries it.
 */
export class DeadlineScheduler {
  readonly #storage: DeadlineSchedulerStorage;
  readonly #sender: NotificationSender;
  readonly #intervalMs: number;
  readonly #lookaheadHours: number;
  readonly #claimLimit: number;
  readonly #shutdownTimeoutMs: number;
  readonly #now: () => Date | string;
  readonly #onError: ((error: unknown) => void) | undefined;

  #timer: ReturnType<typeof setInterval> | undefined;
  #activeTick: Promise<void> | undefined;
  #activeNotificationId: string | undefined;
  #deliveryAbort = new AbortController();
  #stopping = false;
  #storageWritesAllowed = true;
  #recovered = false;
  #recoveredUnknownOutcomes = 0;

  constructor(options: DeadlineSchedulerOptions);
  constructor(
    storage: DeadlineSchedulerStorage,
    sender: NotificationSender,
    config?: DeadlineSchedulerConfig,
  );
  constructor(
    storageOrOptions: DeadlineSchedulerStorage | DeadlineSchedulerOptions,
    sender?: NotificationSender,
    config: DeadlineSchedulerConfig = {},
  ) {
    const options = isSchedulerOptions(storageOrOptions)
      ? storageOrOptions
      : { ...config, storage: storageOrOptions, sender };

    if (typeof options.sender !== 'function') {
      throw new TypeError('DeadlineScheduler requires a notification sender');
    }

    this.#storage = options.storage;
    this.#sender = options.sender;
    this.#intervalMs = positiveInteger(
      options.intervalMs ?? DEFAULT_DEADLINE_SCHEDULER_INTERVAL_MS,
      'intervalMs',
    );
    this.#lookaheadHours = nonNegativeFinite(
      options.lookaheadHours ?? DEFAULT_DEADLINE_LOOKAHEAD_HOURS,
      'lookaheadHours',
    );
    this.#claimLimit = positiveInteger(
      options.claimLimit ?? DEFAULT_DEADLINE_CLAIM_LIMIT,
      'claimLimit',
    );
    this.#shutdownTimeoutMs = positiveInteger(
      options.shutdownTimeoutMs ?? DEFAULT_DEADLINE_SHUTDOWN_TIMEOUT_MS,
      'shutdownTimeoutMs',
    );
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError;
  }

  get running(): boolean {
    return this.#timer !== undefined;
  }

  get recoveredUnknownOutcomes(): number {
    return this.#recoveredUnknownOutcomes;
  }

  /** Starts an idempotent interval and returns the immediate first tick. */
  start(): Promise<void> {
    if (this.#timer !== undefined) return this.#activeTick ?? Promise.resolve();

    this.#recoverOnce();
    const firstTick = this.tick();
    void firstTick.catch((error: unknown) => this.#reportError(error));
    this.#timer = setInterval(() => this.#runScheduledTick(), this.#intervalMs);
    this.#timer.unref?.();
    return firstTick;
  }

  /**
   * Stops future ticks and gives a claimed delivery a bounded opportunity to
   * settle. A timed-out delivery is durably marked unknown before its signal is
   * aborted. Any non-cooperative sender may remain alive, but its detached tick
   * is permanently barred from touching storage after this method returns.
   */
  async stop(): Promise<DeadlineSchedulerStopResult> {
    this.#stopping = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }

    const activeTick = this.#activeTick;
    if (!activeTick) return { settled: true };

    const settled = await settlesWithin(activeTick, this.#shutdownTimeoutMs);
    if (settled) return { settled: true };

    const notificationId = this.#activeNotificationId;
    let markingError: unknown;
    if (notificationId && this.#storageWritesAllowed) {
      try {
        const changed = this.#storage.markNotificationUnknownOutcome(
          notificationId,
          'UNKNOWN_OUTCOME_AFTER_SHUTDOWN_TIMEOUT',
        );
        if (!changed) {
          throw new Error('Claimed notification could not be classified as unknown during shutdown');
        }
      } catch (error) {
        markingError = error;
      }
    }

    // These synchronous state changes happen before abort continuations can
    // run, so a late sender cannot overwrite the ambiguity classification or
    // access a database that the owning app may close next.
    this.#storageWritesAllowed = false;
    this.#deliveryAbort.abort(new Error('Deadline scheduler shutdown timed out'));
    if (markingError) throw markingError;
    return {
      settled: false,
      ...(notificationId ? { unknownOutcomeNotificationId: notificationId } : {}),
    };
  }

  /**
   * Runs one deterministic planning and delivery pass.
   *
   * Concurrent calls coalesce onto the active pass, so notification delivery
   * never overlaps within a scheduler instance.
   */
  tick(asOf?: Date | string): Promise<void> {
    if (this.#stopping) return Promise.resolve();
    if (this.#activeTick) return this.#activeTick;

    const timestamp = isoTimestamp(asOf ?? this.#now());
    const operation = Promise.resolve().then(() => this.#executeTick(timestamp));
    const tracked = operation.finally(() => {
      if (this.#activeTick === tracked) this.#activeTick = undefined;
    });
    this.#activeTick = tracked;
    return tracked;
  }

  async #executeTick(asOf: string): Promise<void> {
    if (this.#stopping || !this.#storageWritesAllowed) return;
    this.#recoverOnce();
    this.#storage.planDeadlineNotifications(asOf, this.#lookaheadHours);

    for (let index = 0; index < this.#claimLimit; index += 1) {
      if (this.#stopping || !this.#storageWritesAllowed) return;
      const notification = this.#storage.claimNotifications(asOf, 1)[0];
      if (!notification) return;
      this.#activeNotificationId = notification.id;

      try {
        await this.#sender(
          notification.destination,
          notification.body,
          this.#deliveryAbort.signal,
        );
      } catch (error) {
        if (this.#storageWritesAllowed) {
          try {
            this.#storage.finishNotification(notification.id, 'failed', errorMessage(error));
          } catch (finishError) {
            this.#reportError(finishError);
          }
          this.#reportError(error);
        }
        this.#activeNotificationId = undefined;
        continue;
      }

      if (this.#storageWritesAllowed) {
        try {
          this.#storage.finishNotification(notification.id, 'sent');
        } catch (error) {
          // The external delivery may have succeeded. Leaving the row in
          // `sending` lets restart recovery classify it as unknown, not retry it.
          this.#reportError(error);
        }
      }
      this.#activeNotificationId = undefined;
    }
  }

  #recoverOnce(): void {
    if (this.#recovered) return;
    const recovered = this.#storage.recoverSendingNotifications();
    this.#recoveredUnknownOutcomes += recovered;
    this.#recovered = true;
  }

  #runScheduledTick(): void {
    try {
      void this.tick().catch((error: unknown) => this.#reportError(error));
    } catch (error) {
      this.#reportError(error);
    }
  }

  #reportError(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      // An observer must not interrupt notification processing.
    }
  }
}

async function settlesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isSchedulerOptions(
  value: DeadlineSchedulerStorage | DeadlineSchedulerOptions,
): value is DeadlineSchedulerOptions {
  return 'storage' in value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function isoTimestamp(value: Date | string): string {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new RangeError('Scheduler clock must return a valid timestamp');
  return new Date(timestamp).toISOString();
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'Unknown notification delivery error';
  }
}

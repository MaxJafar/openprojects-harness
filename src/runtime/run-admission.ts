export const RUN_ADMISSION_REJECTED_CODE = 'RUN_ADMISSION_REJECTED';

/**
 * Raised synchronously before durable work is allocated when the application
 * has no run slot available. Callers can safely retry after an active run
 * reaches its next terminal or approval-waiting boundary.
 */
export class RunAdmissionError extends Error {
  readonly code = RUN_ADMISSION_REJECTED_CODE;

  constructor(readonly maximumActiveRuns: number) {
    super(`Global run capacity is full (${maximumActiveRuns} active run${maximumActiveRuns === 1 ? '' : 's'} maximum)`);
    this.name = 'RunAdmissionError';
  }
}

export interface RunAdmissionLease {
  /** Idempotent so nested execution cleanup can safely release ownership. */
  release(): void;
}

/**
 * Process-local admission shared by every AgentRuntime owned by one app.
 *
 * This deliberately rejects instead of queueing. An unbounded in-memory queue
 * would itself become a resource exhaustion path, and queued approval decisions
 * would be harder to reason about durably.
 */
export class RunAdmissionGovernor {
  #activeRuns = 0;

  constructor(readonly maximumActiveRuns?: number) {
    if (
      maximumActiveRuns !== undefined
      && (!Number.isSafeInteger(maximumActiveRuns) || maximumActiveRuns < 1)
    ) {
      throw new Error('maximumActiveRuns must be a positive safe integer when configured');
    }
  }

  get activeRuns(): number {
    return this.#activeRuns;
  }

  acquire(): RunAdmissionLease {
    if (this.maximumActiveRuns !== undefined && this.#activeRuns >= this.maximumActiveRuns) {
      throw new RunAdmissionError(this.maximumActiveRuns);
    }
    this.#activeRuns += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#activeRuns -= 1;
      },
    };
  }
}

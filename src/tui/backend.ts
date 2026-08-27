import type { OpenProjectsApp } from '../app.js';
import type { RunRecord, StartRunInput } from '../core/types.js';
import {
  captureTuiSnapshot,
  type TuiSnapshot,
  type TuiSnapshotOptions,
} from './model.js';

export interface TuiRunHandle {
  run: RunRecord;
  statusUrl?: string;
  eventsUrl?: string;
}

export type TuiApprovalResolution = {
  approvalId: string;
  actorId: string;
  reason?: string;
} & (
  | { decision: 'approve'; argumentsDigest: string }
  | { decision: 'reject'; argumentsDigest?: string }
);

/**
 * Narrow transport boundary used by the terminal UI. Implementations may own
 * the runtime directly (tests/standalone mode) or proxy the local HTTP service.
 */
export interface TuiBackend {
  snapshot(workspaceId: string, options?: TuiSnapshotOptions): Promise<TuiSnapshot>;
  startRun(input: StartRunInput): Promise<TuiRunHandle>;
  resolveApproval(input: TuiApprovalResolution): Promise<TuiRunHandle>;
  subscribe(
    workspaceId: string,
    onChange: () => void,
    onError?: (error: Error) => void,
  ): () => void;
}

export function createLocalTuiBackend(app: OpenProjectsApp): TuiBackend {
  return {
    async snapshot(workspaceId, options) {
      return captureTuiSnapshot(app, workspaceId, options);
    },
    async startRun(input) {
      const outcome = await app.runtime.start(input);
      return { run: outcome.run };
    },
    async resolveApproval(input) {
      const outcome = await app.runtime.resolveApproval(
        input.approvalId,
        input.decision,
        input.actorId,
        input.reason,
        undefined,
        input.argumentsDigest,
      );
      return { run: outcome.run };
    },
    subscribe(workspaceId, onChange) {
      return app.runtime.subscribe((event) => {
        try {
          if (app.storage.getRun(event.runId).workspaceId === workspaceId) onChange();
        } catch {
          // A runtime event without its durable run is not safe to surface.
        }
      });
    },
  };
}

export function asTuiBackend(value: OpenProjectsApp | TuiBackend): TuiBackend {
  return isTuiBackend(value) ? value : createLocalTuiBackend(value);
}

function isTuiBackend(value: OpenProjectsApp | TuiBackend): value is TuiBackend {
  return typeof (value as Partial<TuiBackend>).snapshot === 'function'
    && typeof (value as Partial<TuiBackend>).startRun === 'function'
    && typeof (value as Partial<TuiBackend>).resolveApproval === 'function'
    && typeof (value as Partial<TuiBackend>).subscribe === 'function';
}

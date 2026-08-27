import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { emitKeypressEvents, type Key } from 'node:readline';

import type { OpenProjectsApp } from '../app.js';
import { asTuiBackend, type TuiBackend } from './backend.js';
import {
  createTuiState,
  interpretKey,
  reduceTuiState,
} from './model.js';
import { isApprovalViewportSafe, renderTui, renderTuiSummary, shouldUseColor } from './render.js';

const ENTER_SCREEN = '\u001b[?1049h\u001b[?25l\u001b[2J\u001b[H';
const LEAVE_SCREEN = '\u001b[?25h\u001b[0m\u001b[?1049l';
const CURSOR_HOME = '\u001b[H\u001b[J';

export interface TuiInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): this;
}

export interface TuiOutput extends NodeJS.WritableStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

export interface RunTuiOptions {
  input?: TuiInput;
  output?: TuiOutput;
  workspaceId?: string;
  actorId?: string;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  plain?: boolean;
}

/**
 * Starts the full-screen mission control interface. The caller owns the backend
 * (and any local app behind it) and remains responsible for closing it.
 */
export async function runTui(target: OpenProjectsApp | TuiBackend, options: RunTuiOptions = {}): Promise<void> {
  const input = options.input ?? (defaultInput as TuiInput);
  const output = options.output ?? (defaultOutput as TuiOutput);
  const workspaceId = options.workspaceId ?? 'local';
  const actorId = options.actorId ?? 'local-user';
  const environment = options.environment ?? process.env;
  const backend = asTuiBackend(target);
  const approvalCursors: Array<string | undefined> = [undefined];
  let approvalPageIndex = 0;
  let snapshot = await backend.snapshot(workspaceId);

  if (options.plain === true || input.isTTY !== true || output.isTTY !== true || environment.TERM === 'dumb') {
    output.write(`${renderTuiSummary(snapshot)}\n`);
    return;
  }

  const useColor = shouldUseColor(environment, true);
  let state = createTuiState();
  let restored = false;
  let renderTimer: NodeJS.Timeout | undefined;
  let refreshInFlight: Promise<void> | undefined;
  let refreshRequested = false;
  const wasRaw = input.isRaw === true;

  const dimensions = (): { columns: number; rows: number } => ({
    columns: Math.max(20, output.columns ?? 100),
    rows: Math.max(10, output.rows ?? 30),
  });
  const draw = (): void => {
    if (restored) return;
    output.write(`${CURSOR_HOME}${renderTui(state, snapshot, dimensions(), { color: useColor })}`);
  };
  const scheduleDraw = (): void => {
    if (renderTimer || restored) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      draw();
    }, 16);
  };
  const refresh = (): Promise<void> => {
    refreshRequested = true;
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      while (refreshRequested && !restored) {
        refreshRequested = false;
        const approvalCursor = approvalCursors[approvalPageIndex];
        snapshot = await backend.snapshot(workspaceId, {
          ...(approvalCursor ? { approvalCursor } : {}),
        });
        scheduleDraw();
      }
    })().finally(() => {
      refreshInFlight = undefined;
    });
    return refreshInFlight;
  };

  return new Promise<void>((resolve, reject) => {
    const unsubscribe = backend.subscribe(
      workspaceId,
      () => { void refresh().catch(showStreamError); },
      showStreamError,
    );
    const inFlight = new Set<Promise<void>>();
    let stopping = false;

    function showStreamError(error: Error): void {
      if (restored) return;
      state = reduceTuiState(state, {
        type: 'set_notice',
        tone: 'warning',
        message: `Service event stream: ${error.message}`,
      }, snapshot);
      scheduleDraw();
    }

    const cleanup = (): unknown => {
      if (restored) return undefined;
      restored = true;
      let firstError: unknown;
      const attempt = (operation: () => void): void => {
        try {
          operation();
        } catch (error) {
          firstError ??= error;
        }
      };
      if (renderTimer) clearTimeout(renderTimer);
      renderTimer = undefined;
      attempt(unsubscribe);
      attempt(() => input.off('keypress', onKeypress));
      attempt(() => output.off('resize', scheduleDraw));
      attempt(() => process.off('SIGINT', onSignal));
      attempt(() => process.off('SIGTERM', onSignal));
      if (process.platform === 'win32') attempt(() => process.off('SIGBREAK', onSignal));
      attempt(() => options.signal?.removeEventListener('abort', onAbort));
      if (input.setRawMode) attempt(() => { input.setRawMode!(wasRaw); });
      attempt(() => input.pause());
      attempt(() => { output.write(LEAVE_SCREEN); });
      return firstError;
    };
    const stop = (error?: unknown): void => {
      if (stopping) return;
      stopping = true;
      const cleanupError = cleanup();
      let finalError = error ?? cleanupError;
      const pending = [...inFlight];
      if (!pending.length) {
        if (finalError) reject(finalError);
        else resolve();
        return;
      }
      try {
        output.write('\nOpenProjects: waiting for the active bounded operation to finish safely…\n');
      } catch (writeError) {
        finalError ??= writeError;
      }
      void Promise.allSettled(pending).then((results) => {
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (finalError) reject(finalError);
        else if (rejected) reject(rejected.reason);
        else resolve();
      });
    };
    const onSignal = (): void => stop();
    const onAbort = (): void => stop();

    const submitComposer = async (): Promise<void> => {
      const composer = state.composer;
      const message = composer?.text.trim() ?? '';
      if (!message) {
        state = reduceTuiState(state, { type: 'set_notice', tone: 'warning', message: 'Task cannot be empty' }, snapshot);
        draw();
        return;
      }
      const projectId = composer?.projectId;
      if (projectId && !snapshot.projects.some((project) => project.id === projectId)) {
        throw new Error('The selected project is outside the active workspace');
      }
      state = reduceTuiState(state, { type: 'set_busy', busy: true }, snapshot);
      draw();
      try {
        const handle = await backend.startRun({
          message,
          workspaceId,
          actorId,
          ...(projectId ? { projectId } : {}),
          channel: 'tui',
        });
        await refresh();
        state = {
          ...state,
          page: 'runs',
          selected: { ...state.selected, runs: 0 },
          composer: undefined,
          busy: false,
          notice: handle.run.status === 'succeeded'
            ? { tone: 'success', message: `Run ${handle.run.id.slice(0, 8)} completed` }
            : handle.run.status === 'waiting_for_approval'
              ? { tone: 'warning', message: 'Run is waiting for approval' }
              : handle.run.status === 'failed' || handle.run.status === 'cancelled'
                ? { tone: 'danger', message: handle.run.error ?? `Run ended ${handle.run.status}` }
                : { tone: 'info', message: `Run ${handle.run.id.slice(0, 8)} accepted by the local service` },
        };
      } catch (error) {
        state = {
          ...state,
          busy: false,
          notice: { tone: 'danger', message: error instanceof Error ? error.message : String(error) },
        };
      }
      draw();
    };

    const executeApproval = async (): Promise<void> => {
      const confirmation = state.confirmation;
      if (!confirmation) return;
      if (confirmation.reviewedThrough < confirmation.pages - 1) {
        state = reduceTuiState(state, {
          type: 'set_notice',
          tone: 'warning',
          message: 'Review every arguments page before confirming',
        }, snapshot);
        draw();
        return;
      }
      if (!isApprovalViewportSafe(dimensions())) {
        state = reduceTuiState(state, {
          type: 'set_notice',
          tone: 'warning',
          message: 'Resize to at least 48 × 22 before reviewing an approval',
        }, snapshot);
        draw();
        return;
      }
      const approval = snapshot.approvals.find((item) => item.id === confirmation.approvalId);
      if (!approval || approval.status !== 'pending') {
        state = {
          ...state,
          confirmation: undefined,
          notice: { tone: 'warning', message: 'Approval is no longer pending' },
        };
        void refresh().catch(showStreamError);
        draw();
        return;
      }
      if (approval.argumentsDigest !== confirmation.argumentsDigest) {
        state = {
          ...state,
          confirmation: undefined,
          notice: { tone: 'danger', message: 'Approval arguments changed after review; reopen the approval' },
        };
        void refresh().catch(showStreamError);
        draw();
        return;
      }
      if (confirmation.decision === 'approve' && approval.argumentsDigest === undefined) {
        state = {
          ...state,
          confirmation: undefined,
          notice: { tone: 'danger', message: 'Legacy approval has no bound argument digest and cannot be approved' },
        };
        draw();
        return;
      }
      state = reduceTuiState(state, { type: 'set_busy', busy: true }, snapshot);
      draw();
      try {
        if (confirmation.decision === 'approve') {
          await backend.resolveApproval({
            approvalId: approval.id,
            decision: 'approve',
            actorId,
            reason: 'Explicit approve decision from local TUI',
            argumentsDigest: approval.argumentsDigest!,
          });
        } else {
          await backend.resolveApproval({
            approvalId: approval.id,
            decision: 'reject',
            actorId,
            reason: 'Explicit reject decision from local TUI',
            ...(approval.argumentsDigest ? { argumentsDigest: approval.argumentsDigest } : {}),
          });
        }
        await refresh();
        state = {
          ...state,
          confirmation: undefined,
          busy: false,
          notice: {
            tone: confirmation.decision === 'approve' ? 'success' : 'warning',
            message: `${approval.toolName} ${confirmation.decision === 'approve' ? 'approved once' : 'rejected'}`,
          },
        };
      } catch (error) {
        state = {
          ...state,
          busy: false,
          notice: { tone: 'danger', message: error instanceof Error ? error.message : String(error) },
        };
      }
      draw();
    };

    const loadApprovalPage = async (direction: 1 | -1): Promise<void> => {
      const nextPage = approvalPageIndex + direction;
      const nextCursor = direction === 1
        ? snapshot.approvalPage.nextCursor
        : approvalCursors[nextPage];
      if (nextPage < 0 || (direction === 1 && !nextCursor)) {
        state = reduceTuiState(state, {
          type: 'set_notice',
          tone: 'info',
          message: direction === 1 ? 'Already on the final approval page' : 'Already on the first approval page',
        }, snapshot);
        draw();
        return;
      }
      state = reduceTuiState(state, { type: 'set_busy', busy: true }, snapshot);
      draw();
      try {
        const page = await backend.snapshot(workspaceId, {
          ...(nextCursor ? { approvalCursor: nextCursor } : {}),
        });
        if (direction === 1) {
          approvalCursors.splice(nextPage);
          approvalCursors[nextPage] = nextCursor;
        }
        approvalPageIndex = nextPage;
        snapshot = page;
        state = reduceTuiState(state, { type: 'set_approval_page', page: approvalPageIndex }, snapshot);
        state = {
          ...state,
          busy: false,
          notice: { tone: 'info', message: `Approval page ${approvalPageIndex + 1}` },
        };
      } catch (error) {
        state = {
          ...state,
          busy: false,
          notice: { tone: 'danger', message: error instanceof Error ? error.message : String(error) },
        };
      }
      draw();
    };

    const handleKey = async (text: string | undefined, key: Key): Promise<void> => {
      const intent = interpretKey(state, snapshot, {
        ...(key.name ? { name: key.name } : {}),
        sequence: key.sequence ?? text ?? '',
        ...(key.ctrl !== undefined ? { ctrl: key.ctrl } : {}),
        ...(key.shift !== undefined ? { shift: key.shift } : {}),
      });
      if (intent.type === 'quit') {
        stop();
        return;
      }
      if (intent.type === 'refresh') {
        await refresh();
        state = reduceTuiState(state, { type: 'set_notice', tone: 'info', message: 'Data refreshed' }, snapshot);
        draw();
        return;
      }
      if (intent.type === 'next_approval_page') {
        await loadApprovalPage(1);
        return;
      }
      if (intent.type === 'previous_approval_page') {
        await loadApprovalPage(-1);
        return;
      }
      if (intent.type === 'dispatch') {
        state = reduceTuiState(state, intent.action, snapshot);
        draw();
        return;
      }
      if (intent.type === 'submit_composer') {
        await submitComposer();
        return;
      }
      if (intent.type === 'execute_approval') await executeApproval();
    };

    function onKeypress(text: string | undefined, key: Key): void {
      const quitting = (key.ctrl === true && key.name === 'c') || text === 'q' || key.sequence === 'q';
      if (quitting && state.busy) {
        stop();
        return;
      }
      const operation = handleKey(text, key);
      inFlight.add(operation);
      void operation.catch(stop).finally(() => {
        inFlight.delete(operation);
      });
    }

    if (options.signal?.aborted === true) {
      unsubscribe();
      resolve();
      return;
    }
    try {
      emitKeypressEvents(input);
      input.on('keypress', onKeypress);
      output.on('resize', scheduleDraw);
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      if (process.platform === 'win32') process.once('SIGBREAK', onSignal);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (input.setRawMode) input.setRawMode(true);
      input.resume();
      output.write(ENTER_SCREEN);
      draw();
    } catch (error) {
      stop(error);
    }
  });
}

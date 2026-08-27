import type { OpenProjectsApp } from '../app.js';
import type {
  ApprovalRecord,
  ControlCapability,
  MemoryRecord,
  PolicyDecision,
  RunRecord,
  ToolEffect,
} from '../core/types.js';
import type { ProjectRecord, TaskRecord } from '../storage/sqlite.js';
import { approvalArgumentPages, sanitizeTerminalText } from './sanitize.js';

export const TUI_PAGES = ['overview', 'runs', 'approvals', 'memory', 'projects'] as const;
export type TuiPage = (typeof TUI_PAGES)[number];

export interface TuiProject extends ProjectRecord {
  tasks: TaskRecord[];
}

export interface TuiApproval extends ApprovalRecord {
  effect: ToolEffect | 'unknown';
  policyDecision: PolicyDecision;
  actorId: string;
  projectId?: string;
  runInput: string;
}

export interface TuiSnapshot {
  generatedAt: string;
  workspaceId: string;
  agent: {
    name: string;
    version: string;
  };
  model: {
    provider: string;
    name: string;
    routeCount: number;
  };
  privacy: {
    localOnly: boolean;
    allowedOrigins: number;
    telegramEnabled: boolean;
  };
  services: {
    embeddings: string;
    transcription: string;
  };
  /** Present for service-attached sessions; standalone mode is locally trusted. */
  control?: {
    authenticated: boolean;
    principalId: string;
    capabilities: ControlCapability[];
    workspaceScope: 'all' | 'scoped';
  };
  runs: RunRecord[];
  approvals: TuiApproval[];
  approvalPage: {
    limit: number;
    nextCursor?: string;
  };
  memories: MemoryRecord[];
  projects: TuiProject[];
}

export interface TuiSnapshotOptions {
  approvalCursor?: string;
  approvalLimit?: number;
}

export type TuiNoticeTone = 'info' | 'success' | 'warning' | 'danger';

export interface TuiState {
  page: TuiPage;
  approvalPageIndex: number;
  selected: Record<TuiPage, number>;
  composer?: {
    text: string;
    projectId?: string;
  } | undefined;
  confirmation?: {
    approvalId: string;
    argumentsDigest?: string;
    decision: 'approve' | 'reject';
    page: number;
    pages: number;
    reviewedThrough: number;
  } | undefined;
  notice?: {
    tone: TuiNoticeTone;
    message: string;
  } | undefined;
  busy: boolean;
}

export type TuiAction =
  | { type: 'next_page' }
  | { type: 'previous_page' }
  | { type: 'set_page'; page: TuiPage }
  | { type: 'set_approval_page'; page: number }
  | { type: 'move_selection'; delta: number }
  | { type: 'open_composer'; projectId?: string }
  | { type: 'composer_insert'; text: string }
  | { type: 'composer_backspace' }
  | { type: 'composer_delete_word' }
  | { type: 'composer_clear' }
  | { type: 'close_composer' }
  | { type: 'request_approval'; approvalId: string; decision: 'approve' | 'reject' }
  | { type: 'next_confirmation_page' }
  | { type: 'previous_confirmation_page' }
  | { type: 'cancel_confirmation' }
  | { type: 'set_busy'; busy: boolean }
  | { type: 'set_notice'; tone: TuiNoticeTone; message: string }
  | { type: 'clear_notice' };

export interface KeyStroke {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  shift?: boolean;
}

export type TuiIntent =
  | { type: 'none' }
  | { type: 'quit' }
  | { type: 'refresh' }
  | { type: 'next_approval_page' }
  | { type: 'previous_approval_page' }
  | { type: 'submit_composer' }
  | { type: 'execute_approval' }
  | { type: 'dispatch'; action: TuiAction };

export function captureTuiSnapshot(
  app: OpenProjectsApp,
  workspaceId = 'local',
  options: TuiSnapshotOptions = {},
): TuiSnapshot {
  const runs = app.storage.listRuns(workspaceId, 100);
  const projects = app.storage.listProjects(workspaceId).map((project) => ({
    ...project,
    tasks: app.storage.listTasks(project.id, workspaceId),
  }));
  const approvalLimit = options.approvalLimit ?? 100;
  const approvalPage = app.storage.listApprovalsPage({
    workspaceId,
    limit: approvalLimit,
    ...(options.approvalCursor ? { cursor: options.approvalCursor } : {}),
  });
  const approvals = approvalPage.approvals
    // Approval visibility is indexed directly by workspace and does not depend
    // on the 100-row recent-runs window. Pending rows sort before history.
    .map((approval): TuiApproval | undefined => {
      const run = app.storage.getRun(approval.runId);
      if (run.workspaceId !== workspaceId) {
        throw new Error(`Approval record ${approval.id} escaped its indexed workspace scope`);
      }
      const invocation = app.storage.approvalWithInvocation(approval.id).invocation;
      if (
        invocation.id !== approval.invocationId
        || invocation.runId !== approval.runId
        || invocation.toolName !== approval.toolName
        || invocation.arguments !== approval.arguments
        || invocation.argumentsDigest !== approval.argumentsDigest
      ) {
        throw new Error(`Approval record ${approval.id} is inconsistent with its stored invocation`);
      }
      return {
        ...approval,
        effect: invocation.effect ?? 'unknown',
        policyDecision: invocation.policyDecision,
        actorId: run.actorId,
        ...(run.projectId ? { projectId: run.projectId } : {}),
        runInput: run.input,
      };
    })
    .filter((approval): approval is TuiApproval => approval !== undefined);
  return {
    generatedAt: new Date().toISOString(),
    workspaceId,
    agent: {
      name: app.runtime.agent.name,
      version: app.runtime.agent.version,
    },
    model: {
      provider: app.config.model.provider,
      name: app.config.model.model,
      routeCount: app.config.routing?.routes.filter((route) => route.enabled).length ?? 1,
    },
    privacy: {
      localOnly: app.networkPolicy.localOnly,
      allowedOrigins: app.networkPolicy.allowedOrigins.length,
      telegramEnabled: app.config.telegram?.enabled === true,
    },
    services: {
      embeddings: app.embedding.id,
      transcription: app.transcriber.id,
    },
    runs,
    approvals,
    approvalPage: {
      limit: approvalLimit,
      ...(approvalPage.nextCursor ? { nextCursor: approvalPage.nextCursor } : {}),
    },
    memories: app.storage.listMemories(workspaceId, undefined, 200),
    projects,
  };
}

export function createTuiState(page: TuiPage = 'overview'): TuiState {
  return {
    page,
    approvalPageIndex: 0,
    selected: {
      overview: 0,
      runs: 0,
      approvals: 0,
      memory: 0,
      projects: 0,
    },
    busy: false,
  };
}

export function reduceTuiState(
  state: TuiState,
  action: TuiAction,
  snapshot: TuiSnapshot,
): TuiState {
  switch (action.type) {
    case 'next_page':
      return switchPage(state, 1);
    case 'previous_page':
      return switchPage(state, -1);
    case 'set_page':
      return { ...state, page: action.page };
    case 'set_approval_page':
      return {
        ...state,
        approvalPageIndex: Math.max(0, action.page),
        selected: { ...state.selected, approvals: 0 },
      };
    case 'move_selection': {
      const maximum = Math.max(0, rowsForPage(snapshot, state.page) - 1);
      const current = state.selected[state.page];
      return {
        ...state,
        selected: {
          ...state.selected,
          [state.page]: Math.max(0, Math.min(maximum, current + action.delta)),
        },
      };
    }
    case 'open_composer':
      return {
        ...state,
        composer: {
          text: '',
          ...(action.projectId ? { projectId: action.projectId } : {}),
        },
        confirmation: undefined,
        notice: undefined,
      };
    case 'composer_insert': {
      if (!state.composer) return state;
      const appended = sanitizeTerminalText(action.text, 4_000).replace(/[\n\t]+/gu, ' ');
      if (!appended) return state;
      return {
        ...state,
        composer: {
          ...state.composer,
          text: `${state.composer.text}${appended}`.slice(0, 4_000),
        },
      };
    }
    case 'composer_backspace':
      return state.composer
        ? {
            ...state,
            composer: {
              ...state.composer,
              text: Array.from(state.composer.text).slice(0, -1).join(''),
            },
          }
        : state;
    case 'composer_delete_word':
      return state.composer
        ? {
            ...state,
            composer: {
              ...state.composer,
              text: state.composer.text.replace(/\s*\S+\s*$/u, ''),
            },
          }
        : state;
    case 'composer_clear':
      return state.composer
        ? { ...state, composer: { ...state.composer, text: '' } }
        : state;
    case 'close_composer':
      return { ...state, composer: undefined };
    case 'request_approval': {
      const approval = snapshot.approvals.find((item) => item.id === action.approvalId);
      const pages = approvalArgumentPages(approval?.arguments ?? '').length;
      return {
        ...state,
        confirmation: {
          approvalId: action.approvalId,
          ...(approval?.argumentsDigest ? { argumentsDigest: approval.argumentsDigest } : {}),
          decision: action.decision,
          page: 0,
          pages,
          reviewedThrough: 0,
        },
        composer: undefined,
      };
    }
    case 'next_confirmation_page': {
      if (!state.confirmation) return state;
      const page = Math.min(state.confirmation.pages - 1, state.confirmation.page + 1);
      return {
        ...state,
        confirmation: {
          ...state.confirmation,
          page,
          reviewedThrough: Math.max(state.confirmation.reviewedThrough, page),
        },
      };
    }
    case 'previous_confirmation_page':
      return state.confirmation
        ? {
            ...state,
            confirmation: {
              ...state.confirmation,
              page: Math.max(0, state.confirmation.page - 1),
            },
          }
        : state;
    case 'cancel_confirmation':
      return { ...state, confirmation: undefined };
    case 'set_busy':
      return { ...state, busy: action.busy };
    case 'set_notice':
      return { ...state, notice: { tone: action.tone, message: action.message } };
    case 'clear_notice':
      return { ...state, notice: undefined };
  }
}

export function interpretKey(
  state: TuiState,
  snapshot: TuiSnapshot,
  key: KeyStroke,
): TuiIntent {
  const name = key.name?.toLocaleLowerCase();
  const sequence = key.sequence ?? '';
  if (key.ctrl === true && name === 'c') return { type: 'quit' };
  if (state.busy) return sequence === 'q' ? { type: 'quit' } : { type: 'none' };

  if (state.confirmation) {
    if (name === 'escape' || sequence.toLocaleLowerCase() === 'n') {
      return { type: 'dispatch', action: { type: 'cancel_confirmation' } };
    }
    if (name === 'up' || name === 'left' || sequence.toLocaleLowerCase() === 'k') {
      return { type: 'dispatch', action: { type: 'previous_confirmation_page' } };
    }
    if (name === 'down' || name === 'right' || name === 'space' || sequence.toLocaleLowerCase() === 'j' || sequence === ' ') {
      return { type: 'dispatch', action: { type: 'next_confirmation_page' } };
    }
    if (name === 'return' || sequence.toLocaleLowerCase() === 'y') {
      if (state.confirmation.reviewedThrough < state.confirmation.pages - 1) {
        return { type: 'dispatch', action: { type: 'next_confirmation_page' } };
      }
      return { type: 'execute_approval' };
    }
    return { type: 'none' };
  }

  if (state.composer) {
    if (name === 'escape') return { type: 'dispatch', action: { type: 'close_composer' } };
    if (name === 'return') return { type: 'submit_composer' };
    if (name === 'backspace') return { type: 'dispatch', action: { type: 'composer_backspace' } };
    if (key.ctrl === true && name === 'u') return { type: 'dispatch', action: { type: 'composer_clear' } };
    if (key.ctrl === true && name === 'w') return { type: 'dispatch', action: { type: 'composer_delete_word' } };
    if (sequence && key.ctrl !== true) {
      return { type: 'dispatch', action: { type: 'composer_insert', text: sequence } };
    }
    return { type: 'none' };
  }

  if (sequence === 'q') return { type: 'quit' };
  if (sequence === 'r') return { type: 'refresh' };
  if (name === 'tab' && key.shift === true) {
    return { type: 'dispatch', action: { type: 'previous_page' } };
  }
  if (name === 'tab' || name === 'right' || sequence === 'l') {
    return { type: 'dispatch', action: { type: 'next_page' } };
  }
  if (name === 'left' || sequence === 'h') {
    return { type: 'dispatch', action: { type: 'previous_page' } };
  }
  if (name === 'up' || sequence === 'k') {
    return { type: 'dispatch', action: { type: 'move_selection', delta: -1 } };
  }
  if (name === 'down' || sequence === 'j') {
    return { type: 'dispatch', action: { type: 'move_selection', delta: 1 } };
  }
  if (state.page === 'approvals' && (name === 'pagedown' || sequence === ']')) {
    return snapshot.approvalPage.nextCursor
      ? { type: 'next_approval_page' }
      : {
          type: 'dispatch',
          action: { type: 'set_notice', tone: 'info', message: 'Already on the final approval page' },
        };
  }
  if (state.page === 'approvals' && (name === 'pageup' || sequence === '[')) {
    return state.approvalPageIndex > 0
      ? { type: 'previous_approval_page' }
      : {
          type: 'dispatch',
          action: { type: 'set_notice', tone: 'info', message: 'Already on the first approval page' },
        };
  }
  const pageNumber = Number(sequence);
  if (Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= TUI_PAGES.length) {
    return { type: 'dispatch', action: { type: 'set_page', page: TUI_PAGES[pageNumber - 1]! } };
  }
  if (sequence === 'c' || sequence === 'n' || sequence === '/') {
    if (!tuiCan(snapshot, 'run')) {
      return {
        type: 'dispatch',
        action: { type: 'set_notice', tone: 'danger', message: 'This principal cannot start runs' },
      };
    }
    const project = state.page === 'projects'
      ? snapshot.projects[state.selected.projects]
      : undefined;
    return {
      type: 'dispatch',
      action: {
        type: 'open_composer',
        ...(project ? { projectId: project.id } : {}),
      },
    };
  }
  if (state.page === 'approvals' && (sequence === 'a' || sequence === 'x')) {
    if (!tuiCan(snapshot, 'approve')) {
      return {
        type: 'dispatch',
        action: { type: 'set_notice', tone: 'danger', message: 'This principal cannot resolve approvals' },
      };
    }
    const approval = snapshot.approvals[state.selected.approvals];
    if (approval?.status !== 'pending') return { type: 'none' };
    if (sequence === 'a' && approval.argumentsDigest === undefined) {
      return {
        type: 'dispatch',
        action: {
          type: 'set_notice',
          tone: 'danger',
          message: 'Legacy approval has no bound argument digest and cannot be approved',
        },
      };
    }
    return {
      type: 'dispatch',
      action: {
        type: 'request_approval',
        approvalId: approval.id,
        decision: sequence === 'a' ? 'approve' : 'reject',
      },
    };
  }
  return { type: 'none' };
}

export function tuiCan(snapshot: TuiSnapshot, capability: ControlCapability): boolean {
  const grants = snapshot.control?.capabilities;
  return grants === undefined || grants.includes('admin') || grants.includes(capability);
}

export function rowsForPage(snapshot: TuiSnapshot, page: TuiPage): number {
  switch (page) {
    case 'overview':
      return Math.min(5, snapshot.runs.length);
    case 'runs':
      return snapshot.runs.length;
    case 'approvals':
      return snapshot.approvals.length;
    case 'memory':
      return snapshot.memories.length;
    case 'projects':
      return snapshot.projects.length;
  }
}

function switchPage(state: TuiState, delta: number): TuiState {
  const current = TUI_PAGES.indexOf(state.page);
  const page = TUI_PAGES[(current + delta + TUI_PAGES.length) % TUI_PAGES.length]!;
  return { ...state, page };
}

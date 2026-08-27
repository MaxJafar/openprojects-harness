import type { MemoryRecord, RunRecord, RunStatus } from '../core/types.js';
import {
  TUI_PAGES,
  tuiCan,
  type TuiApproval,
  type TuiNoticeTone,
  type TuiSnapshot,
  type TuiState,
} from './model.js';
import { approvalArgumentPages, sanitizeTerminalText } from './sanitize.js';

const ESCAPE_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

export interface TuiDimensions {
  columns: number;
  rows: number;
}

export interface RenderTuiOptions {
  color?: boolean;
}

type ColorName = 'accent' | 'cyan' | 'amber' | 'green' | 'red' | 'muted' | 'text';

const FOREGROUND: Record<ColorName, string> = {
  accent: '38;2;45;212;191',
  cyan: '38;2;91;192;235',
  amber: '38;2;245;178;66',
  green: '38;2;92;211;123',
  red: '38;2;248;113;113',
  muted: '38;2;128;148;160',
  text: '38;2;226;232;236',
};

const BACKGROUND = '\u001b[48;2;13;20;26m';
const RESET = '\u001b[0m';

export function renderTui(
  state: TuiState,
  snapshot: TuiSnapshot,
  dimensions: TuiDimensions,
  options: RenderTuiOptions = {},
): string {
  const width = Math.max(20, Math.floor(dimensions.columns));
  const height = Math.max(10, Math.floor(dimensions.rows));
  const color = options.color !== false;
  const bodyHeight = Math.max(1, height - 7);
  const lines = [
    renderMasthead(snapshot, width, color),
    renderNavigation(state, width, color),
    rule(width, color),
    ...renderPage(state, snapshot, width, bodyHeight, color),
    rule(width, color),
    renderHelp(state, snapshot, width, color),
    renderFooter(state, snapshot, width, color),
  ];
  const fitted = lines.slice(0, height);
  while (fitted.length < height) fitted.splice(fitted.length - 3, 0, '');
  return fitted.map((line) => paintLine(line, width, color)).join('\n');
}

export function renderTuiSummary(snapshot: TuiSnapshot): string {
  const pending = snapshot.approvals.filter((approval) => approval.status === 'pending').length;
  const active = snapshot.runs.filter((run) => ['queued', 'running', 'waiting_for_approval'].includes(run.status)).length;
  const privacy = isSealed(snapshot) ? 'LOCAL-ONLY' : 'HYBRID';
  const lines = [
    'OpenProjects - private project operations',
    `Status: ${privacy}; agent ${safe(snapshot.agent.name, 60)} v${safe(snapshot.agent.version, 20)}`,
    `Model: ${safe(snapshot.model.provider, 30)}/${safe(snapshot.model.name, 50)}; embeddings ${safe(snapshot.services.embeddings, 50)}; transcription ${safe(snapshot.services.transcription, 50)}`,
    `Workspace: ${safe(snapshot.workspaceId, 50)}; ${snapshot.projects.length} projects; ${snapshot.runs.length} runs (${active} active); ${pending} pending approvals; ${snapshot.memories.length} memories`,
  ];
  if (snapshot.control) {
    lines.push(
      `Control: ${safe(snapshot.control.principalId, 50)}; ${snapshot.control.capabilities.join(', ')}; ${snapshot.control.workspaceScope} workspace scope`,
    );
  }
  if (snapshot.runs.length) {
    lines.push('Recent runs:');
    for (const run of snapshot.runs.slice(0, 5)) {
      lines.push(`- [${run.status.toUpperCase()}] ${safe(run.input, 100)} (${shortId(run.id)})`);
    }
  }
  if (pending) {
    lines.push('Pending approvals:');
    for (const approval of snapshot.approvals.filter((item) => item.status === 'pending').slice(0, 5)) {
      lines.push(
        `- [PENDING] ${safe(approval.toolName, 50)} (${shortId(approval.id)}); digest ${approval.argumentsDigest ?? 'LEGACY-UNBOUND'}`,
      );
    }
  }
  return lines.join('\n');
}

export function shouldUseColor(
  environment: NodeJS.ProcessEnv = process.env,
  isTty = true,
): boolean {
  return isTty && environment.NO_COLOR === undefined && environment.TERM !== 'dumb';
}

function renderMasthead(snapshot: TuiSnapshot, width: number, color: boolean): string {
  const brand = tone('◆ OPENPROJECTS', 'accent', color, true);
  const sealed = isSealed(snapshot);
  const privateMode = sealed ? '[LOCAL-ONLY]' : '[HYBRID]';
  const badge = tone(privateMode, sealed ? 'green' : 'amber', color, true);
  const identity = snapshot.control ? ` · ${safe(snapshot.control.principalId, 24)}` : '';
  const agent = tone(`${safe(snapshot.agent.name, 32)} v${safe(snapshot.agent.version, 12)}${identity}`, 'muted', color);
  return spread(`${brand}  ${agent}`, badge, width);
}

function renderNavigation(state: TuiState, width: number, color: boolean): string {
  const tabs = TUI_PAGES.map((page, index) => {
    const label = `${index + 1} ${title(page)}`;
    return page === state.page
      ? tone(`[ ${label} ]`, 'cyan', color, true)
      : tone(`  ${label}  `, 'muted', color);
  });
  return truncateAnsi(tabs.join(' '), width);
}

function renderPage(
  state: TuiState,
  snapshot: TuiSnapshot,
  width: number,
  height: number,
  color: boolean,
): string[] {
  let lines: string[];
  switch (state.page) {
    case 'overview':
      lines = renderOverview(state, snapshot, width, height, color);
      break;
    case 'runs':
      lines = renderRuns(state, snapshot, width, height, color);
      break;
    case 'approvals':
      lines = renderApprovals(state, snapshot, width, height, color);
      break;
    case 'memory':
      lines = renderMemories(state, snapshot, width, height, color);
      break;
    case 'projects':
      lines = renderProjects(state, snapshot, width, height, color);
      break;
  }
  while (lines.length < height) lines.push('');
  lines = lines.slice(0, height);
  if (state.composer) return overlay(lines, renderComposer(state, snapshot, width, color));
  if (state.confirmation) return overlay(lines, renderConfirmation(state, snapshot, width, height, color));
  return lines;
}

function renderOverview(
  state: TuiState,
  snapshot: TuiSnapshot,
  width: number,
  height: number,
  color: boolean,
): string[] {
  const pending = snapshot.approvals.filter((approval) => approval.status === 'pending').length;
  const active = snapshot.runs.filter((run) => ['queued', 'running', 'waiting_for_approval'].includes(run.status)).length;
  const tasks = snapshot.projects.flatMap((project) => project.tasks);
  const blocked = tasks.filter((task) => task.status === 'blocked' || Boolean(task.blockedReason)).length;
  const metricWidth = Math.max(11, Math.floor((width - 4) / 5));
  const metricLine = [
    metric('RUNS', String(snapshot.runs.length), 'cyan', metricWidth, color),
    metric('ACTIVE', String(active), active ? 'amber' : 'green', metricWidth, color),
    metric('APPROVALS', String(pending), pending ? 'amber' : 'green', metricWidth, color),
    metric('MEMORY', String(snapshot.memories.length), 'accent', metricWidth, color),
    metric('BLOCKED', String(blocked), blocked ? 'red' : 'green', metricWidth, color),
  ].join(' ');
  const stack = `${safe(snapshot.model.provider, 20)}/${safe(snapshot.model.name, 36)} · ${safe(snapshot.services.embeddings, 32)} · ${safe(snapshot.services.transcription, 32)}`;
  const lines = [
    sectionTitle('Mission control', 'Your private project colleague at a glance', color),
    '',
    truncateAnsi(metricLine, width),
    '',
    `${tone('LOCAL STACK', 'muted', color, true)}  ${tone(stack, 'text', color)}`,
    `${tone('NETWORK', 'muted', color, true)}      ${isSealed(snapshot)
      ? tone('SEALED · no external origins configured', 'green', color)
      : tone(`HYBRID · ${snapshot.privacy.allowedOrigins} external origin(s)${snapshot.privacy.telegramEnabled ? ' · Telegram enabled' : ''}`, 'amber', color)}`,
    '',
    sectionTitle('Recent activity', `${snapshot.runs.length} recorded runs`, color),
  ];
  const available = Math.max(0, height - lines.length);
  lines.push(...runRows(snapshot.runs, state.selected.overview, width, available, color));
  return lines;
}

function renderRuns(
  state: TuiState,
  snapshot: TuiSnapshot,
  width: number,
  height: number,
  color: boolean,
): string[] {
  const active = snapshot.runs.filter((run) => ['queued', 'running', 'waiting_for_approval'].includes(run.status)).length;
  const lines = [
    sectionTitle('Runs', `${snapshot.runs.length} total · ${active} active`, color),
    tableHeader(width, ['STATUS', 'RUN', 'STARTED', 'STEPS', 'REQUEST'], [14, 10, 17, 7], color),
  ];
  lines.push(...runRows(snapshot.runs, state.selected.runs, width, height - lines.length, color));
  if (!snapshot.runs.length) lines.push(emptyState('No runs yet', 'Press c to compose the first task.', color));
  return lines;
}

function renderApprovals(
  state: TuiState,
  snapshot: TuiSnapshot,
  width: number,
  height: number,
  color: boolean,
): string[] {
  const pending = snapshot.approvals.filter((approval) => approval.status === 'pending').length;
  const page = state.approvalPageIndex + 1;
  const lines = [
    sectionTitle(
      'Approvals',
      `${pending} pending on page ${page}${snapshot.approvalPage.nextCursor ? ' · more available' : ''} · every decision is explicit`,
      color,
    ),
    tableHeader(width, ['STATE', 'EFFECT', 'TOOL', 'REQUESTED', 'ARGUMENTS'], [13, 17, 20, 17], color),
  ];
  const window = visibleWindow(snapshot.approvals, state.selected.approvals, Math.max(0, height - lines.length));
  for (const { item, index } of window) {
    const marker = index === state.selected.approvals ? tone('›', 'cyan', color, true) : ' ';
    const status = approvalStatus(item, color);
    lines.push(row(
      width,
      marker,
      [status, item.effect.toUpperCase(), safe(item.toolName, 40), relativeTime(item.requestedAt), inline(item.arguments)],
      [13, 17, 20, 17],
    ));
  }
  if (!snapshot.approvals.length) lines.push(emptyState('Approval queue is clear', 'Consequential actions will appear here.', color));
  return lines;
}

function renderMemories(
  state: TuiState,
  snapshot: TuiSnapshot,
  width: number,
  height: number,
  color: boolean,
): string[] {
  const active = snapshot.memories.filter((memory) => memory.status === 'active').length;
  const proposed = snapshot.memories.filter((memory) => memory.status === 'proposed').length;
  const lines = [
    sectionTitle('Memory', `${active} active · ${proposed} awaiting review`, color),
    tableHeader(width, ['STATE', 'KIND', 'STRENGTH', 'REWARD', 'MEMORY'], [12, 12, 10, 9], color),
  ];
  const window = visibleWindow(snapshot.memories, state.selected.memory, Math.max(0, height - lines.length));
  for (const { item, index } of window) {
    const marker = index === state.selected.memory ? tone('›', 'cyan', color, true) : ' ';
    lines.push(row(width, marker, [memoryStatus(item, color), item.kind.toUpperCase(), item.strength.toFixed(2), signed(item.reward), inline(item.content)], [12, 12, 10, 9]));
  }
  if (!snapshot.memories.length) lines.push(emptyState('Memory is empty', 'Reviewed interactions and facts will accumulate here.', color));
  return lines;
}

function renderProjects(
  state: TuiState,
  snapshot: TuiSnapshot,
  width: number,
  height: number,
  color: boolean,
): string[] {
  const taskCount = snapshot.projects.reduce((total, project) => total + project.tasks.length, 0);
  const lines = [
    sectionTitle('Projects', `${snapshot.projects.length} projects · ${taskCount} tasks`, color),
    tableHeader(width, ['STATE', 'PROJECT', 'OWNER', 'DUE', 'TASKS', 'SUMMARY'], [12, 22, 16, 13, 7], color),
  ];
  const window = visibleWindow(snapshot.projects, state.selected.projects, Math.max(0, height - lines.length));
  for (const { item, index } of window) {
    const marker = index === state.selected.projects ? tone('›', 'cyan', color, true) : ' ';
    const open = item.tasks.filter((task) => !['done', 'completed', 'cancelled'].includes(task.status)).length;
    lines.push(row(width, marker, [projectStatus(item.status, color), safe(item.name, 100), safe(item.owner, 80), item.dueAt ? shortDate(item.dueAt) : '—', `${open}/${item.tasks.length}`, inline(item.summary)], [12, 22, 16, 13, 7]));
  }
  if (!snapshot.projects.length) lines.push(emptyState('No projects', 'Create one through the harness to begin tracking work.', color));
  return lines;
}

function runRows(
  runs: RunRecord[],
  selected: number,
  width: number,
  height: number,
  color: boolean,
): string[] {
  const result: string[] = [];
  const window = visibleWindow(runs, selected, height);
  for (const { item, index } of window) {
    const marker = index === selected ? tone('›', 'cyan', color, true) : ' ';
    result.push(row(width, marker, [runStatus(item.status, color), shortId(item.id), relativeTime(item.createdAt), `${item.step}/${item.toolCalls}`, inline(item.input)], [14, 10, 17, 7]));
  }
  return result;
}

function renderComposer(
  state: TuiState,
  snapshot: TuiSnapshot,
  width: number,
  color: boolean,
): string[] {
  const composer = state.composer!;
  const project = snapshot.projects.find((item) => item.id === composer.projectId);
  const label = project ? `Task for ${safe(project.name, 40)}` : 'New task';
  const inner = Math.max(10, width - 4);
  const text = composer.text || 'Describe an outcome, question, or next action…';
  const contentColor: ColorName = composer.text ? 'text' : 'muted';
  return [
    tone(`┌─ ${fit(label, inner - 3)} ${'─'.repeat(Math.max(0, inner - displayWidth(label) - 2))}┐`, 'cyan', color, true),
    `│ ${tone(fit(inline(text), inner), contentColor, color)} │`,
    `│ ${tone('Enter run  ·  Esc cancel  ·  Ctrl+U clear', 'muted', color)}${' '.repeat(Math.max(0, inner - 41))} │`,
    tone(`└${'─'.repeat(inner + 2)}┘`, 'cyan', color),
  ];
}

function renderConfirmation(
  state: TuiState,
  snapshot: TuiSnapshot,
  width: number,
  height: number,
  color: boolean,
): string[] {
  const confirmation = state.confirmation!;
  const approval = snapshot.approvals.find((item) => item.id === confirmation.approvalId);
  const approving = confirmation.decision === 'approve';
  const colorName: ColorName = approving ? 'amber' : 'red';
  const verb = approving ? 'APPROVE ONCE' : 'REJECT';
  const inner = Math.max(10, width - 4);
  if (!isApprovalViewportSafe({ columns: width, rows: height + 7 })) {
    return [
      tone(`┌─ ${fit(`${verb} · terminal too small`, inner - 3)} ${'─'.repeat(Math.max(0, inner - displayWidth(`${verb} · terminal too small`) - 2))}┐`, colorName, color, true),
      `│ ${tone(fit('Resize to at least 48 columns × 22 rows to inspect arguments.', inner), 'amber', color, true)} │`,
      tone(`└${'─'.repeat(inner + 2)}┘`, colorName, color),
    ];
  }
  const pages = approval ? approvalArgumentPages(approval.arguments) : ['Approval no longer exists'];
  const pageIndex = Math.max(0, Math.min(pages.length - 1, confirmation.page));
  const argumentLines = hardWrap(pages[pageIndex] ?? '', inner);
  const reviewed = confirmation.reviewedThrough >= pages.length - 1;
  const consequential = approval?.effect === 'external_write' || approval?.effect === 'destructive';
  const digestLines = hardWrap(
    approval?.argumentsDigest
      ? `DIGEST ${approval.argumentsDigest}`
      : approving
        ? 'DIGEST LEGACY-UNBOUND — APPROVAL IS FORBIDDEN'
        : 'DIGEST LEGACY-UNBOUND — REJECTION ONLY',
    inner,
  );
  const help = reviewed
    ? 'y/Enter confirm · k previous · n/Esc cancel'
    : 'j/Space next · k previous · review every page to confirm';
  return [
    tone(`┌─ ${fit(`${verb} · explicit confirmation`, inner - 3)} ${'─'.repeat(Math.max(0, inner - displayWidth(`${verb} · explicit confirmation`) - 2))}┐`, colorName, color, true),
    `│ ${tone(fit(approval ? `TOOL ${approval.toolName} · EFFECT ${approval.effect.toUpperCase()}` : 'MISSING APPROVAL', inner), 'amber', color, true)} │`,
    `│ ${tone(fit(approval ? `RUN ${shortId(approval.runId)} · ACTOR ${approval.actorId} · PROJECT ${approval.projectId ?? 'none'}` : 'No run context', inner), 'text', color)} │`,
    `│ ${tone(fit(approval ? `REQUEST ${approval.runInput}` : 'No request context', inner), 'text', color)} │`,
    `│ ${tone(fit(approval ? `POLICY ${approval.policyDecision.toUpperCase()} · SCOPE ONCE${consequential ? ' · MAY NOT BE REVERSIBLE' : ''}` : 'No policy context', inner), consequential ? 'red' : 'muted', color, consequential)} │`,
    ...digestLines.map((line) => `│ ${tone(fit(line, inner), approval?.argumentsDigest ? 'amber' : 'red', color, true)} │`),
    `│ ${tone(fit(`ARGUMENTS ${pageIndex + 1}/${pages.length}`, inner), 'amber', color, true)} │`,
    ...argumentLines.map((line) => `│ ${tone(fit(line, inner), 'text', color)} │`),
    `│ ${tone(fit(help, inner), 'muted', color)} │`,
    tone(`└${'─'.repeat(inner + 2)}┘`, colorName, color),
  ];
}

function renderHelp(state: TuiState, snapshot: TuiSnapshot, width: number, color: boolean): string {
  const pageHelp = state.page === 'approvals' && tuiCan(snapshot, 'approve')
    ? 'a approve · x reject · '
    : '';
  const approvalPaging = state.page === 'approvals'
    ? '[/]/PgUp/PgDn pages · '
    : '';
  const composeHelp = tuiCan(snapshot, 'run') ? 'c compose · ' : '';
  const content = `${pageHelp}${approvalPaging}${composeHelp}j/k move · Tab switch · r refresh · q quit`;
  return truncateAnsi(`${tone('KEYS', 'accent', color, true)}  ${tone(content, 'muted', color)}`, width);
}

function renderFooter(state: TuiState, snapshot: TuiSnapshot, width: number, color: boolean): string {
  let left = state.busy
    ? tone('[WORKING] Agent is processing locally…', 'amber', color, true)
    : tone(`[READY] workspace:${safe(snapshot.workspaceId, 30)}`, 'green', color, true);
  if (state.notice) left = notice(state.notice.tone, state.notice.message, color);
  const right = tone(`refreshed ${relativeTime(snapshot.generatedAt)}`, 'muted', color);
  return spread(left, right, width);
}

function notice(kind: TuiNoticeTone, message: string, color: boolean): string {
  const colorName: ColorName = kind === 'success'
    ? 'green'
    : kind === 'warning'
      ? 'amber'
      : kind === 'danger'
        ? 'red'
        : 'cyan';
  return tone(`[${kind.toUpperCase()}] ${safe(message, 100)}`, colorName, color, true);
}

function metric(label: string, value: string, colorName: ColorName, width: number, color: boolean): string {
  const plain = `${label} ${value}`;
  return tone(fit(plain, width), colorName, color, true);
}

function sectionTitle(titleText: string, detail: string, color: boolean): string {
  return `${tone(titleText.toUpperCase(), 'text', color, true)}  ${tone(`— ${safe(detail, 100)}`, 'muted', color)}`;
}

function tableHeader(width: number, labels: string[], fixed: number[], color: boolean): string {
  return row(width, ' ', labels.map((label) => tone(label, 'muted', color, true)), fixed);
}

function row(width: number, marker: string, cells: string[], fixed: number[]): string {
  const prefix = `${marker} `;
  let remaining = width - displayWidth(prefix) - Math.max(0, cells.length - 1) * 2;
  const pieces: string[] = [];
  for (let index = 0; index < cells.length; index += 1) {
    const requested = fixed[index];
    const cellWidth = requested ?? Math.max(1, remaining);
    const content = cells[index] ?? '';
    pieces.push(index === cells.length - 1 ? truncateAnsi(content, Math.max(1, remaining)) : padAnsi(content, Math.max(1, cellWidth)));
    remaining -= cellWidth;
  }
  return truncateAnsi(`${prefix}${pieces.join('  ')}`, width);
}

function approvalStatus(approval: TuiApproval, color: boolean): string {
  if (approval.status === 'pending') return tone('[PENDING]', 'amber', color, true);
  if (approval.status === 'approved') return tone('[APPROVED]', 'green', color, true);
  return tone('[REJECTED]', 'red', color, true);
}

function isSealed(snapshot: TuiSnapshot): boolean {
  return snapshot.privacy.localOnly
    && snapshot.privacy.allowedOrigins === 0
    && snapshot.privacy.telegramEnabled === false;
}

function runStatus(status: RunStatus, color: boolean): string {
  if (status === 'succeeded') return tone('[SUCCESS]', 'green', color, true);
  if (status === 'failed') return tone('[FAILED]', 'red', color, true);
  if (status === 'cancelled') return tone('[CANCELLED]', 'red', color);
  if (status === 'waiting_for_approval') return tone('[APPROVAL]', 'amber', color, true);
  if (status === 'running') return tone('[RUNNING]', 'cyan', color, true);
  return tone('[QUEUED]', 'muted', color, true);
}

function memoryStatus(memory: MemoryRecord, color: boolean): string {
  if (memory.status === 'active') return tone('[ACTIVE]', 'green', color, true);
  if (memory.status === 'proposed') return tone('[PROPOSED]', 'amber', color, true);
  return tone('[ARCHIVED]', 'muted', color);
}

function projectStatus(status: string, color: boolean): string {
  const normalized = safe(status, 20).toLocaleLowerCase();
  if (['active', 'on_track', 'in_progress'].includes(normalized)) return tone('[ACTIVE]', 'green', color, true);
  if (['blocked', 'at_risk', 'late'].includes(normalized)) return tone(`[${normalized.toUpperCase()}]`, 'red', color, true);
  if (['complete', 'completed', 'done'].includes(normalized)) return tone('[DONE]', 'cyan', color, true);
  return tone(`[${normalized.toUpperCase() || 'UNKNOWN'}]`, 'muted', color, true);
}

function visibleWindow<T>(items: T[], selected: number, height: number): Array<{ item: T; index: number }> {
  if (height <= 0) return [];
  const bounded = Math.max(0, Math.min(items.length - 1, selected));
  const start = Math.max(0, Math.min(bounded - Math.floor(height / 2), items.length - height));
  return items.slice(start, start + height).map((item, offset) => ({ item, index: start + offset }));
}

function emptyState(heading: string, hint: string, color: boolean): string {
  return `${tone(`[EMPTY] ${heading}`, 'muted', color, true)}  ${tone(hint, 'muted', color)}`;
}

function overlay(base: string[], modal: string[]): string[] {
  const result = [...base];
  const start = Math.max(0, result.length - modal.length);
  for (let index = 0; index < modal.length; index += 1) result[start + index] = modal[index]!;
  return result;
}

export function isApprovalViewportSafe(dimensions: TuiDimensions): boolean {
  return dimensions.columns >= 48 && dimensions.rows >= 22;
}

function hardWrap(value: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (const character of sanitizeTerminalText(value, 4_000)) {
    if (character === '\n') {
      lines.push(current);
      current = '';
      currentWidth = 0;
      continue;
    }
    const characterWidth = codePointWidth(character.codePointAt(0)!, character);
    if (current && currentWidth + characterWidth > width) {
      lines.push(current);
      current = '';
      currentWidth = 0;
    }
    current += character;
    currentWidth += characterWidth;
  }
  lines.push(current);
  return lines;
}

function rule(width: number, color: boolean): string {
  return tone('─'.repeat(width), 'muted', color);
}

function paintLine(line: string, width: number, color: boolean): string {
  const fitted = padAnsi(truncateAnsi(line, width), width);
  return color ? `${BACKGROUND}${fitted}${RESET}` : fitted;
}

function tone(value: string, colorName: ColorName, enabled: boolean, bold = false): string {
  const inert = sanitizeTerminalText(value);
  if (!enabled) return inert;
  const weight = bold ? '1;' : '';
  return `\u001b[${weight}${FOREGROUND[colorName]}m${inert}\u001b[39;22m`;
}

function spread(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - displayWidth(left) - displayWidth(right));
  return truncateAnsi(`${left}${' '.repeat(gap)}${right}`, width);
}

function padAnsi(value: string, width: number): string {
  const clipped = truncateAnsi(value, width);
  return `${clipped}${' '.repeat(Math.max(0, width - displayWidth(clipped)))}`;
}

function truncateAnsi(value: string, width: number): string {
  if (width <= 0) return '';
  let output = '';
  let used = 0;
  for (let index = 0; index < value.length;) {
    if (value[index] === '\u001b') {
      const match = value.slice(index).match(/^\u001b\[[0-?]*[ -/]*[@-~]/u);
      if (match) {
        output += match[0];
        index += match[0].length;
        continue;
      }
    }
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const characterWidth = codePointWidth(codePoint, character);
    if (used + characterWidth > width) break;
    output += character;
    used += characterWidth;
    index += character.length;
  }
  return output;
}

function displayWidth(value: string): number {
  const plain = value.replace(ESCAPE_SEQUENCE, '');
  let width = 0;
  for (const character of plain) {
    const codePoint = character.codePointAt(0)!;
    width += codePointWidth(codePoint, character);
  }
  return width;
}

function codePointWidth(codePoint: number, character: string): number {
  if (/\p{Mark}/u.test(character)) return 0;
  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) return 2;
  return 1;
}

function fit(value: string, width: number): string {
  const plain = safe(value, Math.max(100, width * 4));
  if (displayWidth(plain) <= width) return `${plain}${' '.repeat(width - displayWidth(plain))}`;
  if (width <= 1) return '…'.slice(0, width);
  return `${truncateAnsi(plain, width - 1)}…`;
}

function safe(value: unknown, maximum: number): string {
  return sanitizeTerminalText(value, maximum).replace(/[\n\t]+/gu, ' ').trim();
}

function inline(value: unknown): string {
  return safe(value, 500);
}

function shortId(value: string): string {
  return safe(value, 16).slice(0, 8);
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return safe(value, 12);
  return date.toISOString().slice(0, 10);
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return safe(value, 16);
  const delta = Date.now() - timestamp;
  const absolute = Math.abs(delta);
  const suffix = delta >= 0 ? 'ago' : 'from now';
  if (absolute < 60_000) return 'just now';
  if (absolute < 3_600_000) return `${Math.floor(absolute / 60_000)}m ${suffix}`;
  if (absolute < 86_400_000) return `${Math.floor(absolute / 3_600_000)}h ${suffix}`;
  return `${Math.floor(absolute / 86_400_000)}d ${suffix}`;
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

function title(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

import { timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { OpenProjectsApp } from './app.js';
import type { ApprovalRecord, JsonObject } from './core/types.js';

const TELEGRAM_REQUEST_TIMEOUT_MS = 30_000;
const TELEGRAM_JSON_MAX_BYTES = 1_000_000;
const TELEGRAM_MESSAGE_MAX_CHARACTERS = 4_096;
const APPROVAL_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

interface TelegramUser {
  id?: number | string;
  is_bot?: boolean;
  username?: string;
}

interface TelegramChat {
  id?: number | string;
  type?: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
}

interface TelegramAudio {
  file_id?: string;
  file_size?: number;
  duration?: number;
  mime_type?: string;
}

interface TelegramMessage {
  message_id?: number;
  date?: number;
  text?: string;
  caption?: string;
  chat?: TelegramChat;
  from?: TelegramUser;
  voice?: TelegramAudio;
  audio?: TelegramAudio;
  reply_to_message?: { from?: TelegramUser };
}

export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: {
    id?: string;
    data?: string;
    from?: TelegramUser;
    message?: { chat?: TelegramChat };
  };
}

interface TelegramApiEnvelope<T> {
  ok?: boolean;
  result?: T;
  description?: string;
}

interface BotIdentity {
  id?: string;
  username?: string;
}

interface TelegramCommand {
  name: string;
  argument: string;
  botUsername?: string;
}

export class TelegramAdapter {
  readonly #token: string;
  readonly #secret: string;
  readonly #apiBaseUrl: string;
  readonly #allowedUserIds: ReadonlySet<string>;
  readonly #shutdown = new AbortController();
  #identity?: Promise<BotIdentity>;

  constructor(private readonly app: OpenProjectsApp) {
    this.#token = process.env.TELEGRAM_BOT_TOKEN ?? '';
    this.#secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
    this.#apiBaseUrl = telegramApiBaseUrl(
      process.env.TELEGRAM_API_BASE_URL
        ?? app.config.telegram?.apiBaseUrl
        ?? 'https://api.telegram.org',
    );
    this.#allowedUserIds = telegramUserIdAllowlist(process.env.TELEGRAM_ALLOWED_USER_IDS);
    if (app.config.telegram?.enabled === true) {
      app.networkPolicy.assertAllowed(this.#apiBaseUrl, 'Telegram API');
    }
  }

  get enabled(): boolean {
    return this.app.config.telegram?.enabled === true && Boolean(this.#token && this.#secret);
  }

  close(): void {
    this.#shutdown.abort(new Error('OpenProjects Telegram adapter is shutting down'));
  }

  authenticates(headerSecret: string | undefined): boolean {
    // Telegram's setWebhook secret_token arrives only in this header. Keeping
    // the credential out of the URL avoids leaking it through proxy access
    // logs, browser histories, or route metrics.
    return this.enabled && secureEqual(headerSecret ?? '', this.#secret);
  }

  async handle(update: TelegramUpdate): Promise<void> {
    const updateId = update.update_id;
    if (typeof updateId !== 'number') return;
    const message = update.message;
    const callback = update.callback_query;
    const actorId = telegramActor(update);
    const recorded = this.app.storage.recordInboundEvent({
      source: 'telegram',
      dedupeKey: String(updateId),
      type: callback ? 'callback_query' : 'message',
      workspaceId: 'local',
      actorId,
      payload: sanitizedUpdateMetadata(update),
      occurredAt: message?.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString(),
    });
    if (recorded.duplicate) return;
    if (callback) {
      await this.handleCallback(callback);
      return;
    }
    if (!message || message.chat?.id === undefined || message.from?.is_bot) return;
    await this.handleMessage(updateId, recorded.id, message);
  }

  async sendNotification(destination: string, body: string, signal?: AbortSignal): Promise<void> {
    await this.sendMessage(destination, body, undefined, signal);
  }

  private async handleMessage(updateId: number, inboundId: string, message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat?.id);
    const fromId = message.from?.id;
    if (fromId === undefined) return;
    const actorId = `telegram-user:${fromId}`;
    const group = message.chat?.type === 'group' || message.chat?.type === 'supergroup';
    const rawText = (message.text ?? message.caption ?? '').trim();
    const command = parseCommand(rawText);
    if (command?.botUsername && !(await this.commandTargetsThisBot(command.botUsername))) return;
    if (!group && !this.isAllowedOperator(fromId)) return;

    if (group && command?.name === 'openprojects_enable') {
      await this.enableGroup(message, actorId, command.argument);
      return;
    }
    if (group && command?.name === 'openprojects_disable') {
      await this.disableGroup(message);
      return;
    }
    if (command?.name === 'openprojects_privacy') {
      await this.sendPrivacyNotice(chatId, group);
      return;
    }

    const binding = group ? this.app.storage.findGroupSpace('telegram', chatId) : undefined;
    const observationEnabled = Boolean(
      binding?.learningEnabled
      && this.app.config.learning?.enabled !== false
      && this.app.config.learning?.groupObservation !== false,
    );
    if (group && !binding?.learningEnabled) return;

    let text = rawText;
    let transcript = false;
    if (!text && (message.voice ?? message.audio)) {
      try {
        text = await this.transcribe(message.voice ?? message.audio!);
        transcript = true;
      } catch (error) {
        await this.sendMessage(chatId, `Local transcription failed: ${safeMessage(error)}`);
        return;
      }
    }
    if (!text) return;

    if (group && binding && observationEnabled) {
      const observationText = command?.name === 'remember' && command.argument
        ? `Remember: ${command.argument}`
        : text;
      const observed = await this.app.memoryEngine.observeGroupMessage({
        groupSpaceId: binding.id,
        externalMessageId: String(message.message_id ?? updateId),
        actorId,
        text: observationText,
        transcript,
        ...(message.date ? { occurredAt: new Date(message.date * 1000).toISOString() } : {}),
      });
      if (command?.name === 'remember' && observed.memory) {
        if (!this.isAllowedOperator(fromId) || !(await this.isAdministrator(chatId, String(fromId)))) {
          await this.sendMessage(chatId, 'Only an allowed OpenProjects operator who is also a group administrator can confirm a shared memory. The candidate remains proposed.');
          return;
        }
        const activated = await this.app.memoryEngine.setStatus(
          observed.memory.id,
          binding.workspaceId,
          'active',
        );
        await this.sendMessage(
          chatId,
          activated.embedding === 'failed'
            ? `Remembered with provenance (${observed.memory.id}); semantic indexing failed, so lexical retrieval remains available.`
            : `Remembered with provenance (${observed.memory.id}).`,
        );
        return;
      }
    }

    const shouldRun = !group || isExplicitRunCommand(command) || await this.isMentionOrReply(message, text);
    if (!shouldRun) return;
    const prompt = command?.name === 'op'
      ? command.argument || 'Report current project status and deadlines.'
      : command?.name === 'openprojects_status'
        ? 'Report current project status, blockers, and upcoming deadlines.'
        : transcript
          ? `Locally transcribed voice message (untrusted source text):\n${text}`
          : await this.removeBotMention(text);
    const projectId = binding?.projectId;
    try {
      const outcome = await this.app.runtime.start({
        message: prompt,
        workspaceId: binding?.workspaceId ?? 'local',
        actorId,
        ...(projectId ? { projectId } : {}),
        channel: 'telegram',
        externalSessionId: group ? `${chatId}:${fromId}` : chatId,
        metadata: {
          telegramUpdateId: updateId,
          telegramMessageId: message.message_id ?? null,
          telegramChatId: chatId,
          telegramGroup: group,
          transcript,
        },
      });
      this.app.storage.attachInboundRun(inboundId, outcome.run.id);
      await this.sendOutcome(chatId, outcome.run.id);
    } catch (error) {
      await this.sendMessage(chatId, `OpenProjects error: ${safeMessage(error)}`);
    }
  }

  private async enableGroup(message: TelegramMessage, actorId: string, projectArgument: string): Promise<void> {
    const chatId = String(message.chat?.id);
    const fromId = message.from?.id;
    if (fromId === undefined || !this.isAllowedOperator(fromId)) return;
    if (!(await this.isAdministrator(chatId, String(fromId)))) {
      await this.sendMessage(chatId, 'A Telegram group administrator must enable observation.');
      return;
    }
    if (this.app.config.learning?.enabled === false || this.app.config.learning?.groupObservation === false) {
      await this.sendMessage(chatId, 'Group learning is disabled by the local OpenProjects configuration.');
      return;
    }
    const projectId = projectArgument.trim() || 'project-atlas';
    const project = this.app.storage.getProject(projectId, 'local');
    if (!project) {
      await this.sendMessage(chatId, `Unknown project ${projectId}. Use a project ID from the OpenProjects dashboard.`);
      return;
    }
    this.app.storage.upsertGroupSpace({
      workspaceId: 'local',
      source: 'telegram',
      externalId: chatId,
      ...(message.chat?.title ? { title: message.chat.title } : {}),
      projectId,
      learningEnabled: true,
      notificationsEnabled: true,
      createdBy: actorId,
    });
    await this.sendMessage(
      chatId,
      `OpenProjects is enabled for ${project.name}. I will locally observe messages for commitments, blockers, decisions, and deadlines; passive messages do not call an LLM. Inferred memories stay proposed until confirmed. Fixed deadline reminders are enabled. Use /openprojects_disable to stop observation.`,
    );
  }

  private async disableGroup(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat?.id);
    const fromId = message.from?.id;
    if (fromId === undefined || !this.isAllowedOperator(fromId)) return;
    if (!(await this.isAdministrator(chatId, String(fromId)))) {
      await this.sendMessage(chatId, 'A Telegram group administrator must disable observation.');
      return;
    }
    this.app.storage.disableGroupSpace('telegram', chatId);
    await this.sendMessage(chatId, 'OpenProjects group observation and deadline notifications are disabled. Existing retained data can be deleted from the local operator API.');
  }

  private async sendPrivacyNotice(chatId: string, group: boolean): Promise<void> {
    const retention = this.app.config.learning?.retentionDays ?? 180;
    await this.sendMessage(
      chatId,
      group
        ? `Privacy: processing after receipt is local to this OpenProjects deployment. Telegram still transports the messages unless your organization operates the configured gateway. Passive messages never trigger an LLM. Salient text and local transcripts may be retained for ${retention} days with source provenance; inferred memories are proposed. Secrets are redacted heuristically. Use /openprojects_disable to stop collection.`
        : 'Privacy: direct messages are processed by a model endpoint permitted by the deployment egress policy. Telegram still transports the messages unless your organization operates the configured gateway. Voice is transcribed locally when whisper.cpp is enabled. Do not send secrets.',
    );
  }

  private async handleCallback(callback: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const chatId = callback.message?.chat?.id;
    const fromId = callback.from?.id;
    const callbackId = callback.id;
    const data = callback.data ?? '';
    if (chatId === undefined || fromId === undefined || !callbackId) return;
    const actorId = `telegram-user:${fromId}`;
    const parts = data.split(':');
    try {
      if (
        parts[0] === 'ap'
        && parts.length === 4
        && (parts[1] === 'y' || parts[1] === 'n')
        && parts[2]
        && parts[3]
      ) {
        const group = callback.message?.chat?.type === 'group' || callback.message?.chat?.type === 'supergroup';
        const authorized = this.isAllowedOperator(fromId)
          && (!group || await this.isAdministrator(String(chatId), String(fromId)));
        if (!authorized) {
          await this.answerCallback(callbackId, 'Only an allowed OpenProjects operator can resolve approvals');
          return;
        }
        const approvalId = expandApprovalId(parts[2]);
        const approval = this.app.storage.getApproval(approvalId);
        const expectedToken = approval.argumentsDigest
          ? approvalDigestToken(approval.argumentsDigest)
          : 'legacy';
        if (!expectedToken || !secureEqual(parts[3], expectedToken)) {
          await this.answerCallback(callbackId, 'Approval arguments changed; reopen the approval');
          return;
        }
        const decision = parts[1] === 'y' ? 'approve' : 'reject';
        if (decision === 'approve' && approval.argumentsDigest === undefined) {
          await this.answerCallback(callbackId, 'Legacy unbound approvals cannot be approved');
          return;
        }
        const outcome = await this.app.runtime.resolveApproval(
          approvalId,
          decision,
          actorId,
          undefined,
          { trustedOperator: true },
          approval.argumentsDigest,
        );
        await this.answerCallback(callbackId, decision === 'approve' ? 'Approved' : 'Rejected');
        await this.sendOutcome(String(chatId), outcome.run.id);
        return;
      }
      if (parts[0] === 'fb' && parts.length === 3 && parts[1] && parts[2]) {
        if (this.app.storage.listFeedback(parts[1]).some((feedback) => feedback.actorId === actorId)) {
          await this.answerCallback(callbackId, 'Feedback already recorded');
          return;
        }
        this.app.runtime.addFeedback(parts[1], { actorId, reaction: parts[2] });
        await this.answerCallback(callbackId, 'Feedback saved; retrieval and route reward updated');
        return;
      }
      await this.answerCallback(callbackId, 'Unknown action');
    } catch (error) {
      await this.answerCallback(callbackId, safeMessage(error).slice(0, 180));
    }
  }

  private async transcribe(audio: TelegramAudio): Promise<string> {
    if (this.app.transcriber.id === 'disabled') throw new Error('local whisper.cpp is not configured');
    if (!audio.file_id) throw new Error('Telegram audio has no file ID');
    const maximum = this.app.config.transcription?.maxBytes ?? 25_000_000;
    const maximumDuration = this.app.config.transcription?.maxDurationSeconds ?? 1_200;
    if (typeof audio.duration === 'number' && audio.duration > maximumDuration) {
      throw new Error(`audio exceeds the ${maximumDuration} second limit`);
    }
    if (typeof audio.file_size === 'number' && audio.file_size > maximum) throw new Error(`audio exceeds the ${maximum} byte limit`);
    if (audio.mime_type && !audio.mime_type.startsWith('audio/')) throw new Error('unsupported audio MIME type');
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: audio.file_id });
    if (!file.file_path) throw new Error('Telegram did not return an audio path');
    if (typeof file.file_size === 'number' && file.file_size > maximum) throw new Error('audio exceeds the configured limit');
    const fileUrl = `${this.#apiBaseUrl}/file/bot${this.#token}/${file.file_path}`;
    this.app.networkPolicy.assertAllowed(fileUrl, 'Telegram file download');
    const response = await fetch(fileUrl, {
      redirect: 'error',
      signal: this.requestSignal(Math.min(this.app.config.transcription?.timeoutMs ?? 180_000, 60_000)),
    });
    if (!response.ok) throw new Error(`Telegram audio download failed (${response.status})`);
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maximum) throw new Error('audio exceeds the configured limit');
    const bytes = Buffer.from(await readBoundedResponse(response, maximum, 'Telegram audio'));
    const directory = await mkdtemp(join(tmpdir(), 'openprojects-telegram-'));
    const inputPath = join(directory, 'source-audio');
    try {
      await writeFile(inputPath, bytes, { mode: 0o600 });
      return (await this.app.transcriber.transcribe(inputPath)).text;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async isMentionOrReply(message: TelegramMessage, text: string): Promise<boolean> {
    const identity = await this.botIdentity();
    const replyId = message.reply_to_message?.from?.id;
    if (identity.id && replyId !== undefined && String(replyId) === identity.id) return true;
    return Boolean(identity.username && text.toLocaleLowerCase().includes(`@${identity.username.toLocaleLowerCase()}`));
  }

  private async removeBotMention(text: string): Promise<string> {
    const username = (await this.botIdentity()).username;
    if (!username) return text;
    return text.replace(new RegExp(`@${escapeRegex(username)}\\b`, 'giu'), '').trim();
  }

  private botIdentity(): Promise<BotIdentity> {
    const configured = process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/u, '');
    this.#identity ??= configured
      ? Promise.resolve({ username: configured })
      : this.call<TelegramUser>('getMe', {}).then((user) => ({
          ...(user.id !== undefined ? { id: String(user.id) } : {}),
          ...(user.username ? { username: user.username } : {}),
        })).catch(() => ({}));
    return this.#identity;
  }

  private async commandTargetsThisBot(username: string): Promise<boolean> {
    const identity = await this.botIdentity();
    return Boolean(
      identity.username &&
      identity.username.toLocaleLowerCase('en-US') === username.toLocaleLowerCase('en-US'),
    );
  }

  private isAllowedOperator(userId: number | string): boolean {
    const normalized = normalizeTelegramUserId(userId);
    return normalized !== undefined && this.#allowedUserIds.has(normalized);
  }

  private async isAdministrator(chatId: string, userId: string): Promise<boolean> {
    const result = await this.call<{ status?: string }>('getChatMember', { chat_id: chatId, user_id: userId }).catch(() => undefined);
    return result?.status === 'creator' || result?.status === 'administrator';
  }

  private async sendOutcome(chatId: string, runId: string): Promise<void> {
    const outcome = this.app.runtime.outcome(runId);
    if (outcome.run.status === 'waiting_for_approval') {
      for (const approval of outcome.approvals.filter((item) => item.status === 'pending')) {
        const presentation = telegramApprovalPresentation(approval);
        await this.sendMessage(chatId, presentation.text, presentation.replyMarkup);
      }
      return;
    }
    const output = outcome.run.output ?? outcome.run.error ?? `Run ${outcome.run.status}`;
    await this.sendMessage(chatId, output, {
      inline_keyboard: [[
        { text: '👍', callback_data: `fb:${runId}:up` },
        { text: '😂', callback_data: `fb:${runId}:laugh` },
        { text: '❤️', callback_data: `fb:${runId}:heart` },
        { text: '👎', callback_data: `fb:${runId}:down` },
      ]],
    });
  }

  private async sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: JsonObject,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chatId,
      text: text.slice(0, 4096),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }, signal);
  }

  private async answerCallback(callbackQueryId: string, text: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text.slice(0, 200) });
  }

  private async call<T = JsonObject>(method: string, body: JsonObject, signal?: AbortSignal): Promise<T> {
    const apiUrl = `${this.#apiBaseUrl}/bot${this.#token}/${method}`;
    this.app.networkPolicy.assertAllowed(apiUrl, `Telegram ${method}`);
    const response = await fetch(apiUrl, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.requestSignal(TELEGRAM_REQUEST_TIMEOUT_MS, signal),
    });
    const raw = await readBoundedResponse(response, TELEGRAM_JSON_MAX_BYTES, `Telegram ${method}`);
    let envelope: TelegramApiEnvelope<T> | undefined;
    try {
      envelope = JSON.parse(new TextDecoder().decode(raw)) as TelegramApiEnvelope<T>;
    } catch {
      envelope = undefined;
    }
    if (!response.ok || !envelope?.ok || envelope.result === undefined) {
      throw new Error(`Telegram ${method} failed (${response.status}): ${envelope?.description?.slice(0, 240) ?? 'unknown error'}`);
    }
    return envelope.result;
  }

  private requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([
      this.#shutdown.signal,
      AbortSignal.timeout(timeoutMs),
      ...(signal ? [signal] : []),
    ]);
  }
}

async function readBoundedResponse(response: Response, maximum: number, label: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw new Error(`${label} exceeds the configured limit`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maximum) {
      await reader.cancel(`${label} exceeds the configured limit`);
      throw new Error(`${label} exceeds the configured limit`);
    }
    chunks.push(chunk.value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function telegramActor(update: TelegramUpdate): string {
  const fromId = update.message?.from?.id ?? update.callback_query?.from?.id;
  return fromId === undefined ? 'telegram-user:unknown' : `telegram-user:${fromId}`;
}

function telegramApprovalPresentation(approval: ApprovalRecord): {
  text: string;
  replyMarkup?: JsonObject;
} {
  const digest = approval.argumentsDigest;
  const fullReview = digest
    ? `Approval required for ${approval.toolName}:\nArguments digest: ${digest}\nCanonical arguments:\n${approval.arguments}`
    : `Legacy approval for ${approval.toolName} has no bound argument digest and cannot be approved. It may only be rejected.\nArguments:\n${approval.arguments}`;
  if (fullReview.length > TELEGRAM_MESSAGE_MAX_CHARACTERS) {
    return {
      text: [
        `Approval for ${approval.toolName} requires local review.`,
        `Arguments digest: ${digest ?? 'LEGACY-UNBOUND'}`,
        `Canonical arguments contain ${approval.arguments.length} characters and do not fit in one complete Telegram review message.`,
        'No Approve action is available here. Review every argument page in the local TUI or authenticated control API.',
      ].join('\n'),
    };
  }
  const reject = approvalCallbackButton(approval, 'reject');
  const approve = digest ? approvalCallbackButton(approval, 'approve') : undefined;
  const buttons = [approve, reject].filter((button): button is JsonObject => button !== undefined);
  return {
    text: fullReview,
    ...(buttons.length ? { replyMarkup: { inline_keyboard: [buttons] } } : {}),
  };
}

function approvalCallbackButton(
  approval: ApprovalRecord,
  decision: 'approve' | 'reject',
): JsonObject | undefined {
  const id = compactApprovalId(approval.id);
  const digest = approval.argumentsDigest ? approvalDigestToken(approval.argumentsDigest) : 'legacy';
  if (!id || !digest || (decision === 'approve' && approval.argumentsDigest === undefined)) return undefined;
  const callbackData = `ap:${decision === 'approve' ? 'y' : 'n'}:${id}:${digest}`;
  if (Buffer.byteLength(callbackData, 'utf8') > 64) return undefined;
  return {
    text: decision === 'approve' ? 'Approve once' : 'Reject',
    callback_data: callbackData,
  };
}

function approvalDigestToken(digest: string): string | undefined {
  if (!APPROVAL_DIGEST_PATTERN.test(digest)) return undefined;
  return Buffer.from(digest.slice('sha256:'.length, 'sha256:'.length + 32), 'hex').toString('base64url');
}

function compactApprovalId(id: string): string | undefined {
  if (!UUID_PATTERN.test(id)) return undefined;
  return Buffer.from(id.replaceAll('-', ''), 'hex').toString('base64url');
}

function expandApprovalId(compact: string): string {
  if (!/^[A-Za-z0-9_-]{22}$/u.test(compact)) throw new Error('Invalid compact approval ID');
  const bytes = Buffer.from(compact, 'base64url');
  if (bytes.length !== 16 || bytes.toString('base64url') !== compact) throw new Error('Invalid compact approval ID');
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sanitizedUpdateMetadata(update: TelegramUpdate): JsonObject {
  const message = update.message;
  const callback = update.callback_query;
  return {
    updateId: update.update_id ?? null,
    messageId: message?.message_id ?? null,
    chatId: message?.chat?.id !== undefined ? String(message.chat.id) : callback?.message?.chat?.id !== undefined ? String(callback.message.chat.id) : null,
    chatType: message?.chat?.type ?? callback?.message?.chat?.type ?? null,
    fromId: message?.from?.id !== undefined ? String(message.from.id) : callback?.from?.id !== undefined ? String(callback.from.id) : null,
    content: message?.voice ? 'voice' : message?.audio ? 'audio' : message?.text ? 'text' : callback ? 'callback' : 'other',
  };
}

function parseCommand(text: string): TelegramCommand | undefined {
  const match = text.match(/^\/([a-z_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/iu);
  if (!match?.[1]) return undefined;
  return {
    name: match[1].toLocaleLowerCase(),
    argument: match[3]?.trim() ?? '',
    ...(match[2] ? { botUsername: match[2] } : {}),
  };
}

function isExplicitRunCommand(command: ReturnType<typeof parseCommand>): boolean {
  return command?.name === 'op' || command?.name === 'openprojects_status';
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/bot\d+:[A-Za-z0-9_-]+/gu, 'bot[REDACTED]').slice(0, 300);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function telegramUserIdAllowlist(value: string | undefined): ReadonlySet<string> {
  if (!value) return new Set();
  const ids = value
    .split(',')
    .map((entry) => normalizeTelegramUserId(entry))
    .filter((entry): entry is string => entry !== undefined);
  return new Set(ids);
}

function normalizeTelegramUserId(value: number | string): string | undefined {
  const text = String(value).trim();
  if (!/^\d+$/u.test(text)) return undefined;
  try {
    const id = BigInt(text);
    return id > 0n ? id.toString() : undefined;
  } catch {
    return undefined;
  }
}

function telegramApiBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/u, '');
  if (!normalized) throw new Error('telegram.apiBaseUrl must not be empty');
  return normalized;
}

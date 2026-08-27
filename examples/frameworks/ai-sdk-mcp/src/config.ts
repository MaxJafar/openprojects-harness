import { isIP } from 'node:net';

export const MAX_QUESTION_BYTES = 4_096;
export const MCP_TOOL_NAME = 'openprojects_analyze_project';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]+=*$/u;

export interface BridgeCredential {
  authorizationHeader(): string;
}

export interface OpenProjectsBridgeConfig {
  readonly baseUrl: string;
  readonly credential: BridgeCredential;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly requestTimeoutMs: number;
  readonly runTimeoutMs: number;
  readonly pollIntervalMs: number;
}

export interface LocalModelConfig {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey?: string;
}

export function bridgeConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): OpenProjectsBridgeConfig {
  const token = requiredEnvironment(environment, 'OPENPROJECTS_CONTROL_TOKEN');
  if (token.length < 32 || token.length > 512 || !TOKEN_PATTERN.test(token)) {
    throw new Error('OPENPROJECTS_CONTROL_TOKEN must be a valid 32-512 character Bearer token');
  }

  const credential = Object.freeze({
    authorizationHeader(): string {
      return `Bearer ${token}`;
    },
  });

  return validateBridgeConfig({
    baseUrl: normalizeLoopbackBaseUrl(
      requiredEnvironment(environment, 'OPENPROJECTS_BASE_URL'),
      { rootPathOnly: true },
    ),
    credential,
    principalId: safeIdentifier(
      requiredEnvironment(environment, 'OPENPROJECTS_PRINCIPAL_ID'),
      'OPENPROJECTS_PRINCIPAL_ID',
    ),
    workspaceId: safeIdentifier(
      requiredEnvironment(environment, 'OPENPROJECTS_WORKSPACE_ID'),
      'OPENPROJECTS_WORKSPACE_ID',
    ),
    projectId: safeIdentifier(
      requiredEnvironment(environment, 'OPENPROJECTS_PROJECT_ID'),
      'OPENPROJECTS_PROJECT_ID',
    ),
    requestTimeoutMs: boundedIntegerEnvironment(
      environment,
      'OPENPROJECTS_REQUEST_TIMEOUT_MS',
      10_000,
      250,
      30_000,
    ),
    runTimeoutMs: boundedIntegerEnvironment(
      environment,
      'OPENPROJECTS_RUN_TIMEOUT_MS',
      45_000,
      1_000,
      120_000,
    ),
    pollIntervalMs: boundedIntegerEnvironment(
      environment,
      'OPENPROJECTS_POLL_INTERVAL_MS',
      250,
      25,
      2_000,
    ),
  });
}

export function validateBridgeConfig(config: OpenProjectsBridgeConfig): OpenProjectsBridgeConfig {
  if (typeof config !== 'object' || config === null) {
    throw new TypeError('OpenProjects bridge config must be an object');
  }
  if (
    typeof config.credential !== 'object'
    || config.credential === null
    || typeof config.credential.authorizationHeader !== 'function'
  ) {
    throw new Error('OpenProjects bridge credential must provide authorizationHeader()');
  }
  const authorizationHeader = config.credential.authorizationHeader.bind(config.credential);
  return Object.freeze({
    baseUrl: normalizeLoopbackBaseUrl(config.baseUrl, { rootPathOnly: true }),
    credential: Object.freeze({ authorizationHeader: () => authorizationHeader() }),
    principalId: safeIdentifier(config.principalId, 'principalId'),
    workspaceId: safeIdentifier(config.workspaceId, 'workspaceId'),
    projectId: safeIdentifier(config.projectId, 'projectId'),
    requestTimeoutMs: boundedInteger(config.requestTimeoutMs, 'requestTimeoutMs', 250, 30_000),
    runTimeoutMs: boundedInteger(config.runTimeoutMs, 'runTimeoutMs', 1_000, 120_000),
    pollIntervalMs: boundedInteger(config.pollIntervalMs, 'pollIntervalMs', 25, 2_000),
  });
}

export function bridgeChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  // Validate every value before copying the minimal set into the MCP child.
  bridgeConfigFromEnvironment(environment);
  const names = [
    'OPENPROJECTS_BASE_URL',
    'OPENPROJECTS_CONTROL_TOKEN',
    'OPENPROJECTS_PRINCIPAL_ID',
    'OPENPROJECTS_WORKSPACE_ID',
    'OPENPROJECTS_PROJECT_ID',
    'OPENPROJECTS_REQUEST_TIMEOUT_MS',
    'OPENPROJECTS_RUN_TIMEOUT_MS',
    'OPENPROJECTS_POLL_INTERVAL_MS',
  ] as const;
  return Object.fromEntries(names.flatMap((name) => {
    const value = environment[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

export function localModelConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): LocalModelConfig {
  const apiKey = environment.LOCAL_MODEL_API_KEY?.trim();
  if (apiKey !== undefined && (apiKey.length < 1 || byteLength(apiKey) > 4_096)) {
    throw new Error('LOCAL_MODEL_API_KEY must contain 1-4096 UTF-8 bytes when configured');
  }
  return Object.freeze({
    baseUrl: normalizeLoopbackBaseUrl(
      environment.LOCAL_MODEL_BASE_URL?.trim() || 'http://127.0.0.1:11434/v1',
      { rootPathOnly: false },
    ),
    modelId: boundedText(
      requiredEnvironment(environment, 'LOCAL_MODEL_ID'),
      'LOCAL_MODEL_ID',
      256,
    ),
    ...(apiKey ? { apiKey } : {}),
  });
}

export function validateQuestion(question: string): string {
  if (typeof question !== 'string') throw new TypeError('question must be a string');
  const normalized = question.trim();
  const size = byteLength(normalized);
  if (size < 1 || size > MAX_QUESTION_BYTES) {
    throw new Error(`question must contain 1-${MAX_QUESTION_BYTES} UTF-8 bytes`);
  }
  if (/\u0000/u.test(normalized)) throw new Error('question must not contain NUL characters');
  return normalized;
}

export function normalizeLoopbackBaseUrl(
  value: string | URL,
  options: { rootPathOnly: boolean },
): string {
  const parsed = value instanceof URL ? new URL(value) : new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('base URL must use HTTP or HTTPS');
  }
  if (!isLoopbackHostname(parsed.hostname)) throw new Error('base URL must target loopback');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('base URL must not include credentials, query parameters, or a fragment');
  }
  if (options.rootPathOnly && parsed.pathname !== '/') {
    throw new Error('OpenProjects base URL must not include a path');
  }
  parsed.pathname = options.rootPathOnly ? '/' : parsed.pathname.replace(/\/+$/u, '') || '/';
  return options.rootPathOnly ? parsed.origin : parsed.href.replace(/\/$/u, '');
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  return isIP(normalized) === 4 && normalized.split('.')[0] === '127';
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeIdentifier(value: string, name: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${name} must be a safe 1-128 character identifier`);
  }
  return value;
}

function boundedText(value: string, name: string, maximumBytes: number): string {
  if (byteLength(value) < 1 || byteLength(value) > maximumBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} must contain 1-${maximumBytes} safe UTF-8 bytes`);
  }
  return value;
}

function boundedIntegerEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/u.test(raw)) throw new Error(`${name} must be an integer`);
  return boundedInteger(Number(raw), name, minimum, maximum);
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

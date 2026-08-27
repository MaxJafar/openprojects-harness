import type { AppConfig } from '../core/types.js';

export type WizardProfile = 'private-local' | 'hybrid';
export type ModelBackend = 'mlx-lm' | 'ollama' | 'llama-cpp' | 'openai-compatible';
export type HardwareAcceleration = 'apple-silicon' | 'cpu' | 'unknown';

export interface HardwareInfo {
  platform: NodeJS.Platform;
  architecture: string;
  logicalCpuCount: number;
  cpuModel: string;
  memoryBytes: number;
  memoryGiB: number;
  acceleration: HardwareAcceleration;
}

export interface ModelRecommendation {
  model: string;
  parameterClass: string;
  minimumMemoryGiB: number;
  contextWindow: number;
  rationale: string;
}

export interface WizardPaths {
  config: string;
  database: string;
  controlToken: string;
  controlSocket: string;
  mlxModel: string;
  llamaModel: string;
  whisperCommand: string;
  whisperModel: string;
  ffmpegCommand: string;
}

export interface WizardAnswers {
  profile: WizardProfile;
  backend: ModelBackend;
  configPath: string;
  databasePath: string;
  controlTokenPath: string;
  /** POSIX private-control endpoint; omitted for the TCP compatibility profile. */
  controlSocketPath?: string;
  model: string;
  baseUrl: string;
  contextWindow: number;
  apiKeyEnv?: string;
  mlxModelPath?: string;
  llamaModelPath?: string;
  telegramEnabled: boolean;
  transcriptionEnabled: boolean;
  whisperCommand: string;
  whisperModelPath: string;
  ffmpegCommand: string;
}

export interface WizardPlan {
  profile: WizardProfile;
  backend: ModelBackend;
  configPath: string;
  config: AppConfig;
  yaml: string;
  hardware: HardwareInfo;
  recommendation: ModelRecommendation;
  warnings: string[];
  nextSteps: string[];
  /** The wizard never performs these actions; they are shown for the operator to run manually. */
  manualActions: string[];
}

export interface SelectChoice {
  value: string;
  label: string;
  description: string;
  recommended?: boolean;
}

export interface SelectPrompt {
  id: string;
  message: string;
  choices: readonly SelectChoice[];
  defaultValue: string;
}

export interface InputPrompt {
  id: string;
  message: string;
  defaultValue?: string;
  hint?: string;
}

export interface ConfirmPrompt {
  id: string;
  message: string;
  defaultValue: boolean;
}

/**
 * UI boundary for the installer. A CLI, full-screen TUI, or test double can
 * implement this interface. Prompt text contains no terminal control codes.
 */
export interface WizardIO {
  select(prompt: SelectPrompt): Promise<string>;
  input(prompt: InputPrompt): Promise<string>;
  confirm(prompt: ConfirmPrompt): Promise<boolean>;
  write(message: string): void;
}

export interface WizardDefaults {
  paths?: Partial<WizardPaths>;
  profile?: WizardProfile;
  backend?: ModelBackend;
  /** Force the bounded core harness even when the detected machine has more memory. */
  core4g?: boolean;
}

export interface RunWizardOptions extends WizardDefaults {
  /** Required for interactive operation. May be omitted with acceptDefaults + dryRun. */
  io?: WizardIO;
  cwd?: string;
  hardware?: HardwareInfo;
  dryRun?: boolean;
  /** Build the recommended sealed profile without asking any questions. */
  acceptDefaults?: boolean;
  /** Overwriting remains opt-in and creates a protected backup first. */
  force?: boolean;
  now?: () => Date;
}

export interface WizardWriteResult {
  path: string;
  backupPath?: string;
  controlTokenPath: string;
  controlTokenCreated: boolean;
  controlSocketPath?: string;
  databaseDirectory: string;
}

export interface WizardResult {
  status: 'planned' | 'written' | 'cancelled';
  plan: WizardPlan;
  write?: WizardWriteResult;
}

import type { LoadedSidecarConfig, SidecarProviderPage, SidecarRequestEvidence } from '../types.js';

export interface SidecarReadWindow {
  readonly from?: string;
  readonly until: string;
  readonly cursor?: string;
}

export interface SidecarProviderAdapter {
  readonly kind: LoadedSidecarConfig['config']['provider']['kind'];
  /** Optional cumulative ledger used to preserve attempted reads in failure reports. */
  evidence?(): readonly SidecarRequestEvidence[];
  /** Final guard applied to every new or replayed Oracle body before submission. */
  assertCredentialAbsent(value: string): void;
  probeIdentity(signal?: AbortSignal): Promise<{
    accountId: string;
    requests: readonly SidecarRequestEvidence[];
  }>;
  fetchPage(window: SidecarReadWindow, signal?: AbortSignal): Promise<SidecarProviderPage>;
}

export interface SidecarProviderDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

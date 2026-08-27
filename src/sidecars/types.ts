import type { CorporateRecordInput } from '../oracle/corporate-oracle.js';
import type { EmbeddingDataBoundary } from '../core/types.js';

export const SIDECAR_CONFIG_SCHEMA = 'openprojects.sidecar.v1' as const;
export const SIDECAR_CURSOR_SCHEMA = 'openprojects.sidecar-cursor.v1' as const;
export const SIDECAR_REPORT_SCHEMA = 'openprojects.sidecar-report.v1' as const;

export type SidecarProviderKind = 'linear' | 'jira';

export interface SidecarLimits {
  /** Provider records requested per page. Oracle independently caps accepted pages at 100 records. */
  readonly pageSize: number;
  /** One provider request budget. */
  readonly timeoutMs: number;
  /** Maximum decoded bytes accepted from one provider response. */
  readonly maxResponseBytes: number;
  /** Replay overlap applied to completed incremental windows. */
  readonly overlapSeconds: number;
  /** Finite number of provider pages committed by one process invocation. */
  readonly maxPagesPerRun: number;
}

export interface SidecarStateConfig {
  /** Protected local directory containing at most one crash-recovery pending page. */
  readonly directory: string;
}

export interface SidecarOracleTarget {
  /** Exact loopback origin. Use http://localhost with socketPath on POSIX. */
  readonly baseUrl: string;
  /** Optional protected POSIX Unix-domain control socket. */
  readonly socketPath?: string;
  /** Protected ingest-only OpenProjects control credential. */
  readonly tokenFile: string;
}

export interface LinearSidecarProvider {
  readonly kind: 'linear';
  /** Environment variable containing a restricted API key or pre-issued OAuth access token. */
  readonly tokenEnv: string;
  readonly authorization: 'api-key' | 'oauth-bearer';
  /** Immutable organization identity returned by the reviewed GraphQL document. */
  readonly expectedAccountId: string;
  /** Exact Linear team UUID; the sidecar never accepts a model-authored filter. */
  readonly teamId: string;
}

export interface JiraSidecarProvider {
  readonly kind: 'jira';
  /** Environment variable containing a pre-issued read-scope OAuth access token. */
  readonly tokenEnv: string;
  /** Immutable cloud ID, verified through Atlassian accessible-resources before search. */
  readonly expectedAccountId: string;
  /** Exact Jira project key used in the sidecar-owned JQL document. */
  readonly projectKey: string;
}

export type SidecarProvider = LinearSidecarProvider | JiraSidecarProvider;

export interface SidecarConfig {
  readonly schema: typeof SIDECAR_CONFIG_SCHEMA;
  /** Must equal the ingest-only OpenProjects principal ID used by this process. */
  readonly id: string;
  readonly workspaceId: string;
  readonly stream: string;
  /** Optional fixed local project scope applied to every normalized record. */
  readonly localProjectId?: string;
  readonly oracle: SidecarOracleTarget;
  readonly state: SidecarStateConfig;
  readonly provider: SidecarProvider;
  readonly limits: SidecarLimits;
}

export interface LoadedSidecarConfig {
  readonly path: string;
  /** Exact source-file commitment. */
  readonly sha256: string;
  /** Canonical parsed contract commitment used by resumable cursor state. */
  readonly contractSha256: string;
  readonly config: SidecarConfig;
}

export interface SidecarCursor {
  readonly schema: typeof SIDECAR_CURSOR_SCHEMA;
  readonly contractSha256: string;
  readonly provider: SidecarProviderKind;
  readonly cycleId: string;
  readonly page: number;
  readonly from: string | null;
  readonly until: string;
  /** Provider continuation token for the next page; null closes the cycle. */
  readonly next: string | null;
}

export interface SidecarCheckpoint {
  readonly workspaceId: string;
  readonly source: string;
  readonly sourceAccountId: string;
  readonly stream: string;
  readonly cursor?: string;
  readonly sourceWatermark?: string;
  readonly lastBatchSha256: string;
  readonly recordsSeen: number;
  readonly lastSuccessAt: string;
}

/** Redacted checkpoint material safe to persist in a qualification report. */
export interface SidecarCheckpointEvidence {
  /** The opaque provider continuation is committed without being disclosed. */
  readonly cursorSha256?: string;
  readonly sourceWatermark?: string;
  readonly lastBatchSha256: string;
  readonly recordsSeen: number;
  readonly lastSuccessAt: string;
}

export interface SidecarProviderPage {
  readonly accountId: string;
  readonly records: readonly CorporateRecordInput[];
  readonly nextCursor?: string;
  readonly requests: readonly SidecarRequestEvidence[];
}

export interface SidecarRequestEvidence {
  readonly method: 'GET' | 'POST';
  readonly origin: string;
  readonly path: string;
  /** POST is allowed only for provider-defined read/query operations. */
  readonly operation: 'identity-read' | 'records-read';
}

export interface SidecarProviderProbe {
  readonly accountId: string;
  readonly page: SidecarProviderPage;
}

export interface SidecarSyncReceipt {
  readonly schema: 'openprojects.corporate-sync-receipt.v1';
  readonly inserted: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly stale: number;
  readonly records: readonly {
    readonly id: string;
    readonly externalId: string;
    readonly revision: number;
    readonly status: 'active' | 'deleted';
    readonly contentSha256: string;
  }[];
  readonly checkpoint: SidecarCheckpoint;
  readonly embeddings: {
    readonly model: string;
    readonly dataBoundary: EmbeddingDataBoundary | 'unreported';
    readonly stored: number;
    readonly failed: number;
    readonly error: string | null;
  };
  readonly agentRunInvoked: false;
  readonly chatModelInvoked: false;
  readonly embeddingInvoked: boolean;
  readonly modelInvoked: false;
}

export interface PendingSidecarPage {
  readonly schema: 'openprojects.sidecar-pending-page.v1';
  readonly contractSha256: string;
  readonly createdAt: string;
  readonly bodySha256: string;
  /** Exact serialized request body replayed after an ambiguous local POST. */
  readonly body: string;
}

export type SidecarReportMode = 'check' | 'probe' | 'sync';

export interface SidecarReport {
  readonly schema: typeof SIDECAR_REPORT_SCHEMA;
  readonly generatedAt: string;
  readonly mode: SidecarReportMode;
  /** One-shot commands can prove readiness, but cannot self-issue a live qualification. */
  readonly overall: 'ready' | 'not_ready';
  readonly config: {
    readonly id: string;
    readonly path: string;
    readonly sha256: string;
    readonly contractSha256: string;
    readonly workspaceId: string;
    readonly stream: string;
  };
  readonly provider: {
    readonly kind: SidecarProviderKind;
    readonly expectedAccountSha256: string;
    readonly verifiedAccountSha256?: string;
    readonly readOnly: true;
    readonly providerWritesAttempted: false;
    readonly credentialLifecycle: 'externally-managed';
    readonly oauthFlowInvoked: false;
    readonly requests: readonly SidecarRequestEvidence[];
  };
  readonly oracle: {
    readonly connected: boolean;
    readonly ingestionWritesAttempted: boolean;
    /** Receipts fully validated by the sidecar, whether or not local spool cleanup then succeeded. */
    readonly pagesAcknowledged: number;
    /** Acknowledged pages plus one in-flight page when the local Oracle outcome is ambiguous. */
    readonly pagesPossiblyCommitted: number;
    readonly lastWriteOutcome: 'not_attempted' | 'acknowledged' | 'rejected' | 'ambiguous';
    readonly recordsReceived: number;
    readonly inserted: number;
    readonly updated: number;
    readonly unchanged: number;
    readonly stale: number;
    readonly embeddings: {
      /** True when at least one acknowledged receipt reports a vector attempt. */
      readonly invoked: boolean;
      /** Unknown means an unacknowledged POST may have invoked embeddings. */
      readonly invocationOutcome: 'not_observed' | 'observed' | 'unknown';
      readonly stored: number;
      readonly failed: number;
      /** Bounded unique adapter identities observed across committed pages. */
      readonly models: readonly string[];
      /** Bounded unique declared boundaries; unreported preserves custom-adapter uncertainty. */
      readonly dataBoundaries: readonly (EmbeddingDataBoundary | 'unreported')[];
      /** Total receipts carrying an embedding error plus bounded, redacted unique samples. */
      readonly errorCount: number;
      readonly errors: readonly string[];
      readonly evidenceTruncated: boolean;
    };
    /** Present only for sync; false means a later bounded run must continue the window. */
    readonly cycleComplete?: boolean;
    readonly finalCheckpoint?: SidecarCheckpointEvidence;
  };
  readonly testSeam: boolean;
  readonly remainingUnqualified: readonly string[];
  readonly error?: string;
}

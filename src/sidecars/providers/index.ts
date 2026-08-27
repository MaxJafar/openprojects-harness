import type { LoadedSidecarConfig } from '../types.js';
import { createJiraSidecar } from './jira.js';
import { createLinearSidecar } from './linear.js';
import type { SidecarProviderAdapter, SidecarProviderDependencies } from './provider.js';

export function createSidecarProvider(
  loaded: LoadedSidecarConfig,
  dependencies: SidecarProviderDependencies = {},
): SidecarProviderAdapter {
  switch (loaded.config.provider.kind) {
    case 'linear':
      return createLinearSidecar(loaded, dependencies);
    case 'jira':
      return createJiraSidecar(loaded, dependencies);
  }
}

export type {
  SidecarProviderAdapter,
  SidecarProviderDependencies,
  SidecarReadWindow,
} from './provider.js';

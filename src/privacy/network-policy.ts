import { isIP } from 'node:net';

import type { AppConfig } from '../core/types.js';

const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

export interface OutboundNetworkPolicy {
  readonly localOnly: boolean;
  readonly allowedOrigins: readonly string[];
  assertAllowed(url: string | URL, purpose: string): void;
}

export class OutboundNetworkBlockedError extends Error {
  constructor(
    readonly origin: string,
    readonly purpose: string,
  ) {
    super(
      `Blocked outbound ${purpose} request to ${origin}: privacy.localOnly permits only loopback `
      + 'origins unless the exact origin is listed in privacy.allowedOrigins',
    );
    this.name = 'OutboundNetworkBlockedError';
  }
}

/**
 * Runtime egress policy for HTTP clients owned by the harness.
 *
 * The allowlist contains exact origins (scheme, host, and effective port), not
 * hostname suffixes. RFC1918/private-LAN addresses are intentionally not
 * implicit: a corporate endpoint must be named explicitly in configuration.
 */
export class NetworkPolicy implements OutboundNetworkPolicy {
  readonly localOnly: boolean;
  readonly allowedOrigins: readonly string[];
  readonly #allowedOriginSet: ReadonlySet<string>;

  constructor(config: NonNullable<AppConfig['privacy']>) {
    this.localOnly = config.localOnly;
    const origins = config.allowedOrigins.map(normalizeAllowedOrigin);
    if (new Set(origins).size !== origins.length) {
      throw new Error('privacy.allowedOrigins contains duplicate canonical origins');
    }
    this.allowedOrigins = Object.freeze(origins);
    this.#allowedOriginSet = new Set(origins);
  }

  assertAllowed(value: string | URL, purpose: string): void {
    const url = parseHttpUrl(value, purpose);
    if (url.username || url.password) {
      throw new Error(`Outbound ${purpose} URL must not contain credentials`);
    }
    if (!this.localOnly || isLoopbackHostname(url.hostname) || this.#allowedOriginSet.has(url.origin)) {
      return;
    }
    throw new OutboundNetworkBlockedError(url.origin, purpose);
  }
}

export function createNetworkPolicy(config?: AppConfig['privacy']): NetworkPolicy {
  return new NetworkPolicy(config ?? { localOnly: true, allowedOrigins: [] });
}

export function isLoopbackHostname(value: string): boolean {
  const hostname = stripIpv6Brackets(value).toLocaleLowerCase('en-US');
  if (hostname === 'localhost') return true;
  const family = isIP(hostname);
  if (family === 4) return hostname.split('.')[0] === '127';
  return family === 6 && hostname === '::1';
}

function normalizeAllowedOrigin(value: string): string {
  const url = parseHttpUrl(value, 'allowlisted origin');
  if (url.username || url.password) {
    throw new Error('privacy.allowedOrigins entries must not contain credentials');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(
      `privacy.allowedOrigins entry ${JSON.stringify(value)} must be an origin without a path, query, or fragment`,
    );
  }
  return url.origin;
}

function parseHttpUrl(value: string | URL, purpose: string): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.toString()) : new URL(value);
  } catch {
    throw new Error(`Outbound ${purpose} URL is invalid`);
  }
  if (!HTTP_PROTOCOLS.has(url.protocol)) {
    throw new Error(`Outbound ${purpose} URL must use http or https`);
  }
  return url;
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

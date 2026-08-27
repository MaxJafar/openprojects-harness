import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BoundedProviderHttp,
  providerAuthorization,
  providerCredential,
  SidecarHttpError,
} from '../src/sidecars/bounded-http.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bounded sidecar provider HTTP', () => {
  it.each([
    'http://api.example.test',
    'https://api.example.test/',
    'https://user:secret@api.example.test',
    'https://api.example.test/v1',
    'https://api.example.test?region=one',
    'https://api.example.test#fragment',
    'https://API.example.test',
    'not-a-url',
  ])('rejects a non-exact HTTPS provider origin: %s', (origin) => {
    expect(() => makeClient({ origin })).toThrow(/origin/u);
  });

  it('validates timeout, response, and authorization-header bounds at construction', () => {
    expect(() => makeClient({ timeoutMs: 999 })).toThrow('between 1000 and 30000');
    expect(() => makeClient({ timeoutMs: 30_001 })).toThrow('between 1000 and 30000');
    expect(() => makeClient({ maxResponseBytes: 1_023 })).toThrow('between 1024 and 2097152');
    expect(() => makeClient({ maxResponseBytes: 2_097_153 })).toThrow('between 1024 and 2097152');
    expect(() => makeClient({ authorizationHeader: '' })).toThrow('authorization header is invalid');
    expect(() => makeClient({ authorizationHeader: 'Bearer safe\r\nX-Leak: yes' })).toThrow(
      'authorization header is invalid',
    );
    expect(() => makeClient({ authorizationHeader: `Bearer ${'x'.repeat(8_193)}` })).toThrow(
      'authorization header is invalid',
    );
  });

  it('derives credentials only from the named environment entry and enforces byte/control bounds', () => {
    const environment = { TOKEN: 'secret-value', UNUSED: 'must-not-be-used' };
    expect(providerAuthorization('TOKEN', environment, 'bearer')).toBe('Bearer secret-value');
    expect(providerAuthorization('TOKEN', environment, 'raw')).toBe('secret-value');
    expect(providerAuthorization('TOKEN', { TOKEN: 'x'.repeat(8_192) }, 'raw')).toHaveLength(8_192);

    expect(() => providerAuthorization('MISSING', environment, 'bearer')).toThrow('MISSING is not set');
    for (const token of [' leading', 'trailing ', 'two words', 'line\nfeed', 'tab\tvalue', `del${String.fromCharCode(0x7f)}`]) {
      expect(() => providerAuthorization('TOKEN', { TOKEN: token }, 'raw')).toThrow('has an invalid value');
    }
    expect(() => providerAuthorization('TOKEN', { TOKEN: 'short' }, 'raw')).toThrow('has an invalid value');
    expect(() => providerAuthorization('TOKEN', { TOKEN: 'é'.repeat(4_097) }, 'raw')).toThrow(
      'has an invalid value',
    );
    const escapedCredential = providerCredential('TOKEN', { TOKEN: 'abc"defgh' }, 'raw');
    expect(() => escapedCredential.assertJsonAbsent(
      JSON.stringify({ value: 'abc"defgh' }),
      'fixture body',
    )).toThrow('Provider credential overlaps fixture body');
  });

  it.each(['relative', '//evil.example/path', '/safe#fragment', '/\\evil.example/path'])(
    'rejects a provider path that can escape or reinterpret the reviewed origin: %s',
    async (path) => {
      const { client, fetch } = makeHarness();

      await expect(client.json({ method: 'GET', path, operation: 'records-read' })).rejects.toThrow(
        /reviewed origin/u,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('enforces method/body structure before network access', async () => {
    const { client, fetch } = makeHarness();

    await expect(client.json({
      method: 'GET',
      path: '/issues',
      operation: 'records-read',
      body: {},
    })).rejects.toThrow('GET requests cannot contain a body');
    await expect(client.json({
      method: 'POST',
      path: '/graphql',
      operation: 'records-read',
    })).rejects.toThrow('POST query requires a structural JSON body');
    expect(fetch).not.toHaveBeenCalled();
    expect(client.evidence()).toEqual([]);
  });

  it('sends reviewed fetch options while keeping credentials and bodies out of evidence', async () => {
    let observedInput: string | URL | Request | undefined;
    let observedInit: RequestInit | undefined;
    const secret = 'provider-secret';
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      observedInput = input;
      observedInit = init;
      return jsonResponse({ data: { ok: true } });
    }) as unknown as typeof globalThis.fetch;
    const client = makeClient({ authorizationHeader: `Bearer ${secret}`, fetch });
    const body = { query: 'ReviewedQuery', variables: { teamId: 'team-1' } };

    await expect(client.json({
      method: 'POST',
      path: '/graphql?fixed=true',
      operation: 'records-read',
      body,
    })).resolves.toEqual({ data: { ok: true } });

    expect(String(observedInput)).toBe('https://api.example.test/graphql?fixed=true');
    expect(observedInit).toMatchObject({
      method: 'POST',
      body: JSON.stringify(body),
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: expect.any(AbortSignal),
    });
    const headers = new Headers(observedInit?.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('authorization')).toBe(`Bearer ${secret}`);
    expect(headers.get('content-type')).toBe('application/json');

    const evidence = client.evidence();
    expect(evidence).toEqual([{
      method: 'POST',
      origin: 'https://api.example.test',
      path: '/graphql?fixed=true',
      operation: 'records-read',
    }]);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence[0])).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain(secret);
    expect(JSON.stringify(evidence)).not.toContain('ReviewedQuery');
  });

  it('rejects response-origin drift without consuming or retrying the response', async () => {
    const response = jsonResponse({ ok: true });
    Object.defineProperty(response, 'url', { value: 'https://attacker.example/escaped' });
    const { client, fetch, delays } = makeHarness([response]);

    await expect(client.json({ method: 'GET', path: '/issues', operation: 'records-read' })).rejects.toMatchObject({
      name: 'SidecarHttpError',
      code: 'PROVIDER_ORIGIN_DRIFT',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('rejects a declared response larger than the reviewed byte limit and cancels it', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x7b]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      headers: {
        'content-type': 'application/json',
        'content-length': '1025',
      },
    });
    const { client } = makeHarness([response]);

    await expect(client.json({ method: 'GET', path: '/issues', operation: 'records-read' })).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE_TOO_LARGE',
    });
    expect(cancelled).toBe(true);
  });

  it('enforces the byte limit while streaming when content length is absent', async () => {
    const response = new Response(Buffer.alloc(1_025, 0x78), {
      headers: { 'content-type': 'application/json' },
    });
    const { client } = makeHarness([response]);

    await expect(client.json({ method: 'GET', path: '/issues', operation: 'records-read' })).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE_TOO_LARGE',
    });
  });

  it('maps a response-body deadline to a fixed provider timeout error', async () => {
    const response = failingBodyResponse(new DOMException('runtime-specific timeout detail', 'TimeoutError'));
    const { client } = makeHarness([response]);

    await expect(client.json({ method: 'GET', path: '/issues', operation: 'records-read' })).rejects.toMatchObject({
      name: 'SidecarHttpError',
      code: 'PROVIDER_TIMEOUT',
      message: 'Provider read exceeded its deadline',
    });
  });

  it('maps caller cancellation while reading a response body without leaking its reason', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller-private cancellation detail'));
    const response = failingBodyResponse(new DOMException('runtime-specific abort detail', 'AbortError'));
    const { client } = makeHarness([response]);

    await expect(client.json({
      method: 'GET',
      path: '/issues',
      operation: 'records-read',
      signal: controller.signal,
    })).rejects.toMatchObject({
      name: 'SidecarHttpError',
      code: 'PROVIDER_ABORTED',
      message: 'Provider read was cancelled',
    });
  });

  it('rejects successful non-JSON and malformed JSON responses with typed errors', async () => {
    const nonJson = makeHarness([new Response('{}', { headers: { 'content-type': 'text/plain' } })]);
    await expect(nonJson.client.json({ method: 'GET', path: '/issues', operation: 'records-read' })).rejects.toMatchObject({
      code: 'PROVIDER_CONTENT_TYPE',
    });

    const malformed = makeHarness([new Response('{broken', { headers: { 'content-type': 'application/json' } })]);
    await expect(malformed.client.json({ method: 'GET', path: '/issues', operation: 'records-read' })).rejects.toMatchObject({
      code: 'PROVIDER_JSON',
    });

    const credential = providerCredential('TOKEN', { TOKEN: 'provider-secret' }, 'bearer');
    const reflected = makeHarness([
      new Response('{"value":"provider-\\u0073ecret"}', {
        headers: { 'content-type': 'application/json' },
      }),
    ], {
      authorizationHeader: credential.authorizationHeader(),
      responseStringRedactor: credential.redactResponseString,
    });
    await expect(reflected.client.json({
      method: 'GET',
      path: '/issues',
      operation: 'records-read',
    })).resolves.toEqual({ value: '[REDACTED:PROVIDER_CREDENTIAL]' });

    const overlapping = providerCredential('TOKEN', { TOKEN: 'PROVIDER' }, 'raw');
    const markerOverlap = makeHarness([jsonResponse({ value: 'PROVIDER' })], {
      authorizationHeader: overlapping.authorizationHeader(),
      responseStringRedactor: overlapping.redactResponseString,
    });
    await expect(markerOverlap.client.json({
      method: 'GET',
      path: '/issues',
      operation: 'records-read',
    })).rejects.toMatchObject({ code: 'PROVIDER_CREDENTIAL_REFLECTION' });
  });

  it.each([
    [401, 'PROVIDER_AUTH'],
    [403, 'PROVIDER_AUTH'],
    [404, 'PROVIDER_RESPONSE'],
  ])('maps final HTTP %i to %s without leaking its response body', async (status, code) => {
    const { client } = makeHarness([new Response('sensitive-provider-detail', { status })]);

    let error: unknown;
    try {
      await client.json({ method: 'GET', path: '/issues', operation: 'records-read' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SidecarHttpError);
    expect(error).toMatchObject({ code, status });
    expect((error as Error).message).toBe(`Provider read returned HTTP ${status}`);
    expect((error as Error).message).not.toContain('sensitive-provider-detail');
  });

  it('honors bounded Retry-After values for 429 and succeeds within three attempts', async () => {
    const { client, fetch, delays } = makeHarness([
      new Response('busy-one', { status: 429, headers: { 'retry-after': '99' } }),
      new Response('busy-two', { status: 429 }),
      jsonResponse({ issues: [] }),
    ]);

    await expect(client.json({ method: 'GET', path: '/issues', operation: 'records-read' })).resolves.toEqual({ issues: [] });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([2_000, 200]);
    expect(client.evidence()).toEqual(Array.from({ length: 3 }, () => ({
      method: 'GET',
      origin: 'https://api.example.test',
      path: '/issues',
      operation: 'records-read',
    })));
  });

  it('never retries a retryable status more than the fixed three-attempt budget', async () => {
    const { client, fetch, delays } = makeHarness([
      new Response('busy-one', { status: 429 }),
      new Response('busy-two', { status: 503 }),
      new Response('busy-three', { status: 500 }),
    ]);

    await expect(client.json({ method: 'GET', path: '/issues', operation: 'records-read' })).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE',
      status: 500,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]);
    expect(client.evidence()).toHaveLength(3);
  });

  it('discards an oversized retry response within the same bound before retrying', async () => {
    const { client, fetch } = makeHarness([
      new Response(Buffer.alloc(1_025, 0x78), { status: 503 }),
      jsonResponse({ recovered: true }),
    ]);

    await expect(client.json({ method: 'GET', path: '/issues', operation: 'records-read' })).resolves.toEqual({
      recovered: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(client.evidence()).toHaveLength(2);
  });

  it('bounds transport retries and returns one generic terminal transport error', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('secret DNS or proxy detail');
    }) as unknown as typeof globalThis.fetch;
    const delays: number[] = [];
    const client = makeClient({
      fetch,
      delay: async (milliseconds) => { delays.push(milliseconds); },
    });

    let error: unknown;
    try {
      await client.json({ method: 'GET', path: '/issues', operation: 'records-read' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'PROVIDER_TRANSPORT' });
    expect((error as Error).message).toBe('Provider read failed after bounded retries');
    expect((error as Error).message).not.toContain('secret DNS');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 200]);
    expect(client.evidence()).toHaveLength(3);
  });

  it('reports caller cancellation distinctly from transport failure', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancel fixture'));
    const fetch = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof globalThis.fetch;
    const client = makeClient({ fetch });

    await expect(client.json({
      method: 'GET',
      path: '/issues',
      operation: 'records-read',
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'PROVIDER_ABORTED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails before fetch when the total request deadline is already exhausted', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(10_000)
      .mockReturnValue(11_001);
    const { client, fetch } = makeHarness([], { timeoutMs: 1_000 });

    await expect(client.json({ method: 'GET', path: '/issues', operation: 'records-read' })).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

interface ClientOverrides {
  origin?: string;
  authorizationHeader?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  responseStringRedactor?: (value: string) => string;
}

function makeClient(overrides: ClientOverrides = {}): BoundedProviderHttp {
  return new BoundedProviderHttp({
    origin: overrides.origin ?? 'https://api.example.test',
    authorizationHeader: overrides.authorizationHeader ?? 'Bearer fixture-token',
    timeoutMs: overrides.timeoutMs ?? 5_000,
    maxResponseBytes: overrides.maxResponseBytes ?? 1_024,
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.delay ? { delay: overrides.delay } : {}),
    ...(overrides.responseStringRedactor
      ? { responseStringRedactor: overrides.responseStringRedactor }
      : {}),
  });
}

function makeHarness(
  responses: Response[] = [jsonResponse({ ok: true })],
  overrides: Omit<ClientOverrides, 'fetch' | 'delay'> = {},
): {
  client: BoundedProviderHttp;
  fetch: ReturnType<typeof vi.fn>;
  delays: number[];
} {
  let index = 0;
  const fetch = vi.fn(async () => {
    const response = responses[index];
    index += 1;
    if (!response) throw new Error('No synthetic response remains');
    return response;
  });
  const delays: number[] = [];
  const client = makeClient({
    ...overrides,
    fetch: fetch as unknown as typeof globalThis.fetch,
    delay: async (milliseconds) => { delays.push(milliseconds); },
  });
  return { client, fetch, delays };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value), { ...init, headers });
}

function failingBodyResponse(error: unknown): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(error);
    },
  }), { headers: { 'content-type': 'application/json' } });
}

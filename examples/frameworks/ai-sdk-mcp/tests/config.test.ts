import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bridgeConfigFromEnvironment,
  localModelConfigFromEnvironment,
  normalizeLoopbackBaseUrl,
} from '../src/config.js';
import { OpenProjectsBridgeClient } from '../src/openprojects-client.js';
import { bridgeConfig, fakeOpenProjectsFetch, jsonResponse, type RecordedRequest } from './helpers.js';

test('service and model URLs are restricted to exact loopback hosts', () => {
  assert.equal(
    normalizeLoopbackBaseUrl('http://127.0.0.2:4100', { rootPathOnly: true }),
    'http://127.0.0.2:4100',
  );
  assert.equal(
    normalizeLoopbackBaseUrl('http://[::1]:4100/v1/', { rootPathOnly: false }),
    'http://[::1]:4100/v1',
  );
  for (const value of [
    'https://example.com',
    'http://localhost.example.com:4100',
    'http://user:secret@127.0.0.1:4100',
    'http://127.0.0.1:4100/?redirect=https://example.com',
    'file:///tmp/openprojects.sock',
  ]) {
    assert.throws(
      () => normalizeLoopbackBaseUrl(value, { rootPathOnly: true }),
      /loopback|credentials|HTTP or HTTPS/u,
    );
  }
  assert.throws(
    () => normalizeLoopbackBaseUrl('http://127.0.0.1:4100/api', { rootPathOnly: true }),
    /must not include a path/u,
  );
});

test('programmatic bridge construction validates at the network sink', async () => {
  assert.throws(
    () => new OpenProjectsBridgeClient(bridgeConfig({ baseUrl: 'https://example.com' })),
    /loopback/u,
  );
  assert.throws(
    () => new OpenProjectsBridgeClient(bridgeConfig({ runTimeoutMs: 999 })),
    /runTimeoutMs must be between/u,
  );
  for (const field of ['principalId', 'workspaceId', 'projectId'] as const) {
    for (const value of [undefined, null]) {
      assert.throws(
        () => new OpenProjectsBridgeClient(bridgeConfig({ [field]: value as never })),
        new RegExp(`${field} must be a safe`, 'u'),
      );
    }
  }

  const requests: RecordedRequest[] = [];
  const fetch = fakeOpenProjectsFetch(() => jsonResponse({}), requests);
  const client = new OpenProjectsBridgeClient(bridgeConfig({
    credential: { authorizationHeader: () => 'Bearer short' },
  }), fetch);
  await assert.rejects(client.analyzeProject('Do not send this'), /invalid Authorization header/u);
  assert.equal(requests.length, 0);
});

test('environment factories reject remote models and out-of-range bridge bounds', () => {
  const baseEnvironment = {
    OPENPROJECTS_BASE_URL: 'http://127.0.0.1:4100',
    OPENPROJECTS_CONTROL_TOKEN: 't'.repeat(32),
    OPENPROJECTS_PRINCIPAL_ID: 'framework-runner',
    OPENPROJECTS_WORKSPACE_ID: 'workspace-fixed',
    OPENPROJECTS_PROJECT_ID: 'project-fixed',
  };
  assert.throws(
    () => bridgeConfigFromEnvironment({
      ...baseEnvironment,
      OPENPROJECTS_POLL_INTERVAL_MS: '24',
    }),
    /between 25 and 2000/u,
  );
  assert.throws(
    () => localModelConfigFromEnvironment({
      LOCAL_MODEL_BASE_URL: 'https://models.example.com/v1',
      LOCAL_MODEL_ID: 'model',
    }),
    /loopback/u,
  );
});

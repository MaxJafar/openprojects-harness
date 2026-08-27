import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_QUESTION_BYTES } from '../src/config.js';
import { OpenProjectsBridgeClient } from '../src/openprojects-client.js';
import {
  bridgeConfig,
  fakeOpenProjectsFetch,
  jsonResponse,
  type RecordedRequest,
  runRecord,
  scopedIdentity,
} from './helpers.js';

test('the only model-controlled field is a bounded question', async () => {
  const requests: RecordedRequest[] = [];
  const fetch = fakeOpenProjectsFetch((request) => {
    if (request.url.pathname === '/api/whoami') return jsonResponse(scopedIdentity());
    if (request.url.pathname === '/api/runs/async') {
      return jsonResponse({ run: runRecord('queued'), links: {} }, 202);
    }
    if (request.url.pathname === '/api/runs/run-1') {
      return jsonResponse({
        run: runRecord('succeeded', { output: 'bounded result' }),
        approvals: [],
        events: [],
      });
    }
    return jsonResponse({ error: 'not found' }, 404);
  }, requests);

  const result = await new OpenProjectsBridgeClient(bridgeConfig(), fetch)
    .analyzeProject('What is blocking launch?');

  assert.equal(result.status, 'succeeded');
  assert.equal(result.output, 'bounded result');
  assert.equal(result.workspaceId, 'workspace-fixed');
  assert.equal(result.projectId, 'project-fixed');
  assert.equal(result.principalId, 'framework-runner');
  assert.equal(requests.length, 3);
  assert.equal(requests[0]?.url.pathname, '/api/whoami');
  assert.deepEqual(requests[1]?.body, {
    message: 'What is blocking launch?',
    workspaceId: 'workspace-fixed',
    projectId: 'project-fixed',
    actorId: 'framework-runner',
  });
  assert.ok(requests.every((request) => request.authorization === `Bearer ${'t'.repeat(32)}`));
  assert.ok(requests.every((request) => !request.url.pathname.startsWith('/api/approvals')));
});

test('oversized UTF-8 prompts fail before any network access', async () => {
  const requests: RecordedRequest[] = [];
  const fetch = fakeOpenProjectsFetch(() => jsonResponse({}), requests);
  const client = new OpenProjectsBridgeClient(bridgeConfig(), fetch);

  await assert.rejects(
    client.analyzeProject('x'.repeat(MAX_QUESTION_BYTES + 1)),
    /question must contain/u,
  );
  assert.equal(requests.length, 0);

  await assert.rejects(
    client.analyzeProject('é'.repeat((MAX_QUESTION_BYTES / 2) + 1)),
    /question must contain/u,
  );
  assert.equal(requests.length, 0);
});

test('scope verification rejects approval or admin authority before starting a run', async () => {
  for (const identity of [
    scopedIdentity(['read', 'run', 'approve']),
    scopedIdentity(['admin']),
    scopedIdentity(['read']),
    scopedIdentity(['read', 'read']),
    scopedIdentity(['read', 7]),
    scopedIdentity(['read', 'unknown']),
    scopedIdentity(['read', 'run'], 'all'),
    scopedIdentity(['read', 'run'], ['workspace-fixed', 'other-workspace']),
    scopedIdentity(['read', 'run'], ['workspace-fixed', 'workspace-fixed']),
  ]) {
    const requests: RecordedRequest[] = [];
    const fetch = fakeOpenProjectsFetch(() => jsonResponse(identity), requests);
    await assert.rejects(
      new OpenProjectsBridgeClient(bridgeConfig(), fetch).analyzeProject('Check risk'),
      /exactly read and run/u,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url.pathname, '/api/whoami');
  }
});

test('waiting_for_approval is returned unchanged and never resolved by the facade', async () => {
  const requests: RecordedRequest[] = [];
  const fetch = fakeOpenProjectsFetch((request) => {
    if (request.url.pathname === '/api/whoami') return jsonResponse(scopedIdentity());
    if (request.url.pathname === '/api/runs/async') {
      return jsonResponse({ run: runRecord('waiting_for_approval'), links: {} }, 202);
    }
    return jsonResponse({ error: 'unexpected endpoint' }, 500);
  }, requests);

  const result = await new OpenProjectsBridgeClient(bridgeConfig(), fetch)
    .analyzeProject('Draft a risky change');

  assert.equal(result.status, 'waiting_for_approval');
  assert.equal(result.approvalRequired, true);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => !request.url.pathname.startsWith('/api/approvals')));
});

test('a run response cannot escape the fixed workspace, project, or principal', async () => {
  for (const escaped of [
    { workspaceId: 'other-workspace' },
    { projectId: 'other-project' },
    { actorId: 'other-principal' },
    { id: '../approval-bypass' },
    { id: 'x'.repeat(129) },
  ]) {
    const fetch = fakeOpenProjectsFetch((request) => {
      if (request.url.pathname === '/api/whoami') return jsonResponse(scopedIdentity());
      return jsonResponse({ run: runRecord('succeeded', escaped), links: {} }, 202);
    });
    await assert.rejects(
      new OpenProjectsBridgeClient(bridgeConfig(), fetch).analyzeProject('Check scope'),
      /escaped the fixed|bounded safe identifier/u,
    );
  }
});

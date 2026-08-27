import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('framework dependencies stay in the private example package', async () => {
  const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const repositoryRoot = resolve(exampleRoot, '../../..');
  const examplePackage = await readJson(join(exampleRoot, 'package.json'));
  const exampleLock = await readJson(join(exampleRoot, 'package-lock.json'));
  const rootPackage = await readJson(join(repositoryRoot, 'package.json'));

  assert.equal(examplePackage.name, '@openprojects/ai-sdk-mcp-example');
  assert.equal(examplePackage.private, true);
  assert.equal(examplePackage.license, 'MIT');
  assert.equal(exampleLock.name, '@openprojects/ai-sdk-mcp-example');

  const rootDependencies = asRecord(rootPackage.dependencies);
  for (const dependency of [
    'ai',
    '@ai-sdk/mcp',
    '@ai-sdk/openai-compatible',
    '@modelcontextprotocol/server',
    'zod',
  ]) {
    assert.equal(rootDependencies[dependency], undefined, `${dependency} must not enter root production dependencies`);
  }

  const exampleDependencies = asRecord(examplePackage.dependencies);
  assert.equal(exampleDependencies.ai, '7.0.83');
  assert.equal(exampleDependencies['@ai-sdk/mcp'], '2.0.39');
  assert.equal(exampleDependencies['@modelcontextprotocol/server'], '2.0.0');
});

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

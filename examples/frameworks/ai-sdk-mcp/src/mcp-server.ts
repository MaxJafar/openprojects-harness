import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

import {
  bridgeConfigFromEnvironment,
  MAX_QUESTION_BYTES,
  MCP_TOOL_NAME,
  type OpenProjectsBridgeConfig,
} from './config.js';
import { OpenProjectsBridgeClient } from './openprojects-client.js';

const snapshotSchema = z.object({
  agent: z.string().regex(/^[a-f0-9]{64}$/u),
  tools: z.string().regex(/^[a-f0-9]{64}$/u),
  policy: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

export const bridgeResultSchema = z.object({
  schema: z.literal('openprojects.framework-result.v1'),
  runId: z.string().min(1),
  status: z.enum([
    'queued',
    'running',
    'waiting_for_approval',
    'succeeded',
    'failed',
    'cancelled',
  ]),
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  principalId: z.string().min(1),
  approvalRequired: z.boolean(),
  outputTruncated: z.boolean(),
  output: z.string().optional(),
  error: z.string().optional(),
  snapshots: snapshotSchema.optional(),
}).strict().superRefine((result, context) => {
  if (result.approvalRequired !== (result.status === 'waiting_for_approval')) {
    context.addIssue({
      code: 'custom',
      message: 'approvalRequired must exactly match waiting_for_approval status',
    });
  }
});

export function createOpenProjectsMcpServer(
  config: OpenProjectsBridgeConfig,
  fetchImplementation?: typeof globalThis.fetch,
): McpServer {
  const client = new OpenProjectsBridgeClient(config, fetchImplementation);
  const server = new McpServer(
    { name: 'openprojects-bounded-facade', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    MCP_TOOL_NAME,
    {
      title: 'Analyze the fixed OpenProjects project',
      description: [
        'Starts one bounded OpenProjects run in the host-fixed workspace and project.',
        'The credential has exactly read and run capabilities; this tool cannot resolve approvals.',
      ].join(' '),
      inputSchema: z.object({
        question: z.string().min(1).max(MAX_QUESTION_BYTES),
      }).strict(),
      outputSchema: bridgeResultSchema,
      annotations: {
        readOnlyHint: false,
        // Starting a run can reach policy-controlled effectful tools. These
        // annotations are conservative UI hints, never an authority grant.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ question }, context) => {
      const result = await client.analyzeProject(question, context.mcpReq.signal);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  return server;
}

function runStdioServer(): void {
  const config = bridgeConfigFromEnvironment();
  const handle = serveStdio(
    () => createOpenProjectsMcpServer(config),
    {
      legacy: 'serve',
      onerror(error) {
        process.stderr.write(`OpenProjects MCP transport error: ${safeError(error)}\n`);
      },
      maxSubscriptions: 1,
    },
  );

  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void handle.close().catch((error: unknown) => {
      process.stderr.write(`OpenProjects MCP shutdown error: ${safeError(error)}\n`);
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  if (process.platform === 'win32') process.once('SIGBREAK', close);
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    : 'unknown error';
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    runStdioServer();
  } catch (error) {
    process.stderr.write(`OpenProjects MCP startup failed: ${safeError(error)}\n`);
    process.exitCode = 1;
  }
}

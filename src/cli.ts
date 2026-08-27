#!/usr/bin/env node
import { stdin, stderr, stdout } from 'node:process';

import { Command } from 'commander';

import type { LearningDatasetKind } from './learning/export.js';
import type { QualificationCapability } from './qualification/index.js';
import { OPENPROJECTS_VERSION } from './version.js';

const SERVICE_SHUTDOWN_TIMEOUT_MS = 30_000;

const program = new Command();
program
  .name('openprojects')
  .description('OpenProjects lightweight durable private agent control plane')
  .version(OPENPROJECTS_VERSION);

program
  .command('setup')
  .alias('init')
  .description('Create a reviewed private-local or hybrid configuration')
  .option('-o, --output <path>', 'configuration output path', 'openprojects.local.yaml')
  .option('--dry-run', 'render the complete deterministic plan without writing')
  .option('--defaults', 'use hardware-sized sealed-local defaults without questions')
  .option('--core-4g', 'force the bounded core-4g-v1 harness profile')
  .option('--force', 'replace a regular config only after creating a protected backup')
  .action(async (options: {
    output: string;
    dryRun?: boolean;
    defaults?: boolean;
    core4g?: boolean;
    force?: boolean;
  }) => {
    const {
      createReadlineWizardIO,
      renderPlanLines,
      runInstallationWizard,
    } = await import('./wizard/index.js');
    const interactive = stdin.isTTY === true && stdout.isTTY === true;
    if (!interactive && !(options.defaults === true && options.dryRun === true)) {
      throw new Error('Non-interactive setup requires --defaults --dry-run; configuration writes require a TTY confirmation');
    }
    const io = interactive ? createReadlineWizardIO({ input: stdin, output: stdout }) : undefined;
    try {
      const result = await runInstallationWizard({
        ...(io ? { io } : {}),
        acceptDefaults: options.defaults === true,
        core4g: options.core4g === true,
        dryRun: options.dryRun === true,
        force: options.force === true,
        paths: { config: options.output },
      });
      if (result.status === 'planned') {
        if (!interactive) {
          for (const line of renderPlanLines(result.plan, true)) stderr.write(`${line}\n`);
        }
        if (interactive) stdout.write('\nGenerated configuration (not written):\n');
        stdout.write(result.plan.yaml);
      } else if (result.status === 'cancelled') {
        stdout.write('Setup cancelled; no files were written.\n');
      } else {
        stdout.write(`Setup complete: ${result.write!.path}\n`);
        stdout.write('The reviewed model/runtime and launch steps are listed above.\n');
      }
    } finally {
      io?.close();
    }
  });

program
  .command('tui')
  .description('Attach mission control to the private local service; standalone modes are for development')
  .option('-c, --config <path>', 'config path', 'openprojects.local.yaml')
  .option('-s, --server <url>', 'loopback OpenProjects service origin')
  .option('--principal <id>', 'configured control principal ID (required when more than one exists)')
  .option('-w, --workspace <id>', 'workspace ID', 'local')
  .option('--actor <id>', 'standalone or unauthenticated-development actor identity', 'local-user')
  .option('--demo', 'standalone development mode: open the runtime directly and seed the Atlas fixture')
  .option('--standalone', 'open the runtime directly instead of attaching to the service')
  .option('--plain', 'print one screen-reader-friendly status summary and exit')
  .option('--screen-reader', 'alias for --plain')
  .action(async (options: {
    config: string;
    server?: string;
    principal?: string;
    workspace: string;
    actor: string;
    demo?: boolean;
    standalone?: boolean;
    plain?: boolean;
    screenReader?: boolean;
  }) => {
    const { runTui } = await import('./tui/index.js');
    const tuiOptions = {
      workspaceId: options.workspace,
      actorId: options.actor,
      plain: options.plain === true || options.screenReader === true,
      input: stdin,
      output: stdout,
    };
    if (options.standalone === true || options.demo === true) {
      const { createApp } = await import('./app.js');
      const app = await createApp({ configPath: options.config, seedDemo: options.demo === true });
      try {
        const fullScreen = options.plain !== true
          && options.screenReader !== true
          && stdin.isTTY === true
          && stdout.isTTY === true
          && process.env.TERM !== 'dumb';
        if (fullScreen) await app.recover();
        await runTui(app, tuiOptions);
      } finally {
        await app.close();
      }
      return;
    }
    const [
      { OpenProjectsApiClient },
      { createUnixSocketFetch },
      {
        loadControlClientCredential,
        selectControlClientPrincipal,
      },
      { loadConfig },
    ] = await Promise.all([
      import('./api/client.js'),
      import('./api/unix-fetch.js'),
      import('./auth/control-auth.js'),
      import('./config.js'),
    ]);
    const configured = loadConfig(options.config);
    const configuredHost = configured.server.host;
    const host = configuredHost === '0.0.0.0' || configuredHost === '::' ? '127.0.0.1' : configuredHost;
    const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const auth = configured.server.auth;
    const selected = auth ? selectControlClientPrincipal(auth, options.principal) : undefined;
    const socketFetch = !options.server && configured.server.socketPath
      ? createUnixSocketFetch({ socketPath: configured.server.socketPath })
      : undefined;
    const baseUrl = options.server ?? (socketFetch
      ? 'http://localhost'
      : `http://${urlHost}:${configured.server.port}`);
    const client = new OpenProjectsApiClient(
      baseUrl,
      {
        ...(socketFetch ? { fetch: socketFetch } : {}),
        ...(selected
          ? {
              credential: loadControlClientCredential(selected),
              principalId: selected.id,
            }
          : {}),
      },
    );
    await runTui(client, {
      workspaceId: options.workspace,
      actorId: selected?.id ?? options.actor,
      plain: options.plain === true || options.screenReader === true,
      input: stdin,
      output: stdout,
    });
  });

program
  .command('serve')
  .description('Start the local API and dashboard')
  .option('-c, --config <path>', 'config path', 'openprojects.config.yaml')
  .option('--demo', 'explicitly seed the Atlas development fixture')
  .action(async ({ config, demo }: { config: string; demo?: boolean }) => {
    const [
      { loadConfig },
      { isLoopbackHostname },
      { assertUnixSocketPathAvailable },
      { loadControlAuthenticator },
      { createApp },
      { startServer },
    ] = await Promise.all([
      import('./config.js'),
      import('./privacy/network-policy.js'),
      import('./server-endpoint.js'),
      import('./auth/control-auth.js'),
      import('./app.js'),
      import('./server.js'),
    ]);
    const configured = loadConfig(config);
    if (configured.server.socketPath) {
      await assertUnixSocketPathAvailable(configured.server.socketPath);
    } else if (!isLoopbackHostname(configured.server.host)) {
      throw new Error('OpenProjects serve requires a loopback server.host');
    }
    if (configured.server.auth) loadControlAuthenticator(configured.server.auth);
    const app = await createApp({ config: configured, seedDemo: demo === true });
    let started: Awaited<ReturnType<typeof startServer>>;
    try {
      started = await startServer(app);
    } catch (error) {
      await app.close();
      throw error;
    }
    stdout.write(started.transport === 'unix'
      ? `OpenProjects is running on protected Unix socket ${started.socketPath}\n`
      : `OpenProjects is running at ${started.url}\n`);
    stdout.write(`Model: ${app.config.model.provider}/${app.config.model.model}\n`);
    stdout.write(`Embeddings: ${app.embedding.id}; transcription: ${app.transcriber.id}\n`);
    if (started.recoveredRunIds.length) {
      stdout.write(`Recovered ${started.recoveredRunIds.length} interrupted run(s).\n`);
    }
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= (async () => {
        const failures: unknown[] = [];
        let serviceClosed = false;
        try {
          await started.close();
          serviceClosed = true;
        } catch (error) {
          failures.push(error);
        }
        // Never close SQLite under background service work when transport
        // teardown could not prove it had settled. The signal watchdog below
        // provides the outer process bound; the recovery runbook then applies.
        if (serviceClosed) {
          try {
            await app.close();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'OpenProjects shutdown failed');
      })();
      return closePromise;
    };
    let signalHandled = false;
    const handleSignal = (signal: 'SIGINT' | 'SIGTERM' | 'SIGBREAK'): void => {
      if (signalHandled) return;
      signalHandled = true;
      const signalExitCode = signal === 'SIGINT' ? 130 : signal === 'SIGBREAK' ? 149 : 143;
      process.exitCode = signalExitCode;
      const watchdog = setTimeout(() => {
        stderr.write(
          'OpenProjects shutdown exceeded its 30-second process budget; forcing exit. '
            + 'Verify notification state and follow the owner-lock/socket recovery runbook before restart.\n',
        );
        process.exit(signalExitCode);
      }, SERVICE_SHUTDOWN_TIMEOUT_MS);
      void close().then(() => {
        clearTimeout(watchdog);
      }).catch((error) => {
        clearTimeout(watchdog);
        stderr.write(`OpenProjects shutdown: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      });
    };
    process.once('SIGINT', () => handleSignal('SIGINT'));
    process.once('SIGTERM', () => handleSignal('SIGTERM'));
    if (process.platform === 'win32') process.once('SIGBREAK', () => handleSignal('SIGBREAK'));
  });

program
  .command('demo')
  .description('Run the credential-free Atlas risk demo')
  .option('-c, --config <path>', 'config path', 'openprojects.config.yaml')
  .option('--approval', 'exercise an external-write approval')
  .option('--approve', 'approve the pending demo action')
  .action(async (options: { config: string; approval?: boolean; approve?: boolean }) => {
    const { createApp } = await import('./app.js');
    const app = await createApp({
      configPath: options.config,
      databasePath: ':memory:',
      seedDemo: true,
      integrationMode: 'offline',
    });
    try {
      let outcome = await app.runtime.start({
        message: options.approval
          ? 'Draft and send the Atlas blocker follow-up to the backend lead.'
          : 'Why is Atlas late and what should we do next?',
        workspaceId: 'local',
        actorId: 'demo-user',
        projectId: 'project-atlas',
        channel: 'cli',
      });
      printOutcome(outcome);
      if (options.approve) {
        for (const approval of outcome.approvals.filter((item) => item.status === 'pending')) {
          outcome = await app.runtime.resolveApproval(approval.id, 'approve', 'demo-user', 'CLI demo approval');
        }
        printOutcome(outcome);
      }
    } finally {
      await app.close();
    }
  });

program
  .command('chat')
  .description('Open a standalone direct-runtime chat (does not attach to the OpenProjects service)')
  .option('-c, --config <path>', 'config path', 'openprojects.config.yaml')
  .option('-w, --workspace <id>', 'workspace ID', 'local')
  .option('--actor <id>', 'local actor identity', 'local-user')
  .option('-p, --project <id>', 'optional project ID')
  .option('--demo', 'explicitly seed the Atlas development fixture and use it when --project is omitted')
  .action(async (options: {
    config: string;
    workspace: string;
    actor: string;
    project?: string;
    demo?: boolean;
  }) => {
    const [{ createInterface }, { createApp }] = await Promise.all([
      import('node:readline/promises'),
      import('./app.js'),
    ]);
    const app = await createApp({ configPath: options.config, seedDemo: options.demo === true });
    const readline = createInterface({ input: stdin, output: stdout });
    let sessionId: string | undefined;
    const projectId = options.project ?? (options.demo === true ? 'project-atlas' : undefined);
    stdout.write('OpenProjects standalone chat (direct runtime; not attached to the service). Type /exit to quit.\n');
    try {
      while (true) {
        const message = (await readline.question('you> ')).trim();
        if (!message || message === '/exit') break;
        let outcome = await app.runtime.start({
          message,
          workspaceId: options.workspace,
          actorId: options.actor,
          ...(projectId ? { projectId } : {}),
          ...(sessionId ? { sessionId } : {}),
          channel: 'cli',
        });
        sessionId = outcome.run.sessionId;
        for (const approval of outcome.approvals.filter((item) => item.status === 'pending')) {
          stdout.write(`Approval: ${approval.toolName} ${approval.arguments}\n`);
          const answer = (await readline.question('approve once? [y/N] ')).trim().toLocaleLowerCase();
          outcome = await app.runtime.resolveApproval(
            approval.id,
            answer === 'y' || answer === 'yes' ? 'approve' : 'reject',
            options.actor,
            'interactive CLI decision',
          );
        }
        stdout.write(`agent> ${outcome.run.output ?? outcome.run.error ?? outcome.run.status}\n`);
      }
    } finally {
      readline.close();
      await app.close();
    }
  });

program
  .command('eval')
  .description('Run the versioned deterministic eval suite')
  .option('-c, --config <path>', 'config path', 'openprojects.config.yaml')
  .option('-s, --suite <path>', 'suite path', 'evals/project-ops.json')
  .option('--json', 'print machine-readable JSON')
  .action(async (options: { config: string; suite: string; json?: boolean }) => {
    const { runEvalSuite } = await import('./eval/runner.js');
    const result = await runEvalSuite(options.config, options.suite);
    if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(`${result.passed ? 'PASS' : 'FAIL'} ${result.suiteId}@${result.suiteVersion} — ${(result.passRate * 100).toFixed(0)}% passed, ${result.averageToolCalls.toFixed(1)} avg tool calls\n`);
      for (const evalCase of result.cases) {
        stdout.write(`${evalCase.passed ? '✓' : '✗'} ${evalCase.id} (${evalCase.durationMs}ms)${evalCase.error ? ` — ${evalCase.error}` : ''}\n`);
        for (const assertion of evalCase.assertions.filter((item) => !item.passed)) {
          stdout.write(`  expected ${assertion.name}: ${JSON.stringify(assertion.expected)}, got ${JSON.stringify(assertion.actual)}\n`);
        }
      }
    }
    if (!result.passed) process.exitCode = 1;
  });

program
  .command('eval-harness-footprint')
  .description('Enforce the disposable mock/demo harness footprint gate for a 4 GB-tier host')
  .option('-c, --config <path>', 'source config path', 'openprojects.config.yaml')
  .option('--json', 'print the versioned machine-readable report')
  .action(async (options: { config: string; json?: boolean }) => {
    const { runHarnessFootprintEval } = await import('./eval/harness-footprint.js');
    const report = await runHarnessFootprintEval({ configPath: options.config });
    if (options.json) {
      stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      const label = report.overall === 'passed' ? 'PASS' : report.overall === 'diagnostic' ? 'DIAGNOSTIC' : 'FAIL';
      stdout.write(`${label} harness-footprint ${report.tier} — promotion=${report.gate.promotionEligible ? 'eligible' : 'blocked'}\n`);
      if (report.measurements) {
        const measured = report.measurements;
        const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);
        stdout.write(`startup=${measured.startupMs.toFixed(1)}ms; idle=${mib(measured.idleRssBytes)}MiB; `
          + `peak=${mib(measured.lifecyclePeakRssBytes)}MiB; run=${measured.runLatencyMs.toFixed(1)}ms\n`);
        stdout.write(`sqlite live/final=${mib(measured.database.afterRun.totalBytes)}/${mib(measured.database.final.totalBytes)}MiB; `
          + `shutdown=${measured.shutdownMs.toFixed(1)}ms\n`);
      }
      for (const assertion of report.assertions.filter((item) => !item.passed)) {
        stdout.write(`✗ ${assertion.id} — ${assertion.detail}\n`);
      }
      if (report.error) stdout.write(`Error: ${report.error}\n`);
    }
    if (!report.gate.promotionEligible) process.exitCode = 1;
  });

program
  .command('eval-local-4gb')
  .description('Qualify an already-running, content-addressed local model inside the strict 4 GiB gate')
  .requiredOption('-c, --config <path>', 'project_analysis-only candidate config path')
  .requiredOption('-q, --qualification-manifest <path>', 'reviewed appliance capability/pin manifest')
  .requiredOption('-d, --deployment-manifest <path>', 'reviewed runtime/model/PID/argv deployment manifest')
  .option('--soak-ms <number>', 'resource observation duration; Linux defaults to the 30-minute certification minimum')
  .option('--timeout-ms <number>', 'project-analyst qualification budget', '300000')
  .option('--json', 'print the versioned machine-readable report')
  .action(async (options: {
    config: string;
    qualificationManifest: string;
    deploymentManifest: string;
    soakMs?: string;
    timeoutMs: string;
    json?: boolean;
  }) => {
    const { runLocalFourGbEval } = await import('./eval/local-4gb.js');
    const report = await runLocalFourGbEval({
      configPath: options.config,
      qualificationManifestPath: options.qualificationManifest,
      deploymentManifestPath: options.deploymentManifest,
      ...(options.soakMs !== undefined ? { soakMs: Number(options.soakMs) } : {}),
      timeoutMs: Number(options.timeoutMs),
    });
    if (options.json) {
      stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      const label = report.gate.portableTrueFourGiB.certified
        ? 'PASS'
        : report.overall === 'diagnostic'
          ? 'DIAGNOSTIC'
          : 'FAIL';
      const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);
      stdout.write(`${label} local-4gb ${report.candidate.routeId} — portable certification=`
        + `${report.gate.portableTrueFourGiB.certified ? 'yes' : 'blocked'}\n`);
      stdout.write(`quality=${report.gate.qualityPassed ? 'passed' : 'failed'}; `
        + `artifact/process identity=${report.gate.identityBound ? 'bound' : 'not bound'}; `
        + `argv posture=${report.gate.posturePassed ? 'passed' : 'failed'}\n`);
      if (report.resources) {
        stdout.write(`process-tree peak=${mib(report.resources.combinedProcessTreeRssPeakBytes)}MiB; `
          + `duration=${report.resources.durationMs}ms; samples=${report.resources.sampleCount}\n`);
        if (report.resources.cgroup) {
          stdout.write(`cgroup kernel peak=${mib(report.resources.cgroup.kernelMemoryPeakBytes)}MiB; `
            + `swap kernel peak=${mib(report.resources.cgroup.kernelSwapPeakBytes)}MiB; `
            + `limit=${report.resources.cgroup.limitBytes === null ? 'unbounded' : `${mib(report.resources.cgroup.limitBytes)}MiB`}\n`);
        }
      }
      if (report.gate.macosAppBudget.evidenceCollected) {
        stdout.write(`macOS app-budget evidence=${report.gate.macosAppBudget.withinBudget ? 'within 4 GiB' : 'over 4 GiB'}; `
          + 'this is not 4 GiB machine certification\n');
      }
      for (const assertion of report.assertions.filter((item) => !item.passed && item.scope !== 'macos-app-budget')) {
        stdout.write(`✗ ${assertion.id} — ${assertion.detail}\n`);
      }
      if (report.error) stdout.write(`Error: ${report.error}\n`);
    }
    if (!report.gate.promotionEligible) process.exitCode = 1;
  });

program
  .command('eval-representative')
  .description('Run the representative offline safety/durability corpus, with an explicitly opt-in live analyst lane')
  .option('-c, --config <path>', 'source config path', 'openprojects.config.yaml')
  .option('-s, --suite <path>', 'representative corpus path', 'evals/openprojects-representative.v1.json')
  .option('--live', 'explicitly enable the route-isolated live project-analyst cases')
  .option('--live-config <path>', 'candidate config path; defaults to --config (requires --live)')
  .option('-m, --manifest <path>', 'reviewed capability/pin manifest (requires --live)')
  .option('-r, --route <id>', 'project_analysis-only candidate route ID (requires --live)')
  .option('--timeout-ms <number>', 'live identity/protocol preflight budget', '300000')
  .option('--json', 'print the versioned machine-readable report')
  .action(async (options: {
    config: string;
    suite: string;
    live?: boolean;
    liveConfig?: string;
    manifest?: string;
    route?: string;
    timeoutMs: string;
    json?: boolean;
  }) => {
    const { runRepresentativeEval } = await import('./eval/representative.js');
    if (options.live !== true && (options.liveConfig || options.manifest || options.route)) {
      throw new Error('--live-config, --manifest, and --route are inert without the explicit --live flag');
    }
    if (options.live === true && (!options.manifest || !options.route)) {
      throw new Error('--live requires both --manifest and --route');
    }
    const report = await runRepresentativeEval({
      configPath: options.config,
      corpusPath: options.suite,
      ...(options.live === true
        ? {
            live: {
              ...(options.liveConfig ? { configPath: options.liveConfig } : {}),
              manifestPath: options.manifest!,
              routeId: options.route!,
              timeoutMs: Number(options.timeoutMs),
            },
          }
        : {}),
    });
    if (options.json) {
      stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      stdout.write(`${report.passed ? 'PASS' : 'FAIL'} ${report.corpus.id}@${report.corpus.version} — `
        + `${(report.deterministic.passRate * 100).toFixed(0)}% deterministic; live=${report.live.status}\n`);
      for (const coverage of report.coverage) {
        stdout.write(`${coverage.passedCount === coverage.caseCount ? '✓' : '✗'} ${coverage.category} `
          + `${coverage.passedCount}/${coverage.caseCount}\n`);
      }
      for (const evalCase of report.deterministic.cases.filter((item) => !item.passed)) {
        stdout.write(`✗ ${evalCase.id}${evalCase.error ? ` — ${evalCase.error}` : ''}\n`);
        for (const assertion of evalCase.assertions.filter((item) => !item.passed)) {
          stdout.write(`  ${assertion.name}: expected ${JSON.stringify(assertion.expected)}, got ${JSON.stringify(assertion.actual)}\n`);
        }
      }
      for (const evalCase of report.live.cases.filter((item) => !item.passed)) {
        stdout.write(`✗ live ${evalCase.id}${evalCase.error ? ` — ${evalCase.error}` : ''}\n`);
      }
    }
    if (!report.passed) process.exitCode = 1;
  });

program
  .command('eval-project-analyst')
  .description('Run the route-isolated live project-analyst eligibility gate')
  .requiredOption('-c, --config <path>', 'candidate config path')
  .requiredOption('-m, --manifest <path>', 'reviewed capability/pin manifest')
  .requiredOption('-r, --route <id>', 'project_analysis-only candidate route ID')
  .option('-n, --attempts <number>', 'bounded live attempts (1-10)', '3')
  .option('--timeout-ms <number>', 'identity/protocol preflight budget', '300000')
  .option('--json', 'print the versioned machine-readable report')
  .action(async (options: {
    config: string;
    manifest: string;
    route: string;
    attempts: string;
    timeoutMs: string;
    json?: boolean;
  }) => {
    const { runProjectAnalystEval } = await import('./eval/project-analyst.js');
    const report = await runProjectAnalystEval({
      configPath: options.config,
      manifestPath: options.manifest,
      routeId: options.route,
      attempts: Number(options.attempts),
      timeoutMs: Number(options.timeoutMs),
    });
    if (options.json) {
      stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      stdout.write(`${report.passed ? 'PASS' : 'FAIL'} project-analyst ${report.candidate.routeId} — ${(report.passRate * 100).toFixed(0)}%\n`);
      stdout.write(`project_analysis=${report.statuses.projectAnalysis}; supervisor=${report.statuses.supervisor}; semantic_embeddings=${report.statuses.semanticEmbeddings}; vision=${report.statuses.vision}\n`);
      for (const attempt of report.attempts) {
        stdout.write(`${attempt.passed ? '✓' : '✗'} attempt ${attempt.index} (${attempt.durationMs}ms)${attempt.error ? ` — ${attempt.error}` : ''}\n`);
        for (const assertion of attempt.assertions.filter((item) => !item.passed)) {
          stdout.write(`  ${assertion.name}: ${assertion.detail}\n`);
        }
      }
    }
    if (!report.passed) process.exitCode = 1;
  });

program
  .command('eval-semantic-embeddings')
  .description('Run the pinned live semantic-retrieval and stability gate')
  .requiredOption('-c, --config <path>', 'candidate config path')
  .requiredOption('-m, --manifest <path>', 'reviewed capability/pin manifest')
  .option('--batches <number>', 'bounded sequential batches (2-10)', '3')
  .option('--json', 'print the versioned machine-readable report')
  .action(async (options: {
    config: string;
    manifest: string;
    batches: string;
    json?: boolean;
  }) => {
    const { runSemanticEmbeddingEval } = await import('./eval/semantic-embeddings.js');
    const report = await runSemanticEmbeddingEval({
      configPath: options.config,
      manifestPath: options.manifest,
      batches: Number(options.batches),
    });
    if (options.json) {
      stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      stdout.write(`${report.passed ? 'PASS' : 'FAIL'} semantic-embeddings ${report.candidate.model} — `
        + `R@1=${report.metrics.recallAt1.toFixed(3)} R@3=${report.metrics.recallAt3.toFixed(3)} `
        + `MRR=${report.metrics.meanReciprocalRank.toFixed(3)}\n`);
      stdout.write(`preflight=${report.preflight.qualified ? 'qualified' : 'failed'}; `
        + `semantic_embeddings=${report.statuses.semanticEmbeddings}; supervisor=${report.statuses.supervisor}; vision=${report.statuses.vision}\n`);
      stdout.write(`batches=${report.successfulBatches}/${report.requestedBatches}; errors=${report.errorCount}; `
        + `latency p50/p95=${report.latencyMs.p50 ?? 'n/a'}/${report.latencyMs.p95 ?? 'n/a'}ms\n`);
      for (const batch of report.batches) {
        stdout.write(`${batch.passed ? '✓' : '✗'} batch ${batch.index} (${batch.durationMs}ms)${batch.error ? ` — ${batch.error}` : ''}\n`);
      }
    }
    if (!report.passed) process.exitCode = 1;
  });

program
  .command('eval-vision')
  .description('Run the pinned local VLM readiness gate; product image ingestion remains disabled')
  .requiredOption('-c, --config <path>', 'candidate config path')
  .requiredOption('-m, --manifest <path>', 'reviewed capability, model, and runtime manifest')
  .option('-s, --suite <path>', 'hash-bound vision corpus path; defaults to the bundled corpus')
  .option('--batches <number>', 'sequential corpus batches (1-10; promotion requires at least 50 cases)', '10')
  .option('--timeout-ms <number>', 'total qualification and evaluation budget', '300000')
  .option('--json', 'print the versioned machine-readable report')
  .action(async (options: {
    config: string;
    manifest: string;
    suite?: string;
    batches: string;
    timeoutMs: string;
    json?: boolean;
  }) => {
    const { runVisionEval } = await import('./eval/vision.js');
    const report = await runVisionEval({
      configPath: options.config,
      manifestPath: options.manifest,
      ...(options.suite ? { corpusPath: options.suite } : {}),
      batches: Number(options.batches),
      timeoutMs: Number(options.timeoutMs),
    });
    if (options.json) {
      stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      const label = report.overall === 'passed' ? 'PASS' : report.overall === 'not_run' ? 'NOT RUN' : 'FAIL';
      stdout.write(`${label} vision-readiness ${report.candidate.model} — `
        + `${report.passedCases}/${report.totalCaseAttempts} cases, `
        + `promotion=${report.gate.promotionEligible ? 'eligible' : 'blocked'}\n`);
      stdout.write(`preflight=${report.preflight.qualified ? 'qualified' : 'failed'}; `
        + `product_vision=${report.statuses.productVision}; supervisor=${report.statuses.supervisor}\n`);
      stdout.write(`batches=${report.completedBatches}/${report.requestedBatches}; errors=${report.errorCount}; `
        + `latency p50/p95=${report.latencyMs.p50 ?? 'n/a'}/${report.latencyMs.p95 ?? 'n/a'}ms\n`);
      for (const result of report.cases) {
        stdout.write(`${result.passedEveryBatch ? '✓' : '✗'} ${result.id} ${result.passes}/${result.attempts}\n`);
      }
      if (report.overall === 'not_run') stdout.write(`Preflight: ${report.preflight.detail}\n`);
    }
    if (report.overall !== 'passed') process.exitCode = 1;
  });

program
  .command('doctor')
  .description('Validate composition and optionally probe private-appliance readiness')
  .option('-c, --config <path>', 'config path', 'openprojects.config.yaml')
  .option('--probe', 'make bounded model/embedding requests and inspect local prerequisites')
  .option('--timeout-ms <number>', 'per-service probe timeout in milliseconds', '10000')
  .option('--json', 'print the versioned machine-readable readiness report')
  .action(async (options: { config: string; probe?: boolean; timeoutMs: string; json?: boolean }) => {
    const [
      { loadConfig },
      { createApp },
      { renderDoctorReport, runDoctor },
    ] = await Promise.all([
      import('./config.js'),
      import('./app.js'),
      import('./doctor.js'),
    ]);
    const configured = loadConfig(options.config);
    const app = await createApp({
      config: configured,
      databasePath: ':memory:',
      seedDemo: false,
      integrationMode: 'offline',
    });
    try {
      const report = await runDoctor(app, {
        probe: options.probe === true,
        timeoutMs: Number(options.timeoutMs),
        databasePath: configured.storage.database,
      });
      stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderDoctorReport(report));
      if (report.overall === 'not_ready') process.exitCode = 1;
    } finally {
      await app.close();
    }
  });

program
  .command('qualify')
  .description('Run bounded, no-download capability and identity probes for a private appliance')
  .option('-c, --config <path>', 'config path', 'openprojects.config.yaml')
  .option('-m, --manifest <path>', 'reviewed JSON capability/pin manifest')
  .option('--require <capabilities>', 'comma-separated text, vision, embeddings, transcription')
  .option('--timeout-ms <number>', 'total qualification budget in milliseconds', '30000')
  .option('--json', 'print the versioned machine-readable qualification report')
  .action(async (options: {
    config: string;
    manifest?: string;
    require?: string;
    timeoutMs: string;
    json?: boolean;
  }) => {
    const [
      { loadConfig },
      {
        loadQualificationManifest,
        renderApplianceQualification,
        runApplianceQualification,
      },
    ] = await Promise.all([
      import('./config.js'),
      import('./qualification/index.js'),
    ]);
    const configured = loadConfig(options.config);
    const manifest = options.manifest
      ? await loadQualificationManifest(options.manifest)
      : undefined;
    const requiredCapabilities = options.require
      ? options.require.split(',').map((value) => value.trim()).filter(Boolean) as QualificationCapability[]
      : undefined;
    const report = await runApplianceQualification(configured, {
      ...(manifest ? { manifest } : {}),
      ...(requiredCapabilities ? { requiredCapabilities } : {}),
      timeoutMs: Number(options.timeoutMs),
    });
    stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderApplianceQualification(report));
    if (report.overall !== 'qualified') process.exitCode = 1;
  });

const integrations = program
  .command('integrations')
  .description('Validate reviewed MCP and JSON API integration manifests');

integrations
  .command('check')
  .description('Validate manifests offline, or explicitly probe configured peers')
  .option('-c, --config <path>', 'config path', 'openprojects.config.yaml')
  .option('--probe', 'read credentials and connect to every configured MCP/JSON peer')
  .option('--json', 'print the versioned machine-readable report')
  .action(async (options: { config: string; probe?: boolean; json?: boolean }) => {
    const [
      { loadConfig },
      { renderIntegrationCheck, runIntegrationCheck },
    ] = await Promise.all([
      import('./config.js'),
      import('./integrations/check.js'),
    ]);
    const report = await runIntegrationCheck(loadConfig(options.config, {
      loadEnv: options.probe === true,
    }), {
      probe: options.probe === true,
    });
    stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderIntegrationCheck(report));
    if (report.overall === 'not_ready') process.exitCode = 1;
  });

const sidecars = program
  .command('sidecars')
  .description('Validate, probe, or run bounded read-only Corporate Oracle provider sidecars');

sidecars
  .command('check')
  .description('Validate and content-address one sidecar config without reading credentials or using the network')
  .requiredOption('-c, --config <path>', 'sidecar YAML/JSON config path')
  .option('--json', 'print the versioned machine-readable report')
  .action(async (options: { config: string; json?: boolean }) => {
    const [{ loadSidecarConfig }, { renderSidecarReport, sidecarCheckReport }] = await Promise.all([
      import('./sidecars/config.js'),
      import('./sidecars/runner.js'),
    ]);
    const report = sidecarCheckReport(loadSidecarConfig(options.config));
    stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderSidecarReport(report));
    if (report.overall === 'not_ready') process.exitCode = 1;
  });

sidecars
  .command('probe')
  .description('Perform exact live provider identity/read probes without connecting to or writing the Oracle')
  .requiredOption('-c, --config <path>', 'sidecar YAML/JSON config path')
  .option('--json', 'print the versioned machine-readable report')
  .action(async (options: { config: string; json?: boolean }) => {
    const [{ loadSidecarConfig }, {
      renderSidecarReport,
      runSidecarProbe,
      sidecarFailureReport,
    }] = await Promise.all([
      import('./sidecars/config.js'),
      import('./sidecars/runner.js'),
    ]);
    const loaded = loadSidecarConfig(options.config);
    let report;
    try {
      report = await runSidecarProbe(loaded);
    } catch (error) {
      report = sidecarFailureReport(loaded, 'probe', error);
    }
    stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderSidecarReport(report));
    if (report.overall === 'not_ready') process.exitCode = 1;
  });

sidecars
  .command('sync')
  .description('Fetch and durably commit a finite provider window through an ingest-only Oracle principal')
  .requiredOption('-c, --config <path>', 'sidecar YAML/JSON config path')
  .option('--json', 'print the versioned machine-readable report')
  .action(async (options: { config: string; json?: boolean }) => {
    const [{ loadSidecarConfig }, {
      renderSidecarReport,
      runSidecarSync,
      sidecarFailureReport,
    }] = await Promise.all([
      import('./sidecars/config.js'),
      import('./sidecars/runner.js'),
    ]);
    const loaded = loadSidecarConfig(options.config);
    let report;
    try {
      report = await runSidecarSync(loaded);
    } catch (error) {
      report = sidecarFailureReport(loaded, 'sync', error);
    }
    stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderSidecarReport(report));
    if (report.overall === 'not_ready') process.exitCode = 1;
  });

const learning = program.command('learning').description('Inspect and export bounded learning state');

learning
  .command('stats')
  .description('Show reinforcement-memory and model-route statistics')
  .option('-c, --config <path>', 'config path', 'openprojects.config.yaml')
  .option('-w, --workspace <id>', 'workspace ID', 'local')
  .action(async (options: { config: string; workspace: string }) => {
    const { createApp } = await import('./app.js');
    const app = await createApp({ configPath: options.config, seedDemo: false, integrationMode: 'offline' });
    try {
      stdout.write(`${JSON.stringify(app.storage.learningStats(options.workspace), null, 2)}\n`);
    } finally {
      await app.close();
    }
  });

learning
  .command('embed')
  .description('Build or refresh local embeddings for scoped memories')
  .option('-c, --config <path>', 'config path', 'openprojects.config.yaml')
  .option('-w, --workspace <id>', 'workspace ID', 'local')
  .option('-p, --project <id>', 'optional project ID')
  .action(async (options: { config: string; workspace: string; project?: string }) => {
    const { createApp } = await import('./app.js');
    const app = await createApp({ configPath: options.config, seedDemo: false, integrationMode: 'offline' });
    let embedded = 0;
    let skippedUnreviewed = 0;
    const failures: Array<{ id: string; error: string }> = [];
    try {
      for (const memory of app.storage.listMemories(options.workspace, options.project, 10_000)) {
        if (memory.status !== 'active') {
          skippedUnreviewed += 1;
          continue;
        }
        try {
          await app.memoryEngine.embedMemory(memory.id);
          embedded += 1;
        } catch (error) {
          failures.push({ id: memory.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      stdout.write(`${JSON.stringify({
        embedding: app.embedding.id,
        embedded,
        skippedUnreviewed,
        failures,
      }, null, 2)}\n`);
      if (failures.length) process.exitCode = 1;
    } finally {
      await app.close();
    }
  });

learning
  .command('export')
  .description('Export redacted reward, SFT-correction, or preference JSONL; never trains automatically')
  .option('-c, --config <path>', 'config path', 'openprojects.config.yaml')
  .option('-f, --format <kind>', 'rewards, sft, preferences, or all', 'all')
  .option('--manifest', 'print the manifest instead of JSONL')
  .action(async (options: { config: string; format: string; manifest?: boolean }) => {
    const [{ createApp }, { exportLearningDatasets }] = await Promise.all([
      import('./app.js'),
      import('./learning/export.js'),
    ]);
    const allowed: LearningDatasetKind[] = ['rewards', 'sft', 'preferences'];
    if (options.format !== 'all' && !allowed.includes(options.format as LearningDatasetKind)) {
      throw new Error('format must be rewards, sft, preferences, or all');
    }
    const kinds = options.format === 'all' ? allowed : [options.format as LearningDatasetKind];
    const app = await createApp({ configPath: options.config, seedDemo: false, integrationMode: 'offline' });
    try {
      const exported = exportLearningDatasets(app.storage, { kinds });
      if (options.manifest) stdout.write(`${JSON.stringify(exported.manifest, null, 2)}\n`);
      else for (const dataset of exported.datasets) stdout.write(dataset.jsonl);
    } finally {
      await app.close();
    }
  });

learning
  .command('purge')
  .description('Apply configured retention to group observations and derived memories')
  .option('-c, --config <path>', 'config path', 'openprojects.config.yaml')
  .option('-w, --workspace <id>', 'workspace ID', 'local')
  .action(async (options: { config: string; workspace: string }) => {
    const { createApp } = await import('./app.js');
    const app = await createApp({ configPath: options.config, seedDemo: false, integrationMode: 'offline' });
    try {
      stdout.write(`${JSON.stringify(app.memoryEngine.purgeExpired({ workspaceId: options.workspace }), null, 2)}\n`);
    } finally {
      await app.close();
    }
  });

program
  .command('notify')
  .description('Plan deterministic deadline notifications without sending them')
  .option('-c, --config <path>', 'config path', 'openprojects.config.yaml')
  .option('--as-of <iso>', 'planning timestamp')
  .action(async (options: { config: string; asOf?: string }) => {
    const { createApp } = await import('./app.js');
    const app = await createApp({ configPath: options.config, seedDemo: false, integrationMode: 'offline' });
    try {
      const asOf = new Date(options.asOf ?? Date.now()).toISOString();
      const planned = app.storage.planDeadlineNotifications(asOf, app.config.notifications?.lookaheadHours ?? 48);
      stdout.write(`${JSON.stringify({ planned }, null, 2)}\n`);
    } finally {
      await app.close();
    }
  });

program
  .command('export-feedback')
  .description('Deprecated alias for the redacted rewards JSONL export')
  .option('-c, --config <path>', 'config path', 'openprojects.config.yaml')
  .action(async ({ config }: { config: string }) => {
    const [{ createApp }, { exportLearningDatasets }] = await Promise.all([
      import('./app.js'),
      import('./learning/export.js'),
    ]);
    const app = await createApp({ configPath: config, seedDemo: false, integrationMode: 'offline' });
    try {
      const exported = exportLearningDatasets(app.storage, {
        kinds: ['rewards'],
        includeComments: false,
      });
      stdout.write(exported.datasets[0]?.jsonl ?? '');
    } finally {
      await app.close();
    }
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  stderr.write(`OpenProjects: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function printOutcome(outcome: ReturnType<import('./runtime/agent.js').AgentRuntime['outcome']>): void {
  stdout.write(`\nRun ${outcome.run.id}: ${outcome.run.status}\n`);
  if (outcome.run.output) stdout.write(`${outcome.run.output}\n`);
  if (outcome.run.error) stdout.write(`Error: ${outcome.run.error}\n`);
  for (const approval of outcome.approvals.filter((item) => item.status === 'pending')) {
    stdout.write(`Pending approval ${approval.id}: ${approval.toolName} ${approval.arguments}\n`);
  }
  stdout.write(`Trace: ${outcome.events.length} events, ${outcome.run.toolCalls} tool call(s)\n`);
}

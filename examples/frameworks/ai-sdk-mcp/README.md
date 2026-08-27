# AI SDK + MCP interoperability example

This is an optional showcase package, not a framework migration and not a
production dependency of OpenProjects. A local OpenAI-compatible model uses
Vercel AI SDK to call one MCP tool. That tool can only start and read one
OpenProjects run through the loopback API; the existing OpenProjects runtime,
policy, budgets, snapshots, and approval kernel remain authoritative.

```text
local model -> AI SDK (2 steps max) -> one MCP tool -> loopback OpenProjects API
                                                        |
                                                        +-> existing policy/approval kernel
```

## Security boundary

- The MCP process receives a fixed principal, workspace, project, and Bearer
  credential from its host. None are tool inputs.
- Before each run, preflight calls `/api/whoami` and fails closed unless the identity is
  exact, its capabilities are exactly `read` and `run`, and its workspace list
  contains exactly the configured workspace. `admin`, `approve`, `all`, and
  multi-workspace credentials are rejected.
- The only model-controlled field is `question`, limited to 4,096 UTF-8 bytes.
- The facade never calls an approval endpoint. A run that reaches
  `waiting_for_approval` is returned unchanged for review in OpenProjects.
- Both service and model URLs must be loopback. Redirects, oversized responses,
  unbounded polling, retries, extra MCP tools, and response-controlled scope are
  rejected.
- The AI SDK loop forces the MCP tool on step one, wraps execution in an atomic
  one-shot guard, disables all tools on step two, and treats tool output as
  untrusted data. Duplicate calls in one model response cannot start duplicate
  runs, and project-content prompt injection cannot trigger another tool call.

The tool starts a durable run that can reach policy-controlled effectful or
external tools, so its MCP annotations conservatively mark it as potentially
destructive/open-world and not read-only or idempotent. Those annotations are
only UI hints; the OpenProjects policy and approval kernel remains the actual
authority. The bridge credential cannot approve or administer anything.

## Run it

Requirements: Node.js 24+, a running OpenProjects loopback service, one control
principal scoped to exactly one workspace with only `read` and `run`, and a
qualified local model server exposing an OpenAI-compatible chat endpoint.
Ollama, llama.cpp servers, LM Studio, or an MLX-backed OpenAI-compatible server
can sit behind the model boundary; the example does not couple OpenProjects to
one model runtime.

```bash
cd examples/frameworks/ai-sdk-mcp
npm ci --ignore-scripts
npm run build

export OPENPROJECTS_BASE_URL='http://127.0.0.1:4100'
export OPENPROJECTS_CONTROL_TOKEN='replace-with-a-protected-32-character-minimum-token'
export OPENPROJECTS_PRINCIPAL_ID='framework-runner'
export OPENPROJECTS_WORKSPACE_ID='local'
export OPENPROJECTS_PROJECT_ID='project-id'

export LOCAL_MODEL_BASE_URL='http://127.0.0.1:11434/v1'
export LOCAL_MODEL_ID='your-qualified-local-model'

npm run demo -- 'What deadlines or risks need attention?'
```

PowerShell on Windows:

```powershell
Set-Location examples/frameworks/ai-sdk-mcp
npm ci --ignore-scripts
npm run build

$env:OPENPROJECTS_BASE_URL = 'http://127.0.0.1:4100'
$env:OPENPROJECTS_CONTROL_TOKEN = 'replace-with-a-protected-32-character-minimum-token'
$env:OPENPROJECTS_PRINCIPAL_ID = 'framework-runner'
$env:OPENPROJECTS_WORKSPACE_ID = 'local'
$env:OPENPROJECTS_PROJECT_ID = 'project-id'

$env:LOCAL_MODEL_BASE_URL = 'http://127.0.0.1:11434/v1'
$env:LOCAL_MODEL_ID = 'your-qualified-local-model'

npm run demo -- 'What deadlines or risks need attention?'
```

`LOCAL_MODEL_API_KEY` is optional for loopback servers that require a token.
The following optional bounds have conservative defaults:

| Variable | Default | Accepted range |
| --- | ---: | ---: |
| `OPENPROJECTS_REQUEST_TIMEOUT_MS` | 10,000 | 250-30,000 |
| `OPENPROJECTS_RUN_TIMEOUT_MS` | 45,000 | 1,000-120,000 |
| `OPENPROJECTS_POLL_INTERVAL_MS` | 250 | 25-2,000 |

The outer AI SDK deadline is derived from the configured request and run
bounds, so increasing the durable-run deadline does not get silently cut off by
a shorter fixed tool timeout. Explicit client cancellation can still leave an
already-started durable OpenProjects run active; inspect that run by its ID.

## Verify it

```bash
npm run check
```

The deterministic suite uses Node's test runner, an in-memory MCP transport,
AI SDK's mock language model, and one real stdio child connected to a temporary
loopback HTTP server. It makes no real model or external network call. Tests
prove fixed identity/workspace/project binding, strict prompt and tool schemas,
approval non-resolution, prompt-injection loop containment, cancellation,
response scope validation, stdio interoperability, and isolation from the root
production dependency graph.

Primary references:

- [AI SDK ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent)
- [AI SDK MCP tools](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)
- [AI SDK OpenAI-compatible providers](https://ai-sdk.dev/providers/openai-compatible-providers)
- [MCP architecture](https://modelcontextprotocol.io/specification/2026-07-28/architecture)
- [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)

# Session 3: Local Tools, Sandboxing, and Feature-Policy Completion

## Objective

Complete the LiteLLM migration by deciding and implementing the remaining
Claude Code-native capabilities safely. This session adds only approved local
tools through the Session 2 registry, establishes actual sandbox enforcement,
and resolves skills, subagents, model fallback monitoring, configuration, and
documentation parity.

## Required Reading

Read all migration documents and the completed handoff notes. Inspect current
code before choosing which optional parity features to implement.

- `docs/litellm-migration/session-1-provider-and-history.md`
- `docs/litellm-migration/session-2-tools-and-mcp.md`
- `docs/litellm-migration/session-3-sandbox-and-parity.md`

## Preconditions

Sessions 1 and 2 must provide:

- a typed internal agent-event protocol;
- a LiteLLM OpenAI-compatible client and application-owned transcript;
- a bounded agent/tool loop;
- one centralized allowlist/denylist authorization gate;
- MCP and custom-action dispatchers;
- an internal tool registry that Session 3 can extend.

If the preceding tool-policy gate is absent, do not add local tools. First
restore the invariant that every tool is authorized at dispatch time.

## Why This Session Is Separate

The old Claude Agent SDK supplied a sandbox and native tools. The repository's
existing configuration only describes those SDK capabilities; it is not an
independent sandbox.

For example, `src/config.ts` builds an SDK `sandbox` option with filesystem and
network rules. Removing the SDK means those rules do nothing unless this
session implements equivalent operating-system or container-level enforcement.
Giving a model a `Bash` tool without such enforcement would weaken the
application's security boundary.

## Existing Behavior to Account For

### Workspace and uploaded files

- `src/config.ts` provisions a per-thread workspace under
  `/tmp/slack-ai-agent/workspaces/<session-key>` and copies `.claude/` and
  `data/` into it.
- `src/file-handler.ts` downloads uploads to `/tmp/slack-file-*` and prompts
  Claude Code to read them.
- Thread workspaces are removed by inactive-session cleanup.
- GCloud CLI authentication needs read/write access to `~/.config/gcloud`.
- AWS CLI may access instance metadata and AWS endpoints.

Uploaded paths are outside the per-thread workspace. If a local `Read` tool is
introduced, it must explicitly allow only the files associated with the current
Slack request/session. Never allow unrestricted `/tmp` access merely to support
uploads.

### Current policy configuration

`config/tool-allowlist.yaml` lists Claude-native tool labels, including:

```text
BashOutput, ExitPlanMode, Glob, Grep, ListMcpResources, Read,
ReadMcpResource, Skill, Task, TodoWrite, WebFetch, WebSearch, Write,
and patterns such as Bash(rg:*).
```

`config/tool-denylist.yaml` blocks certain Bash command patterns.

The old SDK matched this grammar. Session 2 may have retained or migrated it.
This session must use its centralized policy matcher and update configuration
and documentation atomically if additional syntax is required. Never introduce
a second, inconsistent authorization parser.

### Skills and subagents

- `.claude/` is copied into thread workspaces, but it is deployment-provided;
  no tracked `.claude/` directory exists in this checkout.
- `src/validation-agent.ts` only translates YAML into Claude SDK
  `options.agents`; it does not execute agents.
- `config/subagents/example-subagents.yaml` assumes Claude `Task`, model
  labels such as Sonnet, and inherited Claude SDK tools.

There is no automatic equivalent through LiteLLM. Treat skills/subagents as a
separate product feature, not a simple provider option.

### Provider-specific model behavior

- `src/request-mode.ts` has hard-coded Claude model IDs, effort levels, and
  Opus-only fast mode.
- `src/opus-health.ts` observes Claude SDK `system/model_fallback` events.
- `src/index.ts` constructs `OpusHealthMonitor` and wires Slack alerts.

LiteLLM may route providers/models but does not guarantee these event fields or
capabilities. Implement only telemetry and request parameters supported by the
configured proxy and model routes.

## Scope

Make explicit product decisions, then implement only the approved subset:

1. Implement a real sandbox boundary before enabling any process-execution
   tool.
2. Implement selected local file/search/command/web tools through the Session 2
   tool registry and policy gate.
3. Replace or retire Claude-only skill and subagent behavior intentionally.
4. Finalize model aliases/capabilities, fallback policy, and health telemetry.
5. Remove stale Claude-specific configuration, prompts, tests, dependencies,
   and documentation.
6. Perform end-to-end security and lifecycle validation.

## Mandatory Product Decisions

Document the chosen answer before implementation.

### Local command execution

Choose one:

1. **Container/process sandbox:** a dedicated per-request or per-thread
   container/jail with mounted workspace/upload inputs, controlled network,
   non-root identity, resource limits, and no application repository/secrets.
2. **No command execution:** remove `Bash` and related command policy entries.
3. **A narrowly scoped command runner:** only fixed application-owned commands
   with no shell, explicit arguments, fixed working directory, and resource
   limits. This is not a general Bash replacement.

Do not use `child_process` with `shell: true` as a substitute for the removed
Claude SDK sandbox.

### Local file tools

Choose an explicit capability set, for example:

- read only;
- workspace-scoped read/write/search;
- no writes;
- uploaded-file parsing only.

Enforce realpath containment for every path, reject symlink escape, cap file
size and output size, and define which binary/image formats are supported.

### Skills and subagents

Choose one:

1. **Defer/remove:** do not expose `Skill`, `Task`, `TodoWrite`, or
   `ExitPlanMode`; remove misleading prompt/config examples.
2. **Skills as prompt assets:** load approved workspace skill markdown by name,
   validate it against an allowlist, and inject its content into the current
   model context. No arbitrary filesystem skill lookup.
3. **Subagents:** build a bounded nested-agent runner with its own transcript,
   model selection, depth/turn/token limits, inherited authorization, and
   isolated workspace/tool context. This is substantial work and should be
   separately reviewed.

Do not present a nested LiteLLM call as an equivalent `Task` feature without
isolation and inherited policy.

### Provider fallback and cost

Choose either:

- LiteLLM-proxy-owned routing with documented proxy telemetry fields;
- application-owned fallback model retry policy restricted to safe inference
  failures before any side-effecting tools run; or
- no automatic fallback, with clear operational alerting.

Do not imitate Claude SDK `model_fallback` events. Remove or replace
`OpusHealthMonitor` based on actual LiteLLM observability data. Cost must come
from trusted proxy metadata or an explicit versioned pricing table; otherwise
remain undefined.

## Implementation Steps

1. Audit all Claude SDK remnants.
   - Search all source, tests, configs, instructions, package dependencies, and
     README text for `Claude`, `Anthropic`, `claude-agent-sdk`, `.claude`,
     `Task`, `Skill`, and native tool names.
   - Categorize each occurrence as retained functionality, renamed
     documentation, deferred feature, or obsolete code.

2. Establish the sandbox before registering local tools.
   - Define an abstraction around the selected isolation mechanism.
   - Make its input mounts/paths explicit: thread workspace, selected upload
     files, needed data, and any cloud auth paths.
   - Make denied paths explicit: repository root, application `.env`, MCP
     configuration with resolved tokens, home directory outside approved mounts,
     other thread workspaces, arbitrary `/tmp`, and provider credentials.
   - Apply CPU, memory, process, wall-time, output-size, and network limits.
   - Ensure cleanup happens on normal completion, failure, abort, retry, and
     inactive-session eviction.

3. Implement local tools one capability at a time.
   - Use stable fully qualified names such as `local__read`, `local__glob`, or
     retain the Session 2 policy grammar deliberately.
   - Define JSON Schema and strict input validation for every tool.
   - Register the tool only when the selected sandbox/capability supports it.
   - Recheck policy at dispatch time.
   - Return bounded, structured text results that do not leak denied paths or
     environment secrets.
   - For command execution, parse an explicit command/argument structure or
     use a constrained policy-aware parser. Enforce the denylist before launch;
     do not rely solely on output filtering.

4. Handle uploads safely.
   - Replace prompts that say "Claude Code will use its Read tool" with the
     actual local tool behavior.
   - Pass a per-request allowlist of upload realpaths to the local read layer.
   - Avoid retaining downloaded files in the thread transcript or workspace
     unless the retention policy explicitly permits it.

5. Implement the selected skills/subagent policy.
   - If deferred, remove them from advertised tools, allowlists, prompts, and
     example configs. Retire or rewrite `src/validation-agent.ts`.
   - If skills are retained, require known skill IDs and content limits.
   - If subagents are retained, add recursion limits, cancellation propagation,
     per-agent transcript isolation, inherited tool authorization, and model
     capability configuration. Add dedicated tests before exposing `Task`.

6. Finalize model capability/fallback/observability behavior.
   - Replace hard-coded Claude model names in `src/request-mode.ts` with
     deployment-defined aliases and capability metadata.
   - Retire `src/opus-health.ts` or replace it with LiteLLM-proxy-specific,
     documented telemetry that cannot leak prompt or credential data.
   - Update `src/index.ts` wiring and ops documentation.

7. Clean up and document the final system.
   - Remove no-longer-used Claude-specific environment variables, config,
     sandbox option helpers, tests, package dependencies, and declarations.
   - Update README architecture, setup, usage, and security constraints.
   - Update all tool allow/deny and instruction examples to match actual
     registered tools.
   - Keep `mcp-servers.example.json` aligned with Session 2's supported
     transports and header behavior.

## Required Tests

Tests must not execute unrestricted host commands or contact real external
services.

- Every local tool is absent until its required sandbox is available.
- Tool policy denies unauthorized local tools before file/process access.
- Path validation rejects repository paths, other sessions, arbitrary `/tmp`,
  parent traversal, and symlink escape.
- Only explicitly associated upload paths are readable.
- File size, output size, timeout, and binary-content limits are enforced.
- Command runner rejects denied commands and shell metacharacter bypasses.
- Command process is terminated on timeout, abort, and session cleanup.
- Sandboxed process cannot read application secrets or LiteLLM credentials.
- Sandboxed network behavior matches the selected policy.
- MCP/custom-action functionality from Session 2 continues to work after local
  tools are added.
- Deferred skills/subagents cannot be advertised or invoked.
- If implemented, skills and subagents inherit authorization and cancellation,
  cannot recurse indefinitely, and cannot access another session's context.
- Model aliases reject unsupported effort/fast/fallback parameters rather than
  forwarding invalid provider options.
- Observability and cost handling do not require Claude SDK events.

Add at least one integration-style test of a LiteLLM text response followed by
an authorized local or MCP tool call, using mocks for all external boundaries.

## Validation

Run targeted tests during development, then:

```bash
npm test -- --runInBand
npm run build
```

Also perform a manual security review of:

- process launch arguments and environment;
- allowed mount/path lists;
- network policy;
- abort and cleanup paths;
- tool authorization ordering;
- log redaction;
- identity-bound MCP separation;
- provider credential handling.

Review `git diff` and `git status`. Do not revert or include unrelated user
changes. Do not commit unless explicitly requested.

## Definition of Done

- Every advertised tool has an implementation, schema validation, policy check,
  bounded result, cancellation behavior, and appropriate isolation.
- No general host shell or filesystem access is exposed without a real sandbox.
- Uploaded files are accessible only through explicit per-request grants.
- Skills and subagents are either safely implemented or completely removed from
  the exposed product surface.
- Model routing, fallback, usage, cost, and health signals match documented
  LiteLLM capabilities rather than Claude SDK assumptions.
- No production code imports the Claude Agent SDK or relies on its hidden
  runtime services.
- Configuration, prompts, examples, README, tests, and implementation agree.
- Full tests and TypeScript build pass, or precise failures and residual risks
  are documented.

## Final Migration Record

### Session 3 implementation record

- **Provider contract:** `LITELLM_BASE_URL`, `LITELLM_API_KEY`,
  `LITELLM_MODEL`, and `LITELLM_REQUEST_TIMEOUT_MS` target the streaming
  OpenAI-compatible endpoint. Routing and fallback are LiteLLM-proxy-owned;
  the application has no model fallback and forwards no effort/fast fields.
  Usage and cost are aggregated across completed provider turns from trusted
  `usage`/`response_cost`/`total_cost` metadata and remain undefined only when
  that metadata is absent.
- **Tools/policy:** exact `mcp__<server>__<tool>` and `local__read` names only;
  role inheritance and deny precedence remain centralized in
  `McpManager.authorizeTool`, with anonymous requests denied by default.
  Local read is read-only, UTF-8 text only, with 2 MiB files, 200 lines, 16 KiB
  lines, 16,000-character results, bounded input paths/ranges, and a 5-second
  dispatch wall-clock timeout.
- **Filesystem boundary:** `local__read` resolves only the current session
  workspace or explicitly granted upload identifier using `realpath`/`lstat`
  containment checks. It rejects traversal, symlink paths/escape, repository
  paths, secret-like files, arbitrary `/tmp`, other workspaces, and home paths.
  This is an application capability boundary, not OS process isolation.
- **Uploads:** Slack downloads are checked against the declared and actual
  50 MiB limit, use sanitized names in per-download `mkdtemp` directories, and
  are removed in request-level `finally` cleanup for success, error, abort, and
  response failure. Prompts/transcripts contain only `upload:<id>` identifiers.
- **MCP:** stdio, legacy SSE, and Streamable HTTP remain supported. Dynamic
  `headersHelper` remains trusted deployment configuration, executed with the
  existing timeout and combined 32 KiB stdout/stderr buffer controls and never
  exposed as a model command tool.
- **Deferred features:** command execution, web/search, writes, skills,
  subagents, planning tools, and native Claude tools are removed/deferred.
- **Validation:** run `npm test -- --runInBand` and `npm run build`.

When the session completes, write a concise final migration record in this
document or a linked final summary containing:

- provider endpoint/auth/model configuration contract;
- supported model aliases and capabilities;
- transcript retention and trimming policy;
- all tool names, role-policy grammar, and denied defaults;
- supported MCP transports and dynamic-header behavior;
- sandbox technology and security limits;
- upload retention/access policy;
- skills/subagents status;
- fallback/telemetry/cost behavior;
- test/build commands and results;
- known limitations and operational runbook links.

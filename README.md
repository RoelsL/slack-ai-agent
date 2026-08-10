# Slack AI Agent

A Slack app powered by a provider-neutral LiteLLM proxy. Responds in DMs, channels, and @-mentions with streaming responses, thread context, read-only scoped file uploads, authorized MCP tools, and deployment-local custom actions.

## Architecture

- **`src/slack-handler.ts`** - Message routing and event handling
- **`src/agent-handler.ts`** - Session management and bounded sequential LiteLLM tool loop
- **`src/litellm-client.ts`** - Typed OpenAI-compatible HTTP/SSE client
- **`src/agent-types.ts`** - Provider-neutral stream and transcript types
- **`src/mcp-manager.ts`** - MCP configuration, identity binding, headers helper, and centralized policy gate
- **`src/mcp-client.ts`** - Per-request MCP discovery, schema adaptation, validation, timeout, and cleanup
- **`src/message-processor.ts`** - Stream processing and response formatting
- **`src/tracking.ts`** - Analytics tracking for message processing and feedback
- **`src/channel-config.ts`** - Channel-specific context and configuration management
- **`src/user-utils.ts`** - User information and role-based access control

## Setup

### 1. Install

```bash
git clone https://github.com/duolingo/slack-ai-agent.git
npm install
```

### 2. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → "Create New App" → "From an app manifest"
2. Paste the contents of `slack-app-manifest.yaml`
3. Install the app to your workspace
4. Copy the **Bot User OAuth Token** (`xoxb-...`) from "OAuth & Permissions"
5. Generate an **App-Level Token** with `connections:write` scope (`xapp-...`) from "Basic Information"
6. Copy the **Signing Secret** from "Basic Information"

### 3. Configure Environment

```bash
cp .env.example .env
```

Fill in your tokens. See `.env.example` for all available variables.

Inference requires `LITELLM_BASE_URL`, `LITELLM_API_KEY`, `LITELLM_MODEL`, and
`LITELLM_REQUEST_TIMEOUT_MS`. The proxy must expose the OpenAI-compatible
`/v1/responses` streaming endpoint. Responses is required because reasoning
models cannot use function tools through the Chat Completions endpoint. The
base URL may include or omit `/v1`; it is normalized once by the client.

Conversation history is in-memory for the process lifetime and isolated per
Slack user/channel/thread session. Requests include one current system prompt,
up to the latest nine complete prior user/assistant pairs, and the current user
turn. Successful transcripts retain the system prompt and latest 10 complete
pairs. History is not persisted across restarts.

Tool defaults are conservative: at most 8 agentic provider turns per request,
30 seconds per MCP tool call, and 16,000 characters per tool result inserted in
the transcript. MCP clients are created and closed for every request. `stdio`
uses the SDK process transport, `sse` uses legacy SSE, and `http` means MCP
Streamable HTTP; protocols are never silently substituted. The installed SDK is
`@modelcontextprotocol/sdk` 1.29.0.

Tool policy is deny-by-default. Only exact names matching
`mcp__<server-name>__<tool-name>` or `local__read` can be advertised or dispatched. Role keys
inherit in YAML order, and denylist entries override allowlist entries. Bot,
workflow, and Slackbot requests have no human role or email and cannot access
identity-bound servers.

### Redmine MCP (read-only)

The deployment-local `mcp-servers.json` configures the `redmine` Streamable HTTP
server at `${REDMINE_MCP_URL}`. For local development, `.env.example` documents
`http://127.0.0.1:8000/mcp`; deployments must replace it with the approved
production `/mcp` URL. Redmine's legacy-mode personal API-key authentication is
owned by the Redmine MCP service. Do not add a Redmine credential, static header,
or headers helper to this bot. The Redmine service deployment must set
`REDMINE_MCP_READ_ONLY=true`.

Only explicitly listed read tools are allowed in both `mcp-servers.json` and
`config/tool-allowlist.yaml`; Redmine mutation and mixed-management tools are
also denylisted as defense in depth. Member users receive these tools, with
existing role inheritance applying them to higher roles. Unknown, anonymous,
bot, workflow, and Slackbot requests remain without MCP tools.

For remote servers, `headersHelper` is a trusted deployment-controlled `/bin/sh`
command run per connection. It has a 5-second timeout and a combined 32 KiB
stdout/stderr buffer. It must emit a JSON object whose values are strings. Helper
headers override static/bound headers; helper failure aborts the connection and
never falls back to unauthenticated access. Generated headers are never logged.

Local file access is an application-enforced capability boundary, not OS process
or container isolation. `local__read` accepts only workspace-relative paths or
explicit `upload:<id>` grants. It rejects traversal, symlink escape, repository
paths, secret-like files, arbitrary `/tmp`, other workspaces, binary content,
oversized files, and oversized line/output ranges. Each dispatch has a 5-second
wall-clock timeout; caller cancellation propagates as request cancellation. It
never writes or searches.
Uploads use per-download temporary directories and are deleted during request
cleanup on success, failure, abort, and response failure; only logical upload
identifiers appear in provider prompts/transcripts.

No command execution, web, skills, subagents, planning, write, or search tools
are exposed. Skills/subagents are deferred/removed. `headersHelper` is trusted,
deployment-controlled MCP configuration using `/bin/sh`, not a model-exposed
command tool.

LiteLLM routing and fallback are proxy-owned. The app uses `LITELLM_MODEL`, does
not forward unsupported provider tuning fields, does not retry another model,
and aggregates usage/cost across completed provider turns. Values are undefined
only when trusted proxy metadata is absent.

### 4. Configure the Bot

Copy the example configs and customize for your workspace:

#### Required

| Example file                                      | Copy to                                   | Purpose                                                     |
| ------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| `config/example-emojis.yaml`                      | `config/emojis.yaml`                      | Emoji reactions for thinking, completion, errors            |
| `config/example-tool-allowlist.yaml`              | `config/tool-allowlist.yaml`              | Role-based tool access control (key order = role hierarchy) |
| `config/example-tool-denylist.yaml`               | `config/tool-denylist.yaml`               | Tools the bot must never use                                |
| `config/instructions/example-general-context.txt` | `config/instructions/general-context.txt` | Base system prompt injected into every response             |

#### Optional configuration and capabilities

| Example file                                             | Copy to                               | Purpose                                                                |
| --------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `config/example-channels.yaml`                           | `config/channels.yaml`                | Channel auto-reply routing, keyword triggers, ephemeral summaries      |
| `config/instructions/example-channel.txt`                | `config/instructions/<name>.txt`      | Channel-specific system prompt context (referenced by `channels.yaml`) |
| `config/custom-actions/example-approvable-action.ts`     | Deployment-specific                  | Optional registered custom action                                      |
| `data/example-employees.yaml`                            | `data/employees.yaml`                 | Employee directory for role assignment and people lookups              |
| `mcp-servers.example.json`                               | Deployment-specific                  | Optional MCP server configuration                                      |

Quick start:

```bash
cp .env.example .env
cp config/example-emojis.yaml config/emojis.yaml
cp config/example-tool-allowlist.yaml config/tool-allowlist.yaml
cp config/example-tool-denylist.yaml config/tool-denylist.yaml
cp config/instructions/example-general-context.txt config/instructions/general-context.txt
```

### 5. Run

```bash
npm run dev    # development (auto-reload)
npm run build && npm run prod  # production
```

## Usage

- **DMs**: responds to all messages
- **Configured channels**: auto-replies based on `channels.yaml` rules
- **All other channels**: responds only when @-mentioned
- **File uploads**: available to `local__read` only as bounded UTF-8 text; images and PDFs require an MCP capability

## Testing

```bash
npm test              # run all tests
npx jest --watch      # re-run on file changes
npx jest src/logger   # run tests matching a pattern
```

Tests use [Jest](https://jestjs.io/) with `ts-jest`. Test files live next to their source files as `*.test.ts`.

## License

Apache 2.0 — see [LICENSE](LICENSE).

Duolingo is hiring! Apply at https://www.duolingo.com/careers

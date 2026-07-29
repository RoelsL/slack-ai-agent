# Slack AI Agent

A Slack app powered by a provider-neutral LiteLLM proxy. Responds in DMs, channels, and @-mentions with streaming responses, thread context, and file uploads. Session 1 has no MCP, custom-action, local-tool, skill, subagent, or sandbox execution.

## Architecture

- **`src/slack-handler.ts`** - Message routing and event handling
- **`src/agent-handler.ts`** - Session management and LiteLLM text streaming
- **`src/litellm-client.ts`** - Typed OpenAI-compatible HTTP/SSE client
- **`src/agent-types.ts`** - Provider-neutral stream and transcript types
- **`src/mcp-manager.ts`** - Deferred MCP configuration support; inactive in Session 1
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
`/v1/chat/completions` streaming endpoint. The base URL may include or omit
`/v1`; it is normalized once by the client.

Conversation history is in-memory for the process lifetime and isolated per
Slack user/channel/thread session. Requests include one current system prompt,
up to the latest nine complete prior user/assistant pairs, and the current user
turn. Successful transcripts retain the system prompt and latest 10 complete
pairs. History is not persisted across restarts.

### 4. Configure the Bot

Copy the example configs and customize for your workspace:

#### Required

| Example file                                      | Copy to                                   | Purpose                                                     |
| ------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| `config/example-emojis.yaml`                      | `config/emojis.yaml`                      | Emoji reactions for thinking, completion, errors            |
| `config/example-tool-allowlist.yaml`              | `config/tool-allowlist.yaml`              | Role-based tool access control (key order = role hierarchy) |
| `config/example-tool-denylist.yaml`               | `config/tool-denylist.yaml`               | Tools the bot must never use                                |
| `config/instructions/example-general-context.txt` | `config/instructions/general-context.txt` | Base system prompt injected into every response             |

#### Deferred / unsupported in Session 1

| Example file                                             | Copy to                               | Purpose                                                                |
| --------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `config/example-channels.yaml`                           | `config/channels.yaml`                | Channel auto-reply routing, keyword triggers, ephemeral summaries      |
| `config/instructions/example-channel.txt`                | `config/instructions/<name>.txt`      | Channel-specific system prompt context (referenced by `channels.yaml`) |
| `config/subagents/example-subagents.yaml`                | Not active                           | Deferred sub-agent configuration                                       |
| `config/approvable-actions/example-approvable-action.ts` | Not active                           | Deferred custom actions                                                |
| `data/example-employees.yaml`                            | `data/employees.yaml`                 | Employee directory for role assignment and people lookups              |
| `mcp-servers.example.json`                               | Not active                           | Deferred MCP server configuration                                      |

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
- **File uploads**: supports images, code files, PDFs, and documents

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

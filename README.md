# connect-anything

**Let any AI agent call your other agents — on your own subscriptions.**

You pay for Claude, ChatGPT, Devin, Cursor… and each agent lives in its own box. connect-anything gives every one of them the same small toolset to reach the others:

> *"Ask Codex to review this diff."* · *"Have Devin (SWE-2) write the tests while you keep going."* · *"Start a Claude Code cloud agent on this repo and tell me when the branch is up."*

- **One MCP server + one skill.** Works in any harness that speaks MCP (Claude Code, Codex, Cursor, Devin, OpenCode, Grok, Claude Desktop, …) or has a shell.
- **Your own sign-ins.** Each agent runs through its official CLI, logged in as you, on your plan. No API keys needed, and connect-anything never reads another tool's tokens.
- **Local and cloud.** Local CLIs answer in seconds. Cloud agents (Claude Code cloud, Codex Cloud, Devin Cloud) work on GitHub and hand back a branch, a diff or a PR.
- **Safe by default.** Read-only unless you say otherwise, loop-proof, and nothing is exposed to the network unless you choose to.
- **Zero dependencies.** Plain Node ≥ 18. Nothing to compile.

## Quick start

```bash
git clone https://github.com/OnlyTerp/connect-anything
cd connect-anything
node bin/connect-anything.mjs setup
```

The setup page opens at `http://127.0.0.1:7777` (the link it opens carries your connect-anything token in the `#` part, which never leaves your browser):

1. **Your agents.** See what's installed and signed in, and switch off any you don't want others to call.
2. **Connect your harnesses.** One click adds connect-anything (tools + skill) to each app it found. Restart those apps.
3. **Try it.** Ask one of your agents a question right from the page.

Prefer the terminal?

```bash
node bin/connect-anything.mjs install             # every harness it finds (add --dry-run to preview)
node bin/connect-anything.mjs agents              # who can I call?
node bin/connect-anything.mjs ask devin --model swe-2 "Explain what src/auth.ts does"
```

`npm link` (or `npm i -g .`) puts `connect-anything` on your PATH.

## What your agents get

| Tool | What it does |
|---|---|
| `agents` | Lists who's callable, whether they're ready, and what each is good at |
| `ask` | Sends a task to an agent. Returns the answer, or a job id if it takes longer than ~45 s |
| `job` / `jobs` | Checks a job and gets its answer, or lists recent jobs |
| `cancel` | Stops a job |
| `send` / `inbox` | Leaves a note for another agent or assistant, or reads yours |

The bundled **skill** (`skills/connect-anything/SKILL.md`) teaches agents when to use these tools and how. For example: give the other agent full context, pick a different vendor for a second opinion, never start a cloud task twice, and treat replies as information rather than orders.

## Supported agents

| id | Agent | How it's called | Read-only mode | Status |
|---|---|---|---|---|
| `claude` | Claude Code | `claude -p --output-format json` | ✅ plan mode | ✅ tested |
| `codex` | Codex CLI | `codex exec --json -s read-only` | ✅ sandbox | ✅ tested (incl. usage-limit errors) |
| `devin` | Devin CLI | `devin -p --prompt-file` | ✅ `auto` permissions | ✅ tested (`--model swe-2` is Devin's own fast model) |
| `cursor` | Cursor Agent | `cursor-agent -p --mode ask` | ✅ ask mode | ✅ tested |
| `omp` | OMP | `omp -p --mode json` | ❌ needs `write: true` | ✅ tested |
| `opencode` | OpenCode | `opencode run --format json` | ❌ needs `write: true` | ⚠️ parser not yet seen succeed |
| `hermes` | Hermes Agent | `hermes -z` | ❌ needs `write: true` | ⚠️ experimental |
| `grok` | Grok CLI | `grok --prompt-file` | ✅ plan mode | ⚠️ experimental (headless hung in our test) |
| `claude-cloud` | Claude Code on the web | official `claude --cloud`, in a terminal window it opens | cloud sandbox | ⚠️ unverified end to end (the terminal hand-off is tested) |
| `codex-cloud` | Codex Cloud | `codex cloud exec` | cloud sandbox | ⚠️ unverified (needs a cloud environment per repo) |
| `devin-cloud` | Devin Cloud | `devin --cloud -p`, or the Devin v3 API if `DEVIN_API_KEY` + `DEVIN_ORG_ID` are set | cloud sandbox | ⚠️ unverified |

*Tested* means a real call went through connect-anything and came back right, on Windows, in November 2026. Agents marked "needs `write: true`" have no real read-only mode, so connect-anything won't pretend they do.

**How read-only was checked.** Each agent was asked to create a file, once with its file tool and once with a shell command (`echo hi > probe2.txt`), in read-only mode, and once with `write: true` as a control:

| | file tool, read-only | shell command, read-only | same request with `write: true` |
|---|---|---|---|
| Claude Code (plan mode) | blocked | blocked | file created |
| Devin (`auto`) | blocked | blocked | file created |
| Cursor (ask mode) | refused | refused | file created (`--force`; see below) |

On our test machine a hook in Cursor's own settings broke its edit tool. In write mode (`--force`) Cursor fell back to a shell command and wrote the file; without `--force` it couldn't write at all. **Called agents run with your own hooks, rules and settings for that CLI**, so they behave as they would if you ran them yourself.

An agent that finishes with an empty answer is reported as failed, with what it printed.

### Any other agent

Anything with a command line can be added in `~/.connect-anything/settings.json`:

```json
{
  "custom": [
    {
      "id": "aider",
      "name": "Aider",
      "command": "aider",
      "args": ["--message", "{prompt}", "--yes-always"],
      "goodFor": "Pair programming with git-aware edits."
    }
  ]
}
```

- `{prompt}` is replaced by the prompt, and `{promptFile}` by a file containing it. Use `"stdin": true` to pipe the prompt in instead.
- Set `"readOnly": "enforced"` only if those args really make the agent read-only. Otherwise callers must pass `write: true`.

## Cloud agents

Cloud agents run on the provider's machines, billed to your plan, and **see only what's pushed to GitHub**.

- **Claude Code cloud.** `claude --cloud` only starts from a real terminal, so connect-anything opens one for you that runs the official command. The agent is asked to push a `cloud/<job-id>` branch with a `CLOUD_REPORT.md`, and `job` reports done when that branch appears. Watch it live at claude.ai/code. Requires a Pro/Max/Team plan and GitHub connected at claude.ai/code.
- **Codex Cloud.** Needs a Codex Cloud environment for the repo (chatgpt.com/codex → environments). The result is a diff; apply it with `codex cloud apply <id>`.
- **Devin Cloud.** Uses `devin --cloud -p` from a recent Devin CLI (`devin update`), or Devin's official v3 API with a service-user key (`DEVIN_API_KEY`, `DEVIN_ORG_ID`).

Starting a cloud task is never retried automatically: a start is billed and can't be undone.

## Cloud assistants (ChatGPT, claude.ai, phone apps)

Assistants that live in a browser or app can use the same tools over HTTP:

```bash
connect-anything serve --port 7777
cloudflared tunnel --url http://127.0.0.1:7777          # or any tunnel you trust
connect-anything serve --public-host your-name.trycloudflare.com
```

Then add an MCP connector with the URL `https://<host>/mcp/<token>`. The token is in `~/.connect-anything/token`, and `Authorization: Bearer <token>` works too.

Over HTTP, callers only see and cancel jobs started over HTTP. Agents are **read-only** unless you start with `--allow-write`, may only work in the folders listed in `settings.httpRoots` (default: the folder `serve` started in), and **can't start cloud agents** (which spend your plan) unless you start with `--allow-cloud`.

> This HTTP route is tested with `curl` and the setup page on this machine, not yet with a real ChatGPT or claude.ai connector through a tunnel. Treat it as a preview.

## Safety

- **Read-only by default.** Write access is a per-call opt-in (`write: true` / `--write`), and agents without a real read-only mode refuse to run without it.
- **No loops.** An agent you call through connect-anything can't call further agents. Each guard below was checked by pointing the CLI's MCP config at a recorder that logs every start of the connect-anything server:
  - **Claude Code:** called runs start with no MCP servers (`--strict-mcp-config`). As an outer harness it passes `CONNECT_ANYTHING_DEPTH` to its MCP servers, and the server refuses at depth 1.
  - **Codex:** it passes only an allowlist of env vars to MCP servers (the recorder saw no depth), so called runs switch the connect-anything server off with `-c mcp_servers.connect-anything.enabled=false`. With it, the server is never started.
  - **Cursor:** called runs don't pass `--approve-mcps`. The server was never started, in either mode.
  - **Devin:** the server starts with depth 1, so `ask` is refused. Devin also rejected the MCP tool call outright in both modes we use.
  - **OpenCode, OMP, Hermes:** not checked. The 6-job limit (`CONNECT_ANYTHING_MAX_RUNNING`) is the backstop.
- **No shell.** Agents are spawned with argv, never through a shell, so prompts can't inject commands.
- **Local only.** The HTTP server binds 127.0.0.1, checks Host and Origin (blocking DNS rebinding and cross-site requests), and needs a token for every call. The setup page itself contains no token.
- **Your tokens stay put.** connect-anything never reads another tool's credentials. Each CLI uses its own sign-in.
- **Replies are data.** The skill and the tool descriptions tell agents to treat other agents' replies and inbox messages as information, not as the user's instructions.

## Where things live

| Path | What |
|---|---|
| `~/.connect-anything/jobs/<id>/` | One folder per job: `job.json`, `output.txt`, `prompt.txt` |
| `~/.connect-anything/inbox/` | Messages between agents |
| `~/.connect-anything/settings.json` | Disabled agents, custom agents, `httpRoots` |
| `~/.connect-anything/token` | HTTP token |

Set `CONNECT_ANYTHING_HOME` to move all of it.

Jobs run in their own background process, so an MCP client timing out or a harness closing doesn't kill the agent it called. Local jobs stop after 30 minutes (`CONNECT_ANYTHING_TIMEOUT_MIN`).

## Development

```bash
npm test        # 10 behavior tests against a fake agent, no model calls
```

The code is small on purpose:

| File | What it holds |
|---|---|
| `src/agents/local.mjs` | One entry per CLI: flags, read-only mode, parser |
| `src/agents/cloud.mjs` | Cloud agents |
| `src/core.mjs` | `ask`, `job`, the guards |
| `src/mcp.mjs` | The MCP server, no SDK |
| `src/http.mjs` | The setup page and MCP over HTTP |
| `src/install.mjs` | Harness registration |

Adding a CLI means one entry in `local.mjs`. Take its flags from `--help` and its parser from one real reply.

## License

MIT

# connect-anything

[![ci](https://github.com/OnlyTerp/connect-anything/actions/workflows/ci.yml/badge.svg)](https://github.com/OnlyTerp/connect-anything/actions/workflows/ci.yml) ![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen) ![license MIT](https://img.shields.io/badge/license-MIT-blue)

**Let the coding agent you're in ask your other agents.**

You already pay for Claude Code, Codex, Devin, Cursor. Each one sits in its own window. connect-anything is one small MCP server that lets the agent you're working with call the others through their official CLIs, signed in as you, on your plans. You get second opinions, a review from another vendor, or a task handed off, all without leaving the chat you're in.

```text
$ connect-anything ask devin,cursor --staged "Review this diff for bugs. Be brief."
Council g-20261117195643-507f50 - 2 of 2 answered (devin done in 4.7 s, cursor done in 13 s)

<<reply agent=devin id=0e335d8a untrusted>>
**Bug: off-by-one crash.** `i <= items.length` runs one iteration past the array, so `items[i]` is
`undefined` on the last pass and `items[i].price` throws. Fix: `i < items.length`.
Minor: the `price === 0` skip is redundant - free items contribute `0 * qty = 0` anyway.
<<end 0e335d8a>>

<<reply agent=cursor id=5025ff41 untrusted>>
**Bug: off-by-one loop bound** ... **Fix:** keep the original bound: `i < items.length`.
Skipping `price === 0` is reasonable if free lines should not affect the total. That part is fine once the loop bound is fixed.
<<end 5025ff41>>
```

*A real run from 17 November 2026, trimmed. Both agents found the crash and disagreed about the skip; your agent sees both answers and can weigh them.*

- **One MCP server, one skill.** Add it to Claude Code, Codex, Cursor, Devin, OpenCode, Grok or Claude Desktop, or call it from any shell.
- **Your own sign-ins.** Each agent runs through its own CLI, logged in as you. No API keys, and connect-anything never reads another tool's tokens.
- **Read-only by default.** Write access is opt-in per call. Agents with no read-only mode refuse to run without it.
- **Zero dependencies.** Plain Node 18 or newer. Nothing to compile.

## Get started (two minutes)

```bash
npx -y connect-anything doctor      # which of your agents answer right now
npx -y connect-anything install     # add the server and skill to every app it finds
```

Then restart those apps and ask, in plain words: *"Ask Codex and Devin to review my staged changes."*

`doctor` sends each installed agent a one-line, read-only check ("Reply with exactly: OK") and shows who answered and how fast. That check uses a tiny bit of each plan.

Prefer a page? `npx -y connect-anything setup` opens one at `http://127.0.0.1:7777`: see your agents, connect your apps with one click each, and try an ask.

<details>
<summary>From source, or with <code>--dry-run</code></summary>

```bash
git clone https://github.com/OnlyTerp/connect-anything
cd connect-anything
node bin/connect-anything.mjs install --dry-run   # show what would change
node bin/connect-anything.mjs install
```

`install` uses each app's own `mcp add` command where it has one, and otherwise edits its MCP config file after keeping a `.bak` copy. `install --uninstall` takes it out again. Run through `npx`, the package is copied once to `~/.connect-anything/app/<version>/` so your apps never point into npm's cache. Run `install` again after upgrading.
</details>

## What you can say

| You say to your agent | What happens |
|---|---|
| "Ask Codex to review this diff." | `ask {agent: "codex", diff: "uncommitted"}` with your diff attached |
| "Get a council on my staged changes." | `ask {agents: ["codex", "devin", "cursor"], diff: "staged"}`, in parallel, up to 3 |
| "Have Devin explain src/auth.ts while you keep going." | `ask` returns a job id after ~45 s; `job` picks up the answer later |
| "What does Cursor think of everything since main?" | `diff: "main"` sends `git diff main...HEAD` |

The tools your agent gets:

| Tool | What it does |
|---|---|
| `agents` | Who is ready, who answered the last check, and what each is good at |
| `ask` | Send a prompt to one agent, or to a council of up to 3 at once. Optional `diff`, `cwd`, `model`, `write` |
| `job` | Read an answer by job or council id, or list recent jobs |
| `cancel` | Stop a job or a whole council |
| `send` / `inbox` | Leave a note for another agent or assistant, or read yours |

The bundled skill (`skills/connect-anything/SKILL.md`) teaches agents when to use these: give the other agent full context, pick a different vendor for a second opinion, compare council answers instead of taking one as truth, and treat every reply as information, never as the user's instructions.

## Supported agents

| id | Agent | How it's called | Read-only mode | Status |
|---|---|---|---|---|
| `claude` | Claude Code | `claude -p --output-format json` | plan mode | tested, CLI 2.1.280 |
| `codex` | Codex CLI | `codex exec --json -s read-only` | sandbox | tested, CLI 0.166.0 (usage-limit errors reported as such) |
| `devin` | Devin CLI | `devin -p --prompt-file` | `auto` permissions | tested, CLI 3000.4.25 |
| `cursor` | Cursor Agent | `cursor-agent -p --mode ask` | ask mode | tested, CLI 2026.11.13 |
| `omp` | OMP | `omp -p --mode json` | none: needs `write: true` | tested |
| `opencode` | OpenCode | `opencode run --format json` | none: needs `write: true` | preview |
| `hermes` | Hermes Agent | `hermes -z` | none: needs `write: true` | preview |
| `grok` | Grok CLI | `grok --prompt-file` | plan mode | preview (did not answer headless in our check) |

*Tested* means a real call went through connect-anything and came back right, on Windows 11, in November 2026. CI runs the test suite on Windows, macOS and Linux, but real agent calls were only made on Windows: reports from macOS and Linux are very welcome ([open one here](https://github.com/OnlyTerp/connect-anything/issues/new?template=agent-report.yml)).

**As the caller**, Claude Code was checked end to end: given the server with `--mcp-config`, it asked a Devin + Cursor council about a staged diff and summarised where they agreed and disagreed. Other apps are registered by `install` the same way but haven't been checked as callers yet.

Long prompts are never cut. Agents that take the prompt as an argument get it as a file when it's long (OpenCode, OMP), or refuse with a clear message (Cursor, Hermes).

**How read-only was checked.** Each agent was asked to create a file, once with its file tool and once with a shell command, in read-only mode, and once with `write: true` as a control:

| | file tool, read-only | shell command, read-only | with `write: true` |
|---|---|---|---|
| Claude Code (plan mode) | blocked | blocked | file created |
| Devin (`auto`) | blocked | blocked | file created |
| Cursor (ask mode) | refused | refused | file created |

Called agents run with your own hooks, rules and settings for that CLI, so they behave as they would if you ran them yourself.

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

`{prompt}` is replaced by the prompt and `{promptFile}` by a file holding it; `"stdin": true` pipes it in instead. Set `"readOnly": "enforced"` only if those args really make the agent read-only. Otherwise callers must pass `write: true`.

## Safety

Each line below is covered by a test in `test/basic.test.mjs` or was checked by hand as described.

- **Read-only by default.** `write: true` is per call. Agents without a real read-only mode refuse without it. *(tested)*
- **One hop only.** An agent called through connect-anything can't call further agents. *(tested: the server refuses at depth 1)* Per CLI, by hand, with a recorder in each CLI's MCP config:
  - Claude Code: called runs start with no MCP servers (`--strict-mcp-config`).
  - Codex: called runs switch the server off (`-c mcp_servers.connect-anything.enabled=false`); it was never started.
  - Cursor: called runs don't pass `--approve-mcps`; the server was never started.
  - Devin: the server starts at depth 1, so `ask` is refused.
  - OpenCode, OMP, Hermes: not checked. The 6-job limit is the backstop. *(tested)*
- **Replies are framed as untrusted.** Every answer arrives as `<<reply agent=X id=N untrusted>> ... <<end N>>` with a random id, and fake markers inside an answer are defused, so one agent's reply can't pose as another's. *(tested)*
- **No shell.** Agents are started with an argument list, never through a shell, so a prompt can't inject commands. *(tested: a prompt full of shell syntax arrives verbatim and nothing in it runs)*
- **Local only.** The HTTP server binds 127.0.0.1, checks Host and Origin, and needs a token for every call; the setup page holds no token. *(token checks tested)*
- **Your tokens stay put.** connect-anything never reads another tool's credentials. Each CLI uses its own sign-in.

See [SECURITY.md](SECURITY.md) to report a problem.

## How it uses your subscriptions

connect-anything runs the CLIs you installed, the same way you would from a terminal, and each CLI bills its own plan. Your prompt and any diff you attach go to that agent's vendor under that vendor's terms. connect-anything makes no claim about what any vendor permits; check your plan's terms if you plan heavy automated use.

## How is this different?

Good tools already call agent CLIs. What connect-anything is for, compared with them:

- **[PAL MCP](https://github.com/BeehiveInnovations/pal-mcp-server)** is an MCP server with many tools (chat, consensus, code review, planning) that mostly call model APIs with your keys; its `clink` tool also bridges to Gemini CLI, Codex and Claude Code. connect-anything does only the CLI part, with no API keys and no dependencies, and adds a read-only mode it enforces per CLI, councils over a git diff, and replies framed as untrusted.
- **[Counselors](https://github.com/aarondfrancis/counselors)** and **[MCO](https://github.com/mco-org/mco)** are command-line runners that fan a prompt out to several agent CLIs and collect the answers; your agent reaches them through a skill. connect-anything is an MCP server, so the agent you're in calls it as tools, with jobs that keep running in the background and a one-hop guard against loops.
- **[CAO](https://github.com/awslabs/cli-agent-orchestrator)** runs a supervisor agent that drives worker agents in terminal sessions. connect-anything runs no supervisor: the agent you're in stays in charge.

<details>
<summary>Preview: cloud agents and cloud assistants (not verified end to end)</summary>

**Cloud agents** run on the vendor's machines, billed to your plan, and see only what's pushed to GitHub. A cloud start is never retried automatically.

- `claude-cloud`: `claude --cloud` only starts from a real terminal, so connect-anything opens one that runs the official command. The agent is asked to push a `cloud/<job-id>` branch with a `CLOUD_REPORT.md`; `job` reports done when that branch appears.
- `codex-cloud`: `codex cloud exec`. Needs a Codex Cloud environment for the repo. The result is a diff for `codex cloud apply <id>`.
- `devin-cloud`: Devin's v3 API with a service-user key (`DEVIN_API_KEY`, `DEVIN_ORG_ID`).

**Cloud assistants** (browser and phone apps that accept an MCP connector URL) can use the same tools over HTTP:

```bash
connect-anything serve --port 7777
cloudflared tunnel --url http://127.0.0.1:7777          # or any tunnel you trust
connect-anything serve --public-host your-name.trycloudflare.com
```

The connector URL is `https://<host>/mcp/<token>` (token in `~/.connect-anything/token`; `Authorization: Bearer <token>` works too). Over HTTP, callers see only their own jobs, agents are read-only unless you start with `--allow-write`, work only in `settings.httpRoots`, and can't start cloud agents unless you pass `--allow-cloud`. This route is tested with `curl` and the setup page, not yet through a real tunnel and connector.
</details>

## Where things live

| Path | What |
|---|---|
| `~/.connect-anything/jobs/<id>/` | One folder per job: `job.json`, `output.txt`, `prompt.txt` |
| `~/.connect-anything/groups/` | Council records |
| `~/.connect-anything/doctor.json` | The last `doctor` results |
| `~/.connect-anything/settings.json` | Disabled agents, custom agents, `httpRoots` |
| `~/.connect-anything/inbox/` | Notes between agents |

Set `CONNECT_ANYTHING_HOME` to move all of it. Jobs run in their own background process, so a client timing out doesn't kill the agent it called. Local jobs stop after 30 minutes (`CONNECT_ANYTHING_TIMEOUT_MIN`).

## Development

```bash
npm test        # behavior tests against fake agents, no model calls
```

| File | What it holds |
|---|---|
| `src/agents/local.mjs` | One entry per CLI: flags, read-only mode, parser |
| `src/agents/cloud.mjs` | Cloud agents (preview) |
| `src/core.mjs` | `ask`, councils, diffs, `doctor`, the guards |
| `src/mcp.mjs` | The MCP server, no SDK |
| `src/http.mjs` | The setup page and MCP over HTTP |
| `src/install.mjs` | App registration |

Adding a CLI is one entry in `local.mjs`: take its flags from `--help` and its parser from one real reply.

## License

MIT

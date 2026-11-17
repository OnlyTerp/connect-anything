# Security

Please report security problems privately through
[GitHub security advisories](https://github.com/OnlyTerp/connect-anything/security/advisories/new),
not in a public issue.

## What connect-anything does and does not do

- It starts the agent CLIs you already have installed, as you, with your sign-ins. It never reads,
  copies or stores another tool's tokens or credentials.
- By default every ask runs in the agent's read-only mode. Agents with no read-only mode refuse to
  run unless the caller passes `write: true`.
- One level of nesting only: an agent started by connect-anything cannot start another one.
- At most 6 jobs run at once.
- Replies from other agents are wrapped as untrusted data, and forged reply markers are defused, so
  the calling agent is told not to treat them as instructions.
- The HTTP mode listens on 127.0.0.1 and requires a random token. Exposing it beyond your machine
  (`--public-host`) prints a warning; only do that behind your own authentication.
- Your prompt, and any diff you attach, goes to the vendor of the agent you ask, under that
  vendor's terms.

`test/basic.test.mjs` covers the read-only refusal, the depth and job limits, the reply framing
and the HTTP token check.

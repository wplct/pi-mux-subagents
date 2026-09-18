# pi-mux-subagents

An interactive and headless subagent framework for [pi](https://github.com/earendil-works/pi), Claude Code, and Codex with terminal-multiplexer pane support, sync and async orchestration, and a multi-CLI design. Mux pane execution—launching each subagent into its own live terminal pane—is the framework's primary differentiator: it gives you direct observability, manual intervention, and interruption semantics that headless subprocess execution cannot match.

## Install

```bash
npm install @aphotic/pi-mux-subagents
```

Register the extension in your project's `package.json`:

```json
{
  "pi": {
    "extensions": ["./node_modules/@aphotic/pi-mux-subagents/src/index.ts"]
  }
}
```

## Quickstart

### Subagent primitive (single launch)

Launch a single worker and receive its result asynchronously:

```json
{
  "name": "summarise-module",
  "task": "Summarise the public API of src/orchestration/ in one paragraph.",
  "agent": "researcher"
}
```

The parent receives a steer-back message when the worker finishes. Do not invent its output.

### Serial orchestrator

Run tasks one after another. Use `{previous}` to pass each step's final message into the next:

```json
{
  "tasks": [
    { "name": "Research", "task": "List all public exports in src/." },
    { "name": "Plan",     "task": "Write a migration plan based on: {previous}" },
    { "name": "Review",   "task": "Review the plan for completeness: {previous}" }
  ]
}
```

The sequence stops on the first failure and returns all prior results alongside the failing one.

### Parallel orchestrator

Run independent tasks concurrently with a configurable cap:

```json
{
  "maxConcurrency": 3,
  "tasks": [
    { "name": "Auth review",    "task": "Review src/backends/ for security issues." },
    { "name": "Mux review",     "task": "Review src/mux/ for reliability issues." },
    { "name": "Tooling review", "task": "Review src/tools/ for correctness." }
  ]
}
```

`maxConcurrency` defaults to `4` and is capped at `8`. Partial failures do not cancel sibling tasks. Results are returned in input order.

### Sync vs async subagent calls

By default (`wait: true`) the orchestration tool blocks until all tasks complete. Set `wait: false` to return immediately with an `orchestrationId`:

```json
{ "wait": false, "tasks": [ { "name": "Background probe", "task": "..." } ] }
```

The tool returns:

```json
{ "orchestrationId": "7a3f91e2", "state": "pending", "tasks": [...] }
```

Completion arrives later as a single aggregated steer-back message. Cancel with:

```json
{ "orchestrationId": "7a3f91e2" }
```

### CLI selection

Choose which CLI each subagent runs under with the `cli` field:

```json
{ "name": "pi worker",     "task": "...", "cli": "pi" }
{ "name": "claude worker", "task": "...", "cli": "claude" }
{ "name": "codex worker",  "task": "...", "cli": "codex" }
```

`cli: "pi"` (default) gives access to pi lifecycle tools (`subagent_done`, `caller_ping`), skills, and coordinator spawning. `cli: "claude"` runs the Claude Code CLI in headless or pane mode; it trades pi lifecycle features for Claude-native tool access. `cli: "codex"` runs the Codex CLI in headless (codex exec) or pane mode. Like Claude, it trades pi lifecycle features (skills, caller_ping/block-resume) for native Codex tooling; pi skills and tool allowlists are warned-and-ignored. The framework is designed to support additional CLIs (opencode) in the future.

Codex-specific notes:

- Pane completion is tool-first: Codex pane prompts instruct the model to call `subagent_done(message=…)` with the final summary before any final answer, then send no further output. The MCP completion tool and Codex policy/model/thinking settings are injected per launch with `codex -c` overrides; pi-mux-subagents does not persist its own configuration to `~/.codex/config.toml`.
- To run unattended, launches pass a per-launch `-c projects."<cwd>".trust_level="trusted"` override so Codex skips its interactive project-trust prompt. This is a flag, not a config write, though Codex itself may still record unrelated project-trust metadata.
- Codex has no dedicated system-prompt channel. Agent identity that would normally be delivered with `system-prompt: append` or `system-prompt: replace` is delivered additively in the task body instead; `replace` emits a runtime warning because exact base-instruction replacement is not representable on Codex.

### Execution policy

`executionPolicy` (tool parameter) / `execution-policy` (agent frontmatter) is a CLI-agnostic control over how much autonomy a subagent's backend is granted. It takes two values:

```json
{ "name": "worker", "task": "...", "cli": "claude", "executionPolicy": "guarded" }
{ "name": "worker", "task": "...", "cli": "claude", "executionPolicy": "unrestricted" }
```

```yaml
# agent frontmatter
execution-policy: guarded
```

- **`guarded` (default)** prefers the backend's safest practical autonomous mode. For Claude this maps to `--permission-mode auto`, which keeps Claude's permission classifier in the loop for risky actions instead of bypassing it.
- **`unrestricted`** explicitly opts into bypass/full-access behavior for trusted, sandboxed, or otherwise controlled runs. For Claude this restores the legacy bypass path: `--dangerously-skip-permissions` for pane launches and `--permission-mode bypassPermissions` for headless launches.

Resolution order is **tool parameter → agent frontmatter → `guarded` default**. The same `executionPolicy` option is exposed on the bare `subagent` tool and on `subagent_run_serial` / `subagent_run_parallel` steps, so direct and orchestrated launches behave identically. Pane launches still export `CLAUDE_CODE_SANDBOXED=1`; that only bypasses Claude's interactive workspace-trust dialog and does **not** bypass tool permissions, so it applies under both policies.

> **Migration note.** The default changed from bypass-by-default to `guarded`. Workflows that relied on Claude bypassing permissions may now see Claude refuse or pause on risky actions — destructive git operations, credential exploration, production access, or irreversible deletes. If a run is genuinely trusted and sandboxed, set `executionPolicy: "unrestricted"` (or `execution-policy: unrestricted` in agent frontmatter) to restore the previous behavior.

#### Backend mappings

The policy is intentionally CLI-agnostic because the safe mode differs per backend, and the mappings below are **not** exact equivalents:

| Backend | `guarded` (intended) | `unrestricted` (intended) |
| --- | --- | --- |
| **Claude** (implemented) | `--permission-mode auto` | `--dangerously-skip-permissions` (pane) / `--permission-mode bypassPermissions` (headless) |
| **Codex** (implemented) | `--sandbox workspace-write` + `-c approval_policy="never"` (headless) / `--sandbox workspace-write --ask-for-approval on-request` (pane) | `--dangerously-bypass-approvals-and-sandbox` |
| **OpenCode** (future) | best-effort conservative permission profile (no true classifier-backed `auto` equivalent exists) | broadly `permission: "allow"` |
| **pi** (current) | no guarded mode yet — runs unrestricted, subject only to tool availability and deny-tool config | unrestricted (current behavior) |

Codex guarded mode is sandbox-enforced (workspace-write filesystem + approval policy) but, unlike Claude's --permission-mode auto, is not classifier-backed — there is no per-action risk classifier, only the sandbox boundary and approval policy. Codex configuration (MCP completion server, policy, model, thinking) is applied exclusively through per-launch codex -c overrides — including the per-launch `projects."<cwd>".trust_level="trusted"` override that lets unattended runs skip Codex's interactive project-trust prompt — so pi-mux-subagents never persists its own MCP/policy/model/thinking configuration to ~/.codex/config.toml or other persistent Codex state. (Codex itself may still update unrelated project-trust metadata.)

For backends without an implemented guarded mode (pi today), an explicit `guarded` request emits a one-line warning and continues with current behavior rather than rejecting the launch. The implicit default does not warn.

### Project trust

Project trust and execution policy are **separate** dimensions. Project trust is a launch-time *input-loading* decision — whether a backend may read project-local settings, resources, packages, extensions, and skills from the directory it starts in. Execution policy (above) is the *autonomy/sandbox* decision — how much the backend may do once running. A subagent can be trusted to load a repo's local config while still running under `guarded` autonomy, and vice versa.

Backends prompt for project trust the first time they start in an unfamiliar directory. Since subagents run unattended, an unanswered prompt would stall the launch, and a non-interactive backend might instead silently skip project-local input. pi-mux-subagents therefore applies a **per-launch** trust approval for each backend it starts on your behalf — for this run only, never writing your persistent trust state (though a backend may record its own trust metadata as a side effect):

| Backend | Per-launch trust handling |
| --- | --- |
| **pi** | Pane and headless launches pass `--approve`, Pi's one-run project-trust override (Pi ≥ 0.79.1), so the child loads project-local input without stalling on the trust prompt. |
| **Claude** | Headless launches run with `-p` (Claude skips the workspace-trust dialog in non-interactive mode); pane launches export `CLAUDE_CODE_SANDBOXED=1`, which short-circuits Claude's trust check. Both only bypass the trust dialog, not tool permissions. |
| **Codex** | Pane and headless launches pass a per-launch `-c projects."<cwd>".trust_level="trusted"` override so Codex skips its interactive project-trust prompt. This is a flag, not a config write. |
| **OpenCode** (future) | Will follow the same pattern: a per-launch trust approval for the child run, kept separate from execution policy. |

This extension also performs its **own** project-local `.pi/agents/` discovery to resolve agent frontmatter (model, tools, skills, `execution-policy`, `cwd`, …) before launching. That parent-side discovery is gated on Pi's effective project-trust decision via `ctx.isProjectTrusted()` (Pi ≥ 0.79.1): when the parent's project is **not** trusted, project-local `.pi/agents/` files are ignored so an untrusted repository cannot bootstrap launch behavior — including `execution-policy: unrestricted` or a `cwd` override — before trust is established. Global `~/.pi/agent/agents/` and bundled agents are unaffected.

### Runtime diagnostics and warnings

Warnings are routed through one diagnostics path. In an interactive TUI they appear via `ui.notify`; in headless or non-UI contexts they fall back to stderr. Caller-relevant warnings — such as dropped `skills`/`tools`, an explicit `guarded` request on a backend without guarded mode, or Codex `system-prompt: replace` fallback — are also surfaced additively as `details.warnings` on the bare `subagent` result or per task in `subagent_run_serial` / `subagent_run_parallel` results. Human-only process diagnostics are not mirrored into `details.warnings`.

### Headless vs mux

Control the execution backend with the `PI_SUBAGENT_MODE` environment variable:

```bash
export PI_SUBAGENT_MODE=auto      # default: use a mux pane when one is detected, otherwise headless
export PI_SUBAGENT_MODE=pane      # require a mux; fail if none is available
export PI_SUBAGENT_MODE=headless  # always run as a child process
```

Headless mode works in CI, IDE terminals, and SSH sessions. It produces structured `usage` and `transcript` fields. Pane mode opens each subagent in a live terminal surface where you can watch, type, and intervene directly.

### Interactive flag and autoexit interplay

`interactive` and `autoExit` control how a subagent behaves after completing its turn:

```json
{ "interactive": false, "autoExit": true }   // autonomous one-shot worker — exits after one turn
{ "interactive": true,  "autoExit": false }  // user-driven session — stays open for follow-up
```

When both are set, `autoExit: true` takes precedence on turn completion. An `interactive: true` child suppresses intermediate status steer-back messages so the parent is not repeatedly woken by expected pauses. If neither is set, `interactive` defaults to `true` unless `autoExit: true` is explicitly present.

## Backend selection

The framework auto-detects an available mux when an interactive subagent is requested and falls back to headless when no mux is found.

Compatible mux implementations:

1. `herdr`
2. `cmux`
3. `tmux`
4. `zellij`
5. `wezterm`
6. `termio`

The same order is used for auto-detection. Override the selection with `PI_SUBAGENT_MUX=<name>` to force one of those adapters or fail fast if that adapter is unavailable.

### termio specifics

`termio` panes are created through the `termio sessions` CLI, which does not need to be on `PATH`: when `termio` is not found there, the adapter falls back to `/Applications/termio.app/Contents/Resources/termio`. Point `TERMIO_CLI` at the binary to override both.

The backend is selected when the process runs inside termio (`TERM_PROGRAM=termio` or `TERMIOD_SESSION_ID` set) and the CLI resolves.

- New panes are anchored to the calling session, so `--direction right` is the natural default. termio only expresses `right`/`down`; `left`/`up` collapse to the nearest of those.
- The new pane takes 35% of the split. Override with `PI_SUBAGENT_TERMIO_RATIO=0.25` (range `0 < ratio <= 1`).
- New panes never steal keyboard focus, which is what the framework's detached launch contract expects; use `termio sessions focus` to jump to one.
- `renameCurrentTab` / `renameWorkspace` are no-ops: the CLI exposes no rename, and termio derives session titles itself.

### `pi-mux-detect`

The package ships a standalone `pi-mux-detect` CLI that exposes the same detection logic used at runtime as machine-readable JSON:

```bash
npx pi-mux-detect
```

Sample output:

```json
{
  "backend": "pane",
  "mux": "herdr",
  "modeForced": null,
  "muxPreference": null,
  "muxPreferenceInvalid": null,
  "reason": "auto-selected pane backend; mux=herdr from detection order [herdr,cmux,tmux,zellij,wezterm,termio]"
}
```

Fields: `backend` (`"pane"` or `"headless"`), `mux` (detected adapter name or `null`), `modeForced` (`"pane"`, `"headless"`, or `null` depending on `PI_SUBAGENT_MODE`), `muxPreference` (value of `PI_SUBAGENT_MUX` when set and valid), `muxPreferenceInvalid` (the invalid raw `PI_SUBAGENT_MUX` value, or `null`), `reason` (human-readable explanation of the detection outcome).

Downstream packages should call `pi-mux-detect` rather than duplicating mux env-var checks.

## Ecosystem

[`pi-flow-core`](https://github.com/aphotic/pi-flow-core) provides a curated library of ready-made agents and skills that build on this package. The dependency direction is `pi-flow-core → pi-mux-subagents`, not the reverse: `pi-mux-subagents` has no runtime dependency on `pi-flow-core`. If you want a batteries-included setup with pre-built agent definitions, start with `pi-flow-core`; if you want only the launch and orchestration primitives, this package is self-contained.

## Attribution

This project began as a fork of [`HazAT/pi-interactive-subagents`](https://github.com/HazAT/pi-interactive-subagents). Thanks to the upstream maintainer for the foundation this work builds on.

## License

MIT. The LICENSE file at the package root preserves the upstream copyright notice as required by MIT.

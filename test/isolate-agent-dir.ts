// Unit/orchestration tests resolve launch specs against a temp `cwd`, and
// `getDefaultSessionDirFor` eagerly `mkdirSync`s a session directory under
// `getAgentConfigDir()` (`PI_CODING_AGENT_DIR ?? ~/.pi/agent`). When the env var
// is unset those writes land in the developer's real `~/.pi/agent/sessions/`,
// which (a) pollutes the home directory with thousands of `--var-folders-...--`
// stubs and (b) fails with `EPERM` under a sandboxed runner (e.g. the Codex
// seatbelt test-runner) because `~/.pi` is outside the writable workspace roots.
//
// Default the config dir to a throwaway temp directory so the suite is hermetic
// regardless of where it runs. Tests that set/restore PI_CODING_AGENT_DIR
// themselves still override this default; an already-set value is left intact.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.PI_CODING_AGENT_DIR) {
  const isolatedAgentDir = mkdtempSync(join(tmpdir(), "pi-test-agent-"));
  process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
  process.on("exit", () => {
    try {
      rmSync(isolatedAgentDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; the OS reaps TMPDIR anyway.
    }
  });
}

// The suite must not inherit this machine's terminal backend. Run from inside a
// real mux (termio, tmux, zellij, ...), the live detector reports that backend
// as available, so tests that assume "no mux -> headless" take the pane path
// instead — and then spawn real panes into the developer's terminal window.
// Clear the detection environment so every run starts from a known headless
// baseline; tests that exercise a backend set and restore these themselves.
for (const key of [
  "TERM_PROGRAM",
  "TERMIO_CLI",
  "TERMIO_SESSION",
  "TERMIOD_SESSION_ID",
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_WORKSPACE_ID",
  "CMUX_SOCKET_PATH",
  "TMUX",
  "TMUX_PANE",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
  "WEZTERM_UNIX_SOCKET",
  "MUXY_SOCKET_PATH",
  "PI_SUBAGENT_MUX",
  "PI_SUBAGENT_MODE",
]) {
  delete process.env[key];
}

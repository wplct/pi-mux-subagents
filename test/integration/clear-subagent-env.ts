// Integration tests must be independent of the pi subagent session that may be
// running the test command. Parent subagent runtime variables (especially
// PI_DENY_TOOLS) otherwise change extension activation and child lifecycle
// behavior before the tests can set their own fixtures.
for (const key of [
  "PI_DENY_TOOLS",
  "PI_SUBAGENT_NAME",
  "PI_SUBAGENT_AGENT",
  "PI_SUBAGENT_AUTO_EXIT",
  "PI_SUBAGENT_SESSION",
  "PI_SUBAGENT_ID",
  "PI_SUBAGENT_ACTIVITY_FILE",
  "PI_SUBAGENT_SURFACE",
]) {
  delete process.env[key];
}

// Same reasoning as test/isolate-agent-dir.ts: the integration suite must not
// inherit a real terminal backend from the machine it runs on. With a live mux
// detected, pane tests would create real panes in the developer's window
// instead of using their own fixtures.
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

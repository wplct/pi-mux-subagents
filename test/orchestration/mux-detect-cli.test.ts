import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDetectionPayload } from "../../src/bin/pi-mux-detect.ts";
import { __test__ as selectTest, selectBackend as realSelectBackend } from "../../src/backends/select.ts";
import { __test__ as shellTest } from "../../src/mux/shell.ts";
import { getMuxBackend as realGetMuxBackend } from "../../src/mux/index.ts";

// --- CLI-stub fixture helpers ---

describe("CLI buildDetectionPayload with stubs", () => {
  it("headless-no-mux baseline", () => {
    const result = buildDetectionPayload({
      env: {},
      getMuxBackend: () => null,
      selectBackend: () => "headless",
    });
    assert.equal(result.backend, "headless");
    assert.equal(result.mux, null);
    assert.equal(result.modeForced, null);
    assert.equal(result.muxPreference, null);
    assert.equal(result.muxPreferenceInvalid, null);
    assert.ok(result.reason.includes("auto-selected headless backend"), `reason: ${result.reason}`);
  });

  it("pane-mux=herdr auto path", () => {
    const result = buildDetectionPayload({
      env: {},
      getMuxBackend: () => "herdr",
      selectBackend: () => "pane",
    });
    assert.equal(result.backend, "pane");
    assert.equal(result.mux, "herdr");
    assert.equal(result.modeForced, null);
    assert.equal(result.muxPreference, null);
    assert.ok(result.reason.includes("mux=herdr"), `reason: ${result.reason}`);
  });

  for (const mux of ["cmux", "tmux", "zellij", "wezterm", "termio"] as const) {
    it(`pane-mux=${mux} auto path`, () => {
      const result = buildDetectionPayload({
        env: {},
        getMuxBackend: () => mux,
        selectBackend: () => "pane",
      });
      assert.equal(result.backend, "pane");
      assert.equal(result.mux, mux);
      assert.equal(result.modeForced, null);
      assert.equal(result.muxPreference, null);
      assert.equal(result.muxPreferenceInvalid, null);
      assert.ok(result.reason.includes(`mux=${mux}`), `reason: ${result.reason}`);
    });
  }

  for (const mux of ["cmux", "tmux", "zellij", "wezterm", "termio"] as const) {
    it(`PI_SUBAGENT_MUX=${mux} valid preference`, () => {
      const result = buildDetectionPayload({
        env: { PI_SUBAGENT_MUX: mux },
        getMuxBackend: () => mux,
        selectBackend: () => "pane",
      });
      assert.equal(result.muxPreference, mux);
      assert.equal(result.muxPreferenceInvalid, null);
      assert.equal(result.mux, mux);
      assert.equal(result.backend, "pane");
    });
  }

  it("PI_SUBAGENT_MODE=headless overrides mux availability", () => {
    const result = buildDetectionPayload({
      env: { PI_SUBAGENT_MODE: "headless" },
      getMuxBackend: () => "herdr",
      selectBackend: () => "headless",
    });
    assert.equal(result.backend, "headless");
    assert.equal(result.modeForced, "headless");
    assert.equal(result.mux, null);
  });

  it("PI_SUBAGENT_MODE=pane with no mux", () => {
    const result = buildDetectionPayload({
      env: { PI_SUBAGENT_MODE: "pane" },
      getMuxBackend: () => null,
      selectBackend: () => "pane",
    });
    assert.equal(result.backend, "pane");
    assert.equal(result.mux, null);
    assert.equal(result.modeForced, "pane");
    assert.ok(result.reason.includes("no mux available"), `reason: ${result.reason}`);
  });

  it("PI_SUBAGENT_MUX=herdr valid preference", () => {
    const result = buildDetectionPayload({
      env: { PI_SUBAGENT_MUX: "herdr" },
      getMuxBackend: () => "herdr",
      selectBackend: () => "pane",
    });
    assert.equal(result.muxPreference, "herdr");
    assert.equal(result.muxPreferenceInvalid, null);
    assert.equal(result.mux, "herdr");
  });

  it("unavailable forced mux preference", () => {
    const result = buildDetectionPayload({
      env: { PI_SUBAGENT_MUX: "herdr" },
      getMuxBackend: () => null,
      selectBackend: () => "headless",
    });
    assert.equal(result.muxPreference, "herdr");
    assert.equal(result.mux, null);
    assert.equal(result.backend, "headless");
  });

  it("invalid mux preference", () => {
    const result = buildDetectionPayload({
      env: { PI_SUBAGENT_MUX: "garbage" },
      getMuxBackend: () => "cmux",
      selectBackend: () => "pane",
    });
    assert.equal(result.muxPreference, null);
    assert.equal(result.muxPreferenceInvalid, "garbage");
  });
});

// --- Runtime-parity helpers ---

const SAVED_KEYS = [
  "PI_SUBAGENT_MODE", "PI_SUBAGENT_MUX",
  "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH",
  "CMUX_SOCKET_PATH",
  "TMUX",
  "ZELLIJ", "ZELLIJ_SESSION_NAME",
  "WEZTERM_UNIX_SOCKET",
  // termio 后端按 TERM_PROGRAM/TERMIOD_SESSION_ID 判定。本测试套件必须清掉它们，
  // 否则在 termio 里跑测试时 baseline 用例会真的检测到 termio 而不再是 headless。
  "TERM_PROGRAM", "TERMIOD_SESSION_ID", "TERMIO_SESSION", "TERMIO_CLI",
  "PATH",
];

function snapshotEnv(): Record<string, string | undefined> {
  const s: Record<string, string | undefined> = {};
  for (const k of SAVED_KEYS) s[k] = process.env[k];
  return s;
}

function restoreEnv(s: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(s)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function installFakeHerdrOnPath(): { dir: string; restorePath: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-mux-detect-fakebin-"));
  const script = "#!/bin/sh\nexit 0\n";
  const target = join(dir, "herdr");
  writeFileSync(target, script);
  chmodSync(target, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = previousPath ? `${dir}:${previousPath}` : dir;
  return {
    dir,
    restorePath(): void {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

describe("CLI vs runtime parity", () => {
  let snap: Record<string, string | undefined>;

  beforeEach(() => {
    snap = snapshotEnv();
    for (const k of SAVED_KEYS) {
      if (k !== "PATH") delete process.env[k];
    }
    selectTest.resetWarnedValues();
    selectTest.restoreDetectMux();
    shellTest.clearCommandAvailability();
  });

  afterEach(() => {
    selectTest.restoreDetectMux();
    shellTest.clearCommandAvailability();
    restoreEnv(snap);
  });

  it("headless baseline (no env, real detector)", () => {
    const runtimeBackend = realSelectBackend();
    const runtimeMux = realGetMuxBackend();
    assert.equal(runtimeBackend, "headless");
    assert.equal(runtimeMux, null);

    const payload = buildDetectionPayload({
      env: { ...process.env } as Record<string, string>,
      getMuxBackend: realGetMuxBackend,
      selectBackend: realSelectBackend,
    });
    assert.equal(payload.backend, "headless");
    assert.equal(payload.mux, null);
  });

  it("PI_SUBAGENT_MODE=headless overrides a positive detector", () => {
    process.env.PI_SUBAGENT_MODE = "headless";
    selectTest.setDetectMux(() => true);

    const runtimeBackend = realSelectBackend();
    assert.equal(runtimeBackend, "headless");

    const payload = buildDetectionPayload({
      env: { ...process.env } as Record<string, string>,
      getMuxBackend: realGetMuxBackend,
      selectBackend: realSelectBackend,
    });
    assert.equal(payload.backend, "headless");
    assert.equal(payload.mux, null);
    assert.equal(payload.modeForced, "headless");
  });

  it("PI_SUBAGENT_MODE=pane with no mux available", () => {
    process.env.PI_SUBAGENT_MODE = "pane";

    const runtimeBackend = realSelectBackend();
    const runtimeMux = realGetMuxBackend();
    assert.equal(runtimeBackend, "pane");
    assert.equal(runtimeMux, null);

    const payload = buildDetectionPayload({
      env: { ...process.env } as Record<string, string>,
      getMuxBackend: realGetMuxBackend,
      selectBackend: realSelectBackend,
    });
    assert.equal(payload.backend, "pane");
    assert.equal(payload.mux, null);
    assert.equal(payload.modeForced, "pane");
  });

  it("auto-pane via forced detector", () => {
    selectTest.setDetectMux(() => true);

    const runtimeBackend = realSelectBackend();
    assert.equal(runtimeBackend, "pane");

    const payload = buildDetectionPayload({
      env: { ...process.env } as Record<string, string>,
      getMuxBackend: realGetMuxBackend,
      selectBackend: realSelectBackend,
    });
    assert.equal(payload.backend, "pane");
    assert.equal(payload.mux, null);
  });

  it("invalid PI_SUBAGENT_MUX", () => {
    process.env.PI_SUBAGENT_MUX = "garbage";

    const runtimeMux = realGetMuxBackend();
    assert.equal(runtimeMux, null);

    const payload = buildDetectionPayload({
      env: { ...process.env } as Record<string, string>,
      getMuxBackend: realGetMuxBackend,
      selectBackend: realSelectBackend,
    });
    assert.equal(payload.muxPreference, null);
    assert.equal(payload.muxPreferenceInvalid, "garbage");
    assert.equal(payload.backend, "headless");
    assert.equal(payload.mux, null);
  });

  it("Herdr via real runtime detection (fake herdr on PATH)", (t) => {
    if (process.platform === "win32") {
      t.skip("herdr adapter PATH probe is POSIX-only");
      return;
    }

    const fakeBin = installFakeHerdrOnPath();
    t.after(() => fakeBin.restorePath());

    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "test-pane-1";

    shellTest.clearCommandAvailability();

    const runtimeMux = realGetMuxBackend();
    assert.equal(runtimeMux, "herdr");

    const runtimeBackend = realSelectBackend();
    assert.equal(runtimeBackend, "pane");

    const payload = buildDetectionPayload({
      env: { ...process.env } as Record<string, string>,
      getMuxBackend: realGetMuxBackend,
      selectBackend: realSelectBackend,
    });
    assert.equal(payload.backend, "pane");
    assert.equal(payload.mux, "herdr");
    assert.equal(payload.modeForced, null);
    assert.equal(payload.muxPreference, null);
    assert.equal(payload.muxPreferenceInvalid, null);
    assert.equal(typeof payload.reason, "string");
    assert.ok(payload.reason.includes("mux=herdr"), `reason: ${payload.reason}`);
  });
});

const DETECT_CLI = fileURLToPath(new URL("../../src/bin/pi-mux-detect.ts", import.meta.url));

describe("pi-mux-detect CLI stderr diagnostics (unchanged by dispatcher refactor)", () => {
  it("writes the unknown-argument diagnostic to stderr byte-for-byte and exits 2", () => {
    const run = spawnSync(process.execPath, [DETECT_CLI, "--bogus-arg"], { encoding: "utf8" });
    assert.equal(run.status, 2, `expected exit code 2; stderr=${run.stderr}`);
    assert.equal(run.stdout, "", "diagnostic must not leak to stdout");
    assert.equal(
      run.stderr,
      "Unknown argument: --bogus-arg\nUsage: pi-mux-detect [--help|-h] [--version]\n",
      "CLI stderr diagnostic must be byte-for-byte unchanged",
    );
  });
});

import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type MuxBackend, type MuxAdapter, type PollResult } from "./types.ts";
import { shellEscape } from "./shell.ts";
import { cmuxAdapter } from "./adapters/cmux.ts";
import { herdrAdapter } from "./adapters/herdr.ts";
import { tmuxAdapter } from "./adapters/tmux.ts";
import { zellijAdapter } from "./adapters/zellij.ts";
import { weztermAdapter } from "./adapters/wezterm.ts";
import { termioAdapter } from "./adapters/termio.ts";

export type { MuxBackend } from "./types.ts";
export { shellEscape } from "./shell.ts";

const ADAPTERS: readonly MuxAdapter[] = [
  herdrAdapter,
  cmuxAdapter,
  tmuxAdapter,
  zellijAdapter,
  weztermAdapter,
  termioAdapter,
];

export function parseMuxPreference(raw: string | undefined): {
  preference: MuxBackend | null;
  invalidRaw: string | null;
} {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed) return { preference: null, invalidRaw: null };
  if (
    trimmed === "cmux" || trimmed === "tmux" || trimmed === "zellij" ||
    trimmed === "wezterm" || trimmed === "herdr" || trimmed === "termio"
  ) {
    return { preference: trimmed as MuxBackend, invalidRaw: null };
  }
  return { preference: null, invalidRaw: trimmed };
}

function muxPreference(): MuxBackend | null {
  return parseMuxPreference(process.env.PI_SUBAGENT_MUX).preference;
}

export function getMuxBackend(): MuxBackend | null {
  const pref = muxPreference();
  if (pref) {
    const adapter = ADAPTERS.find((a) => a.name === pref);
    return adapter && adapter.isAvailable() ? pref : null;
  }
  for (const adapter of ADAPTERS) {
    if (adapter.isAvailable()) return adapter.name;
  }
  return null;
}

export function isMuxAvailable(): boolean {
  return getMuxBackend() !== null;
}

export function detectMux(): boolean {
  return getMuxBackend() !== null;
}

export function muxSetupHint(): string {
  const pref = muxPreference();
  if (pref) {
    const adapter = ADAPTERS.find((a) => a.name === pref);
    if (adapter) return adapter.setupHint();
  }
  return "Start pi inside cmux (`cmux pi`), tmux (`tmux new -A -s pi 'pi'`), zellij (`zellij --session pi`, then run `pi`), WezTerm, herdr (`herdr`, then run `pi`), or termio (open a termio session, then run `pi`).";
}

export function isCmuxAvailable(): boolean {
  return cmuxAdapter.isAvailable();
}

export function isTmuxAvailable(): boolean {
  return tmuxAdapter.isAvailable();
}

export function isZellijAvailable(): boolean {
  return zellijAdapter.isAvailable();
}

export function isWezTermAvailable(): boolean {
  return weztermAdapter.isAvailable();
}

export function isHerdrAvailable(): boolean {
  return herdrAdapter.isAvailable();
}

export function isTermioAvailable(): boolean {
  return termioAdapter.isAvailable();
}

function requireMuxAdapter(): MuxAdapter {
  const backend = getMuxBackend();
  if (!backend) {
    throw new Error(`No supported terminal multiplexer found. ${muxSetupHint()}`);
  }
  const adapter = ADAPTERS.find((a) => a.name === backend);
  if (!adapter) {
    throw new Error(`Unknown mux backend: ${backend}`);
  }
  return adapter;
}

export function createSurface(name: string, opts?: { detach?: boolean }): string {
  return requireMuxAdapter().createSurface(name, opts);
}

export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  opts?: { detach?: boolean },
): string {
  return requireMuxAdapter().createSurfaceSplit(name, direction, fromSurface, opts);
}

export function closeSurface(surface: string): void {
  requireMuxAdapter().closeSurface(surface);
}

export function sendCommand(surface: string, command: string): void {
  requireMuxAdapter().sendCommand(surface, command);
}

export function sendEscape(surface: string): void {
  requireMuxAdapter().sendEscape(surface);
}

export function readScreen(surface: string, lines = 50): string {
  return requireMuxAdapter().readScreen(surface, lines);
}

export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  return requireMuxAdapter().readScreenAsync(surface, lines);
}

export function renameCurrentTab(title: string): void {
  requireMuxAdapter().renameCurrentTab(title);
}

export function renameWorkspace(title: string): void {
  requireMuxAdapter().renameWorkspace(title);
}

export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
    /**
     * Test seam: override the screen reader. Defaults to `readScreenAsync`,
     * which dispatches to the active mux adapter.
     */
    readScreen?: (surface: string, lines: number) => Promise<string>;
    /**
     * Bail out with a `surface closed externally` error after this many
     * consecutive screen-read failures without any completion signal. A
     * single transient read failure is tolerated; a destroyed surface
     * (where reads will never succeed again) eventually unblocks the poll.
     */
    maxConsecutiveReadFailures?: number;
  },
): Promise<PollResult> {
  const start = Date.now();
  const reader = options.readScreen ?? readScreenAsync;
  const maxConsecutiveReadFailures = options.maxConsecutiveReadFailures ?? 5;
  let consecutiveReadFailures = 0;

  while (true) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by subagent_done / caller_ping)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf8"));
          rmSync(exitFile, { force: true });
          if (data.type === "ping") {
            return { reason: "ping", exitCode: 0, ping: { name: data.name, message: data.message } };
          }
          return { reason: "done", exitCode: 0 };
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await reader(surface, 5);
      consecutiveReadFailures = 0;
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      consecutiveReadFailures++;
      // Surface may have been destroyed — re-check completion signals before
      // giving up, so a late .exit / sentinel still resolves cleanly.
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf8"));
            rmSync(exitFile, { force: true });
            if (data.type === "ping") {
              return { reason: "ping", exitCode: 0, ping: { name: data.name, message: data.message } };
            }
            return { reason: "done", exitCode: 0 };
          }
        } catch {}
      }
      if (options.sentinelFile) {
        try {
          if (existsSync(options.sentinelFile)) {
            return { reason: "sentinel", exitCode: 0 };
          }
        } catch {}
      }
      if (consecutiveReadFailures >= maxConsecutiveReadFailures) {
        throw new Error("Subagent surface closed externally before completion");
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

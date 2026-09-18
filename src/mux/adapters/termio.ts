import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MuxAdapter } from "../types.ts";
import { hasCommand, shellEscape } from "../shell.ts";

const execFileAsync = promisify(execFile);

/**
 * 子代理分屏的默认占比：新 pane 占 35%，父 pane 保留主视野。
 * 语义与 termio CLI 的 `--ratio` 一致，可用 PI_SUBAGENT_TERMIO_RATIO 覆盖。
 */
const DEFAULT_SPLIT_RATIO = "0.35";

let cachedCliPath: string | null | undefined;

/**
 * 解析 termio CLI 的可执行路径。
 * termio 默认不把 CLI 装进 PATH（官方入口是应用包内的 Resources/termio），
 * 因此按「显式覆盖 → PATH → 应用包内官方路径」三级回退，
 * 否则 hasCommand("termio") 会误判为后端不可用。
 */
export function resolveTermioCliPath(): string | null {
  if (cachedCliPath !== undefined) return cachedCliPath;

  const override = process.env.TERMIO_CLI?.trim();
  if (override) {
    cachedCliPath = override;
    return cachedCliPath;
  }

  if (hasCommand("termio")) {
    cachedCliPath = "termio";
    return cachedCliPath;
  }

  const bundleCandidates = [
    "/Applications/termio.app/Contents/Resources/termio",
    join(homedir(), "Applications/termio.app/Contents/Resources/termio"),
  ];
  for (const candidate of bundleCandidates) {
    if (existsSync(candidate)) {
      cachedCliPath = candidate;
      return cachedCliPath;
    }
  }

  cachedCliPath = null;
  return cachedCliPath;
}

/**
 * 分屏方向归一化。
 * termio 的 `--direction` 只认 right/down，且锚点永远是调用方自己的 pane
 * （没有「相对某个指定 pane」的语法），所以 left/up 退化为就近方向。
 */
export function mapTermioDirection(
  direction: "left" | "right" | "up" | "down",
): "right" | "down" {
  return direction === "left" || direction === "right" ? "right" : "down";
}

/** 分屏占比：默认 0.35，环境变量非法时回退默认，避免把坏值传给 CLI。 */
export function termioSplitRatio(): string {
  const raw = process.env.PI_SUBAGENT_TERMIO_RATIO?.trim();
  if (!raw) return DEFAULT_SPLIT_RATIO;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? String(parsed) : DEFAULT_SPLIT_RATIO;
}

/**
 * 构造 `termio sessions run` 的 argv。
 * 纯函数，便于回归「方向 + 占比 + JSON 输出」这条启动契约。
 */
export function buildTermioRunArgs(params: {
  command: string;
  direction: "left" | "right" | "up" | "down";
  ratio?: string;
}): string[] {
  return [
    "sessions",
    "run",
    params.command,
    "--direction",
    mapTermioDirection(params.direction),
    "--ratio",
    params.ratio ?? termioSplitRatio(),
    "--json",
  ];
}

/** 把 execFileSync 的失败原因补上 stderr，否则 CLI 的 JSON 报错会被吞成一句 exit code。 */
function formatTermioCliError(error: unknown, args: readonly string[]): Error {
  const stderr = (error as { stderr?: Buffer | string } | null)?.stderr;
  const detail = typeof stderr === "string" ? stderr : stderr?.toString("utf8");
  const fallback = error instanceof Error ? error.message : String(error);
  return new Error(`termio ${args.join(" ")} failed: ${(detail ?? fallback).trim()}`);
}

function requireTermioCli(): string {
  const cli = resolveTermioCliPath();
  if (!cli) throw new Error(`termio CLI not found. ${termioAdapter.setupHint()}`);
  return cli;
}

function runTermio(args: readonly string[]): string {
  const cli = requireTermioCli();
  try {
    return execFileSync(cli, args as string[], { encoding: "utf8" });
  } catch (error) {
    throw formatTermioCliError(error, args);
  }
}

/** 解析 termio 的 --json 输出；空输出或非 JSON 一律报错，不静默降级成空对象。 */
function runTermioJson(args: readonly string[]): Record<string, unknown> {
  const stdout = runTermio(args).trim();
  if (!stdout) throw new Error(`termio ${args.join(" ")} returned empty stdout`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`termio ${args.join(" ")} returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`termio ${args.join(" ")} returned unexpected JSON: ${stdout.slice(0, 200)}`);
  }
  return parsed as Record<string, unknown>;
}

export const termioAdapter: MuxAdapter = {
  name: "termio",

  /**
   * TERM_PROGRAM 是 termio 终端自身的标记（与 otty/orca 后端的判定方式一致），
   * TERMIOD_SESSION_ID 是「确实挂在一个 termio 会话上」的兜底证据 ——
   * 没有它，分屏就没有可锚定的调用方 pane。
   */
  isAvailable(): boolean {
    const insideTermio =
      process.env.TERM_PROGRAM === "termio" || !!process.env.TERMIOD_SESSION_ID;
    return insideTermio && resolveTermioCliPath() !== null;
  },

  setupHint(): string {
    return "Start pi inside termio (open a termio session, then run `pi`), or point TERMIO_CLI at the termio CLI.";
  },

  createSurface(name: string, opts?: { detach?: boolean }): string {
    return this.createSurfaceSplit(name, "right", undefined, opts);
  },

  /**
   * 新建分屏 surface 并返回它的 termio://session 链接。
   *
   * termio 没有「建一个空 pane」的原语：`sessions run` 会新开一个 pane 并把命令敲进去。
   * 所以这里先落成一个交互式登录 shell（`exec <shell> -l`），后续 sendCommand 才有东西可写。
   *
   * fromSurface 被有意忽略：termio 的分屏锚点永远是调用方自己的 pane（读 TERMIOD_SESSION_ID），
   * 这正是子代理要的语义 —— 新 pane 贴着父 agent 开。
   * opts.detach 天然满足：新建 pane 不抢焦点，聚焦必须显式调用 `sessions focus`。
   */
  createSurfaceSplit(
    _name: string,
    direction: "left" | "right" | "up" | "down",
    _fromSurface?: string,
    _opts?: { detach?: boolean },
  ): string {
    const shell = process.env.SHELL?.trim() || "/bin/sh";
    const args = buildTermioRunArgs({ command: `exec ${shellEscape(shell)} -l`, direction });
    const payload = runTermioJson(args);

    const target = payload.target;
    if (typeof target !== "string" || !target.startsWith("termio://session/")) {
      throw new Error(`Unexpected termio run output: ${JSON.stringify(payload).slice(0, 200)}`);
    }
    return target;
  },

  closeSurface(surface: string): void {
    runTermio(["sessions", "close", surface]);
  },

  sendCommand(surface: string, command: string): void {
    runTermio(["sessions", "send", surface, command]);
  },

  /**
   * termio 只接受命名按键，由终端自己的按键编码器生成字节。
   * 手动写 ESC 字节在应用模式下会错位，所以必须走 `--key escape`。
   */
  sendEscape(surface: string): void {
    runTermio(["sessions", "send", surface, "--key", "escape"]);
  },

  readScreen(surface: string, lines = 50): string {
    return runTermio(["sessions", "read", surface, "--lines", String(Math.max(1, lines))]);
  },

  async readScreenAsync(surface: string, lines = 50): Promise<string> {
    const cli = requireTermioCli();
    const args = ["sessions", "read", surface, "--lines", String(Math.max(1, lines))];
    try {
      const { stdout } = await execFileAsync(cli, args, { encoding: "utf8" });
      return stdout;
    } catch (error) {
      throw formatTermioCliError(error, args);
    }
  },

  /** termio CLI 没有改名接口（标题由 termio 按 agent 与项目自生成），保持 no-op。 */
  renameCurrentTab(_title: string): void {},

  renameWorkspace(_title: string): void {},
};

export const __test__ = {
  clearCliPathCache(): void {
    cachedCliPath = undefined;
  },
};

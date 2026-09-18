import type { MuxBackend } from "../mux/index.ts";
import { getMuxBackend as realGetMuxBackend, parseMuxPreference } from "../mux/index.ts";
import { selectBackend as realSelectBackend } from "../backends/select.ts";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";

export type DetectionPayload = {
  backend: "pane" | "headless";
  mux: MuxBackend | null;
  modeForced: "pane" | "headless" | null;
  muxPreference: MuxBackend | null;
  muxPreferenceInvalid: string | null;
  reason: string;
};

export function buildDetectionPayload({
  env,
  getMuxBackend,
  selectBackend,
}: {
  env: NodeJS.ProcessEnv;
  getMuxBackend: () => MuxBackend | null;
  selectBackend: () => "pane" | "headless";
}): DetectionPayload {
  const rawMode = (env.PI_SUBAGENT_MODE ?? "").trim().toLowerCase();
  const modeForced: "pane" | "headless" | null =
    rawMode === "pane" ? "pane" : rawMode === "headless" ? "headless" : null;

  const { preference: muxPreference, invalidRaw: muxPreferenceInvalid } =
    parseMuxPreference(env.PI_SUBAGENT_MUX);

  const backend = selectBackend();
  const mux = backend === "headless" ? null : getMuxBackend();

  let reason: string;
  if (modeForced === "headless") {
    reason = "PI_SUBAGENT_MODE=headless forced headless backend";
  } else if (modeForced === "pane") {
    if (mux) {
      if (muxPreference) {
        reason = `PI_SUBAGENT_MODE=pane forced pane backend; mux=${mux} selected via PI_SUBAGENT_MUX`;
      } else {
        reason = `PI_SUBAGENT_MODE=pane forced pane backend; mux=${mux} from detection order [herdr,cmux,tmux,zellij,wezterm,termio]`;
      }
    } else {
      reason = "PI_SUBAGENT_MODE=pane forced pane backend; no mux available";
    }
  } else {
    if (backend === "pane" && mux) {
      if (muxPreference) {
        reason = `auto-selected pane backend; mux=${mux} selected via PI_SUBAGENT_MUX`;
      } else {
        reason = `auto-selected pane backend; mux=${mux} from detection order [herdr,cmux,tmux,zellij,wezterm,termio]`;
      }
    } else {
      reason = "auto-selected headless backend; no supported mux detected";
    }
  }

  if (muxPreferenceInvalid) {
    reason += `; PI_SUBAGENT_MUX='${muxPreferenceInvalid}' invalid; fell back to detection order`;
  }

  return {
    backend,
    mux,
    modeForced,
    muxPreference,
    muxPreferenceInvalid,
    reason,
  };
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: pi-mux-detect [--help|-h] [--version]\n" +
        "  (no args) — detect mux backend and print JSON payload to stdout\n",
    );
    process.exit(0);
  }

  if (args.includes("--version")) {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    process.stdout.write(pkg.version + "\n");
    process.exit(0);
  }

  if (args.length > 0) {
    process.stderr.write(`Unknown argument: ${args[0]}\nUsage: pi-mux-detect [--help|-h] [--version]\n`);
    process.exit(2);
  }

  try {
    const payload = buildDetectionPayload({
      env: process.env,
      getMuxBackend: realGetMuxBackend,
      selectBackend: realSelectBackend,
    });
    process.stdout.write(JSON.stringify(payload) + "\n");
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(JSON.stringify({ error: message }) + "\n");
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}

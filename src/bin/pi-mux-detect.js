#!/usr/bin/env node

// src/mux/shell.ts
import { execSync, execFileSync } from "node:child_process";
var commandAvailability = /* @__PURE__ */ new Map();
function hasCommand(command) {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command);
  }
  let available;
  if (process.platform === "win32") {
    try {
      execFileSync("where.exe", [command], { stdio: "ignore" });
      available = true;
    } catch {
      try {
        execSync(`command -v ${command}`, { stdio: "ignore" });
        available = true;
      } catch {
        available = false;
      }
    }
  } else {
    try {
      execSync(`command -v ${command}`, { stdio: "ignore" });
      available = true;
    } catch {
      available = false;
    }
  }
  commandAvailability.set(command, available);
  return available;
}
function shellEscape(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
function tailLines(text, lines) {
  const split = text.split("\n");
  if (split.length <= lines) return text;
  return split.slice(-lines).join("\n");
}

// src/mux/adapters/cmux.ts
import { execSync as execSync2, execFile, execFileSync as execFileSync2, spawnSync } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var cmuxSubagentPane = null;
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
function parseCmuxFocusedSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  const focused = value.focused;
  if (!focused || typeof focused !== "object") return null;
  const record = focused;
  const surfaceRef = nonEmptyString(record.surface_ref) ? record.surface_ref : void 0;
  const paneRef = nonEmptyString(record.pane_ref) ? record.pane_ref : void 0;
  if (!surfaceRef && !paneRef) return null;
  return { surfaceRef, paneRef };
}
function parseCmuxJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function parseCmuxCallerSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  const caller = value.caller;
  if (!caller || typeof caller !== "object") return null;
  const record = caller;
  const surfaceRef = nonEmptyString(record.surface_ref) ? record.surface_ref : void 0;
  const paneRef = nonEmptyString(record.pane_ref) ? record.pane_ref : void 0;
  if (!surfaceRef && !paneRef) return null;
  return { surfaceRef, paneRef };
}
function parseCmuxPaneRefForSurface(value, surface) {
  if (!value || typeof value !== "object") return null;
  const record = value;
  if (record.surface_ref === surface && nonEmptyString(record.pane_ref)) return record.pane_ref;
  const caller = record.caller;
  if (!caller || typeof caller !== "object") return null;
  const callerRecord = caller;
  if (callerRecord.surface_ref === surface && nonEmptyString(callerRecord.pane_ref)) {
    return callerRecord.pane_ref;
  }
  return null;
}
function parseCmuxPaneRefForSurfaceFromJson(value, surface) {
  return parseCmuxPaneRefForSurface(parseCmuxJson(value), surface);
}
function isCmuxForegroundAppIdentity(identity) {
  const bundleIdentifier = identity?.bundleIdentifier?.trim().toLowerCase();
  if (bundleIdentifier === "com.cmuxterm.app") return true;
  const localizedName = identity?.localizedName?.trim().toLowerCase();
  return localizedName === "cmux";
}
function readMacForegroundAppIdentity() {
  try {
    const script = `
      ObjC.import("AppKit");
      const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
      if (!app) {
        JSON.stringify({});
      } else {
        JSON.stringify({
          bundleIdentifier: app.bundleIdentifier ? ObjC.unwrap(app.bundleIdentifier) : "",
          localizedName: app.localizedName ? ObjC.unwrap(app.localizedName) : "",
        });
      }
    `;
    const output = execFileSync2("osascript", ["-l", "JavaScript", "-e", script], {
      encoding: "utf8",
      timeout: 1e3
    }).trim();
    const parsed = parseCmuxJson(output);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed;
    return {
      bundleIdentifier: nonEmptyString(record.bundleIdentifier) ? record.bundleIdentifier : void 0,
      localizedName: nonEmptyString(record.localizedName) ? record.localizedName : void 0
    };
  } catch {
    return null;
  }
}
function isCmuxForegroundApp() {
  if (process.platform !== "darwin") return true;
  return isCmuxForegroundAppIdentity(readMacForegroundAppIdentity());
}
function readCmux(args) {
  const result = spawnSync("cmux", args, { encoding: "utf8" });
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
  return result.stdout;
}
function parseCmuxIdentifySnapshot(value) {
  const parsed = value ? parseCmuxJson(value) : null;
  return {
    focused: parseCmuxFocusedSnapshot(parsed),
    caller: parseCmuxCallerSnapshot(parsed)
  };
}
function captureCmuxIdentifySnapshot() {
  return parseCmuxIdentifySnapshot(readCmux(["identify", "--json"]));
}
function captureCmuxFocusSnapshot() {
  return captureCmuxIdentifySnapshot().focused;
}
function readCmuxPaneRefForSurface(surface) {
  const info = readCmux(["identify", "--surface", surface]);
  return info ? parseCmuxPaneRefForSurfaceFromJson(info, surface) : null;
}
function restoreCmuxFocusSnapshot(snapshot, options) {
  if (!snapshot) return;
  if (options?.cmuxWasForeground === false) return;
  if (!isCmuxForegroundApp()) return;
  if (snapshot.paneRef) {
    spawnSync("cmux", ["focus-pane", "--pane", snapshot.paneRef], { encoding: "utf8" });
  }
  if (snapshot.surfaceRef) {
    spawnSync("cmux", ["focus-panel", "--panel", snapshot.surfaceRef], { encoding: "utf8" });
  }
}
function waitForCmuxFocusSettle() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}
function cmuxFocusMatchesChild(currentFocus, child) {
  if (!currentFocus) return false;
  if (currentFocus.surfaceRef === child.surface) return true;
  return !!currentFocus.paneRef && currentFocus.paneRef === child.paneRef;
}
function cmuxFocusMatchesSurfaceRef(currentFocus, surfaceRef) {
  return !!surfaceRef && currentFocus?.surfaceRef === surfaceRef;
}
function cmuxFocusMatchesPaneRef(currentFocus, paneRef) {
  return !!paneRef && currentFocus?.paneRef === paneRef;
}
function shouldRestoreCmuxFocusAfterLaunch(params) {
  if (!params.cmuxWasForeground || params.cmuxIsForeground === false || !params.snapshot) {
    return false;
  }
  return cmuxFocusMatchesChild(params.currentFocus, params.child) || cmuxFocusMatchesSurfaceRef(params.currentFocus, params.sourceSurfaceRef) || cmuxFocusMatchesSurfaceRef(params.currentFocus, params.callerSnapshot?.surfaceRef) || // cmux can settle focus onto another active surface in the caller pane
  // after creating a split/surface; treat that as "focus moved as a
  // side-effect of the launch" and restore the original snapshot.
  cmuxFocusMatchesPaneRef(params.currentFocus, params.callerSnapshot?.paneRef);
}
function restoreCmuxFocusIfLaunchSurfaceFocused(snapshot, child, options) {
  if (!snapshot || !options.cmuxWasForeground) return;
  waitForCmuxFocusSettle();
  const currentFocus = captureCmuxFocusSnapshot();
  const cmuxIsForeground = isCmuxForegroundApp();
  if (shouldRestoreCmuxFocusAfterLaunch({
    cmuxWasForeground: options.cmuxWasForeground,
    cmuxIsForeground,
    snapshot,
    currentFocus,
    child,
    sourceSurfaceRef: options.sourceSurfaceRef,
    callerSnapshot: options.callerSnapshot
  })) {
    restoreCmuxFocusSnapshot(snapshot, { cmuxWasForeground: true });
  }
}
function parseCmuxCreatedSurface(output, command) {
  const surfaceMatch = output.match(/surface:\d+/);
  if (!surfaceMatch) {
    throw new Error(`Unexpected cmux ${command} output: ${output}`);
  }
  return {
    surface: surfaceMatch[0],
    paneRef: output.match(/pane:\d+/)?.[0]
  };
}
function renameCmuxSurface(surface, name) {
  execFileSync2("cmux", ["rename-tab", "--surface", surface, name], { encoding: "utf8" });
}
function createCmuxSplitSurface(name, direction, fromSurface) {
  const identifySnapshot = captureCmuxIdentifySnapshot();
  const focusSnapshot = identifySnapshot.focused;
  const callerSnapshot = identifySnapshot.caller;
  const cmuxWasForeground = isCmuxForegroundApp();
  let child = null;
  try {
    const args = ["new-split", direction];
    if (fromSurface) args.push("--surface", fromSurface);
    const output = execFileSync2("cmux", args, { encoding: "utf8" }).trim();
    child = parseCmuxCreatedSurface(output, "new-split");
    child.paneRef ??= readCmuxPaneRefForSurface(child.surface) ?? void 0;
    renameCmuxSurface(child.surface, name);
    return child;
  } finally {
    if (child) {
      restoreCmuxFocusIfLaunchSurfaceFocused(focusSnapshot, child, {
        cmuxWasForeground,
        sourceSurfaceRef: fromSurface,
        callerSnapshot
      });
    } else {
      restoreCmuxFocusSnapshot(focusSnapshot, { cmuxWasForeground });
    }
  }
}
function createSurfaceInPane(name, pane) {
  const identifySnapshot = captureCmuxIdentifySnapshot();
  const focusSnapshot = identifySnapshot.focused;
  const callerSnapshot = identifySnapshot.caller;
  const cmuxWasForeground = isCmuxForegroundApp();
  let child = null;
  try {
    const output = execFileSync2("cmux", ["new-surface", "--pane", pane], {
      encoding: "utf8"
    }).trim();
    child = parseCmuxCreatedSurface(output, "new-surface");
    child.paneRef ??= pane;
    renameCmuxSurface(child.surface, name);
    return child.surface;
  } finally {
    if (child) {
      restoreCmuxFocusIfLaunchSurfaceFocused(focusSnapshot, child, {
        cmuxWasForeground,
        callerSnapshot
      });
    } else {
      restoreCmuxFocusSnapshot(focusSnapshot, { cmuxWasForeground });
    }
  }
}
var cmuxAdapter = {
  name: "cmux",
  isAvailable() {
    return !!process.env.CMUX_SOCKET_PATH && hasCommand("cmux");
  },
  setupHint() {
    return "Start pi inside cmux (`cmux pi`).";
  },
  createSurface(name, _opts) {
    if (cmuxSubagentPane) {
      try {
        const tree = execSync2(`cmux tree`, { encoding: "utf8" });
        if (tree.includes(cmuxSubagentPane)) {
          return createSurfaceInPane(name, cmuxSubagentPane);
        }
      } catch {
      }
      cmuxSubagentPane = null;
    }
    const created = createCmuxSplitSurface(name, "right", process.env.CMUX_SURFACE_ID);
    cmuxSubagentPane = created.paneRef ?? null;
    return created.surface;
  },
  createSurfaceSplit(name, direction, fromSurface, _opts) {
    return createCmuxSplitSurface(name, direction, fromSurface).surface;
  },
  closeSurface(surface) {
    execSync2(`cmux close-surface --surface ${shellEscape(surface)}`, { encoding: "utf8" });
  },
  sendCommand(surface, command) {
    execSync2(`cmux send --surface ${shellEscape(surface)} ${shellEscape(command + "\n")}`, {
      encoding: "utf8"
    });
  },
  sendEscape(surface) {
    execFileSync2("cmux", ["send", "--surface", surface, "\x1B"], { encoding: "utf8" });
  },
  readScreen(surface, lines = 50) {
    return execSync2(`cmux read-screen --surface ${shellEscape(surface)} --lines ${lines}`, {
      encoding: "utf8"
    });
  },
  async readScreenAsync(surface, lines = 50) {
    const { stdout } = await execFileAsync(
      "cmux",
      ["read-screen", "--surface", surface, "--lines", String(lines)],
      { encoding: "utf8" }
    );
    return stdout;
  },
  renameCurrentTab(title) {
    const surfaceId = process.env.CMUX_SURFACE_ID;
    if (!surfaceId) throw new Error("CMUX_SURFACE_ID not set");
    execSync2(`cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`, {
      encoding: "utf8"
    });
  },
  renameWorkspace(title) {
    execSync2(`cmux workspace-action --action rename --title ${shellEscape(title)}`, {
      encoding: "utf8"
    });
  }
};

// src/mux/adapters/herdr.ts
import { execFile as execFile2, execFileSync as execFileSync3 } from "node:child_process";
import { promisify as promisify2 } from "node:util";
var execFileAsync2 = promisify2(execFile2);
function parseHerdrJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function parseHerdrPaneInfo(value) {
  if (!value || typeof value !== "object") return null;
  const paneValue = value.pane;
  const resultValue = value.result;
  const resultPaneValue = resultValue && typeof resultValue === "object" ? resultValue.pane : void 0;
  const record = paneValue ?? resultPaneValue ?? value;
  if (typeof record.pane_id !== "string" || record.pane_id.length === 0 || typeof record.tab_id !== "string" || record.tab_id.length === 0 || typeof record.workspace_id !== "string" || record.workspace_id.length === 0 || typeof record.terminal_id !== "string" || record.terminal_id.length === 0) {
    return null;
  }
  const info = {
    pane_id: record.pane_id,
    tab_id: record.tab_id,
    workspace_id: record.workspace_id,
    terminal_id: record.terminal_id
  };
  if (typeof record.focused === "boolean") info.focused = record.focused;
  return info;
}
function parseHerdrTabCreateResult(value) {
  if (!value || typeof value !== "object") return null;
  const result = value.result;
  if (!result || typeof result !== "object") return null;
  return parseHerdrPaneInfo(result.root_pane);
}
function parseHerdrPaneSplitResult(value) {
  if (!value || typeof value !== "object") return null;
  const result = value.result;
  if (!result || typeof result !== "object") return null;
  return parseHerdrPaneInfo(result.pane);
}
function parseHerdrPaneList(value) {
  if (!value) return null;
  let array;
  if (Array.isArray(value)) {
    array = value;
  } else if (typeof value === "object") {
    const result = value.result;
    if (Array.isArray(result)) {
      array = result;
    } else if (result && typeof result === "object" && Array.isArray(result.panes)) {
      array = result.panes;
    } else if (Array.isArray(value.panes)) {
      array = value.panes;
    } else {
      return null;
    }
  } else {
    return null;
  }
  const out = [];
  for (const entry of array) {
    const info = parseHerdrPaneInfo(entry);
    if (info) out.push(info);
  }
  return out;
}
function findPaneByTerminalId(panes, terminalId) {
  for (const pane of panes) {
    if (pane.terminal_id === terminalId) return pane;
  }
  return null;
}
function encodeHerdrSurface(kind, workspaceId, terminalId) {
  return `herdr:${kind}:${encodeURIComponent(workspaceId)}:${encodeURIComponent(terminalId)}`;
}
function decodeHerdrSurface(surface) {
  if (!surface.startsWith("herdr:")) return null;
  const parts = surface.split(":");
  if (parts.length !== 4) return null;
  const [, kindRaw, workspaceRaw, terminalRaw] = parts;
  if (kindRaw !== "tab" && kindRaw !== "pane") return null;
  if (!workspaceRaw || !terminalRaw) return null;
  let workspaceId;
  let terminalId;
  try {
    workspaceId = decodeURIComponent(workspaceRaw);
    terminalId = decodeURIComponent(terminalRaw);
  } catch {
    return null;
  }
  if (!workspaceId || !terminalId) return null;
  return { kind: kindRaw, workspaceId, terminalId };
}
function buildHerdrTabCreateArgs(params) {
  const args = [
    "tab",
    "create",
    "--workspace",
    params.workspaceId,
    "--cwd",
    params.cwd,
    "--label",
    params.label
  ];
  if (params.detach) args.push("--no-focus");
  return args;
}
function buildHerdrPaneSplitArgs(params) {
  const direction = params.direction === "left" || params.direction === "right" ? "right" : "down";
  const args = ["pane", "split", params.paneId, "--direction", direction];
  if (params.detach) args.push("--no-focus");
  return args;
}
function buildHerdrSendCommandArgs(paneId, command) {
  return [
    ["pane", "send-text", paneId, command],
    ["pane", "send-keys", paneId, "Enter"]
  ];
}
function isHerdrPaneNotFoundError(error) {
  const record = error;
  return [record?.message, record?.stdout, record?.stderr].filter((value) => typeof value === "string" || Buffer.isBuffer(value)).some((value) => value.toString().includes("pane_not_found"));
}
function isHerdrPaneResolutionRace(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Could not resolve herdr surface to a live pane");
}
function isRetryableHerdrPaneActionError(error) {
  return isHerdrPaneNotFoundError(error) || isHerdrPaneResolutionRace(error);
}
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function runHerdrPaneActionWithRetry(params) {
  const maxAttempts = Math.max(1, params.maxAttempts ?? 5);
  const retryDelayMs = Math.max(0, params.retryDelayMs ?? 100);
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const paneId = params.resolvePaneId();
      params.run(paneId);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableHerdrPaneActionError(error) || attempt === maxAttempts - 1) {
        throw error;
      }
      sleepSync(retryDelayMs);
    }
  }
  throw lastError;
}
function combineHerdrReadOutput(recentUnwrapped, visible) {
  const left = recentUnwrapped.trimEnd();
  const right = visible.trimEnd();
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  return `${left}
${right}`;
}
function runHerdrText(args) {
  return execFileSync3("herdr", args, { encoding: "utf8" });
}
function runHerdrJson(args) {
  const stdout = runHerdrText(args).trim();
  if (!stdout) {
    throw new Error(`herdr ${args.join(" ")} returned empty stdout`);
  }
  const parsed = parseHerdrJson(stdout);
  if (parsed === null) {
    throw new Error(`herdr ${args.join(" ")} returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
  return parsed;
}
function readHerdrPaneListSnapshot() {
  const parsed = runHerdrJson(["pane", "list"]);
  const list = parseHerdrPaneList(parsed);
  if (!list) {
    throw new Error(`herdr pane list returned unexpected shape`);
  }
  return list;
}
function resolveSurfacePane(surface) {
  const decoded = decodeHerdrSurface(surface);
  if (!decoded) {
    throw new Error(`herdr adapter received non-herdr surface: ${surface}`);
  }
  const panes = readHerdrPaneListSnapshot();
  const pane = findPaneByTerminalId(panes, decoded.terminalId);
  if (!pane) {
    throw new Error(
      `Could not resolve herdr surface to a live pane (terminal_id=${decoded.terminalId}; kind=${decoded.kind}; workspace_id=${decoded.workspaceId}). The pane may have been closed externally.`
    );
  }
  return pane;
}
function getParentPaneInfo() {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) {
    throw new Error(
      "HERDR_PANE_ID is not set \u2014 pi must be running inside a herdr pane to create surfaces."
    );
  }
  const parsed = runHerdrJson(["pane", "get", paneId]);
  const info = parseHerdrPaneInfo(parsed) ?? parseHerdrPaneInfo(parsed.result);
  if (!info) {
    throw new Error(
      `herdr pane get ${paneId} returned an unexpected shape: ${JSON.stringify(parsed).slice(0, 200)}`
    );
  }
  return info;
}
async function readHerdrPaneSource(paneId, source, lines) {
  try {
    const { stdout } = await execFileAsync2(
      "herdr",
      ["pane", "read", paneId, "--source", source, "--lines", String(Math.max(1, lines))],
      { encoding: "utf8" }
    );
    return stdout;
  } catch {
    return "";
  }
}
function readHerdrPaneSourceSync(paneId, source, lines) {
  try {
    return execFileSync3(
      "herdr",
      ["pane", "read", paneId, "--source", source, "--lines", String(Math.max(1, lines))],
      { encoding: "utf8" }
    );
  } catch {
    return "";
  }
}
var herdrAdapter = {
  name: "herdr",
  isAvailable() {
    return process.env.HERDR_ENV === "1" && hasCommand("herdr");
  },
  setupHint() {
    return "Start pi inside herdr (`herdr` to launch a session, then run `pi`).";
  },
  createSurface(name, opts) {
    const parent = getParentPaneInfo();
    const args = buildHerdrTabCreateArgs({
      workspaceId: parent.workspace_id,
      cwd: process.cwd(),
      label: name,
      detach: opts?.detach === true
    });
    const parsed = runHerdrJson(args);
    const rootPane = parseHerdrTabCreateResult(parsed);
    if (!rootPane) {
      throw new Error(
        `Unexpected herdr tab create response: ${JSON.stringify(parsed).slice(0, 200)}`
      );
    }
    return encodeHerdrSurface("tab", rootPane.workspace_id, rootPane.terminal_id);
  },
  createSurfaceSplit(name, direction, fromSurface, opts) {
    void name;
    let parentPaneId;
    if (fromSurface) {
      parentPaneId = resolveSurfacePane(fromSurface).pane_id;
    } else {
      parentPaneId = getParentPaneInfo().pane_id;
    }
    const args = buildHerdrPaneSplitArgs({
      paneId: parentPaneId,
      direction,
      detach: opts?.detach === true
    });
    const parsed = runHerdrJson(args);
    const pane = parseHerdrPaneSplitResult(parsed);
    if (!pane) {
      throw new Error(
        `Unexpected herdr pane split response: ${JSON.stringify(parsed).slice(0, 200)}`
      );
    }
    return encodeHerdrSurface("pane", pane.workspace_id, pane.terminal_id);
  },
  closeSurface(surface) {
    const decoded = decodeHerdrSurface(surface);
    if (!decoded) {
      throw new Error(`herdr adapter received non-herdr surface in closeSurface: ${surface}`);
    }
    const panes = readHerdrPaneListSnapshot();
    const pane = findPaneByTerminalId(panes, decoded.terminalId);
    if (!pane) {
      return;
    }
    if (decoded.kind === "tab") {
      execFileSync3("herdr", ["tab", "close", pane.tab_id], { encoding: "utf8" });
    } else {
      execFileSync3("herdr", ["pane", "close", pane.pane_id], { encoding: "utf8" });
    }
  },
  sendCommand(surface, command) {
    runHerdrPaneActionWithRetry({
      resolvePaneId: () => resolveSurfacePane(surface).pane_id,
      run: (paneId) => {
        execFileSync3("herdr", buildHerdrSendCommandArgs(paneId, command)[0], { encoding: "utf8" });
      }
    });
    runHerdrPaneActionWithRetry({
      resolvePaneId: () => resolveSurfacePane(surface).pane_id,
      run: (paneId) => {
        execFileSync3("herdr", buildHerdrSendCommandArgs(paneId, command)[1], { encoding: "utf8" });
      }
    });
  },
  sendEscape(surface) {
    const pane = resolveSurfacePane(surface);
    execFileSync3("herdr", ["pane", "send-keys", pane.pane_id, "Esc"], { encoding: "utf8" });
  },
  readScreen(surface, lines = 50) {
    const pane = resolveSurfacePane(surface);
    const recent = readHerdrPaneSourceSync(pane.pane_id, "recent-unwrapped", lines);
    const visible = readHerdrPaneSourceSync(pane.pane_id, "visible", lines);
    return combineHerdrReadOutput(recent, visible);
  },
  async readScreenAsync(surface, lines = 50) {
    const pane = resolveSurfacePane(surface);
    const [recent, visible] = await Promise.all([
      readHerdrPaneSource(pane.pane_id, "recent-unwrapped", lines),
      readHerdrPaneSource(pane.pane_id, "visible", lines)
    ]);
    return combineHerdrReadOutput(recent, visible);
  },
  renameCurrentTab(title) {
    try {
      const parent = getParentPaneInfo();
      execFileSync3("herdr", ["tab", "rename", parent.tab_id, title], { encoding: "utf8" });
    } catch {
    }
  },
  renameWorkspace(title) {
    try {
      const parent = getParentPaneInfo();
      execFileSync3("herdr", ["workspace", "rename", parent.workspace_id, title], {
        encoding: "utf8"
      });
    } catch {
    }
  }
};

// src/mux/adapters/tmux.ts
import { execFile as execFile3, execFileSync as execFileSync4 } from "node:child_process";
import { promisify as promisify3 } from "node:util";
var execFileAsync3 = promisify3(execFile3);
function buildTmuxSplitArgs(direction, fromSurface, opts) {
  const args = ["split-window"];
  if (opts?.detach) args.push("-d");
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");
  return args;
}
function shouldSetTmuxPaneTitle(opts) {
  return !opts?.detach;
}
var tmuxAdapter = {
  name: "tmux",
  isAvailable() {
    return !!process.env.TMUX && hasCommand("tmux");
  },
  setupHint() {
    return "Start pi inside tmux (`tmux new -A -s pi 'pi'`).";
  },
  createSurface(name, opts) {
    return this.createSurfaceSplit(name, "right", process.env.TMUX_PANE, opts);
  },
  createSurfaceSplit(name, direction, fromSurface, opts) {
    const args = buildTmuxSplitArgs(direction, fromSurface, opts);
    const pane = execFileSync4("tmux", args, { encoding: "utf8" }).trim();
    if (!pane.startsWith("%")) {
      throw new Error(`Unexpected tmux split-window output: ${pane}`);
    }
    if (shouldSetTmuxPaneTitle(opts)) {
      try {
        execFileSync4("tmux", ["select-pane", "-t", pane, "-T", name], { encoding: "utf8" });
      } catch {
      }
    }
    return pane;
  },
  closeSurface(surface) {
    execFileSync4("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  },
  sendCommand(surface, command) {
    execFileSync4("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
    execFileSync4("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
  },
  sendEscape(surface) {
    execFileSync4("tmux", ["send-keys", "-t", surface, "Escape"], { encoding: "utf8" });
  },
  readScreen(surface, lines = 50) {
    return execFileSync4(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      {
        encoding: "utf8"
      }
    );
  },
  async readScreenAsync(surface, lines = 50) {
    const { stdout } = await execFileAsync3(
      "tmux",
      ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
      { encoding: "utf8" }
    );
    return stdout;
  },
  renameCurrentTab(title) {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_WINDOW !== "1") {
      return;
    }
    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const windowId = execFileSync4("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"], {
      encoding: "utf8"
    }).trim();
    execFileSync4("tmux", ["rename-window", "-t", windowId, title], { encoding: "utf8" });
  },
  renameWorkspace(title) {
    if (process.env.PI_SUBAGENT_RENAME_TMUX_SESSION !== "1") {
      return;
    }
    const paneId = process.env.TMUX_PANE;
    if (!paneId) throw new Error("TMUX_PANE not set");
    const sessionId = execFileSync4(
      "tmux",
      ["display-message", "-p", "-t", paneId, "#{session_id}"],
      {
        encoding: "utf8"
      }
    ).trim();
    execFileSync4("tmux", ["rename-session", "-t", sessionId, title], { encoding: "utf8" });
  }
};

// src/mux/adapters/zellij.ts
import { execFile as execFile4, execFileSync as execFileSync5 } from "node:child_process";
import { promisify as promisify4 } from "node:util";
import { mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
var execFileAsync4 = promisify4(execFile4);
var ZELLIJ_PANE_SCOPED_ACTIONS = /* @__PURE__ */ new Set([
  "close-pane",
  "dump-screen",
  "rename-pane",
  "move-pane",
  "write",
  "write-chars",
  "send-keys"
]);
function zellijPaneId(surface) {
  return surface.startsWith("pane:") ? surface.slice("pane:".length) : surface;
}
function zellijEnv(surface) {
  const env = { ...process.env };
  if (surface) {
    env.ZELLIJ_PANE_ID = zellijPaneId(surface);
  }
  return env;
}
function zellijActionArgs(args, surface) {
  if (!surface) return ["action", ...args];
  const action = args[0];
  if (!ZELLIJ_PANE_SCOPED_ACTIONS.has(action)) return ["action", ...args];
  if (args.includes("--pane-id") || args.includes("-p")) return ["action", ...args];
  return ["action", action, "--pane-id", zellijPaneId(surface), ...args.slice(1)];
}
function zellijActionSync(args, surface) {
  return execFileSync5("zellij", zellijActionArgs(args, surface), {
    encoding: "utf8",
    env: zellijEnv(surface)
  });
}
var ZELLIJ_MIN_TERMINAL_WIDTH = 5;
var ZELLIJ_MIN_TERMINAL_HEIGHT = 5;
var ZELLIJ_CURSOR_HEIGHT_WIDTH_RATIO = 4;
var DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS = 50;
var DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS = 10;
function paneArea(pane) {
  return (pane.pane_rows ?? 0) * (pane.pane_columns ?? 0);
}
function isUsableZellijTiledPane(pane) {
  return !pane.is_plugin && !pane.is_floating && pane.is_selectable !== false && !pane.exited && typeof pane.pane_rows === "number" && typeof pane.pane_columns === "number";
}
function predictZellijSplitDirection(pane) {
  const columns = pane.pane_columns ?? 0;
  const rows = pane.pane_rows ?? 0;
  if (columns < ZELLIJ_MIN_TERMINAL_WIDTH || rows < ZELLIJ_MIN_TERMINAL_HEIGHT) return null;
  if (rows * ZELLIJ_CURSOR_HEIGHT_WIDTH_RATIO > columns && rows > ZELLIJ_MIN_TERMINAL_HEIGHT * 2) {
    return "down";
  }
  if (columns > ZELLIJ_MIN_TERMINAL_WIDTH * 2) {
    return "right";
  }
  return null;
}
function canSplitZellijPane(pane, minColumns = ZELLIJ_MIN_TERMINAL_WIDTH, minRows = ZELLIJ_MIN_TERMINAL_HEIGHT) {
  const columns = pane.pane_columns ?? 0;
  const rows = pane.pane_rows ?? 0;
  const direction = predictZellijSplitDirection(pane);
  if (!direction) return false;
  if (direction === "down") {
    return columns >= minColumns && Math.floor(rows / 2) >= minRows;
  }
  return rows >= minRows && Math.floor(columns / 2) >= minColumns;
}
function zellijTabPanesForParent(panes, parentPaneId) {
  const parentPane = panes.find((pane) => !pane.is_plugin && pane.id === parentPaneId);
  if (!parentPane || typeof parentPane.tab_id !== "number") return null;
  const tabPanes = panes.filter((pane) => pane.tab_id === parentPane.tab_id).filter(isUsableZellijTiledPane);
  return { parentPane, tabPanes };
}
function selectZellijStackPlacement(panes, parentPaneId) {
  const tabInfo = zellijTabPanesForParent(panes, parentPaneId);
  if (!tabInfo) return null;
  const stackTarget = tabInfo.tabPanes.filter((pane) => pane.id !== parentPaneId).sort((a, b) => paneArea(b) - paneArea(a))[0];
  if (!stackTarget) return null;
  return {
    mode: "stack",
    anchorPaneId: stackTarget.id,
    targetPaneId: stackTarget.id,
    tabId: tabInfo.parentPane.tab_id
  };
}
function selectZellijPlacement(panes, parentPaneId, minColumns = DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS, minRows = DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS) {
  const tabInfo = zellijTabPanesForParent(panes, parentPaneId);
  if (!tabInfo) return null;
  const zellijSplitCandidates = tabInfo.tabPanes.map((pane) => ({ pane, splitDirection: predictZellijSplitDirection(pane) })).filter(
    (candidate) => candidate.splitDirection !== null && canSplitZellijPane(candidate.pane, ZELLIJ_MIN_TERMINAL_WIDTH, ZELLIJ_MIN_TERMINAL_HEIGHT)
  );
  const safeSplitCandidates = zellijSplitCandidates.filter(
    (candidate) => canSplitZellijPane(candidate.pane, minColumns, minRows)
  );
  if (zellijSplitCandidates.length > 0 && safeSplitCandidates.length === zellijSplitCandidates.length) {
    const splitTarget = safeSplitCandidates.sort((a, b) => paneArea(b.pane) - paneArea(a.pane))[0];
    return {
      mode: "split",
      anchorPaneId: splitTarget.pane.id,
      targetPaneId: splitTarget.pane.id,
      tabId: tabInfo.parentPane.tab_id,
      splitDirection: splitTarget.splitDirection
    };
  }
  return selectZellijStackPlacement(panes, parentPaneId);
}
function parseZellijPaneSurface(rawId, context) {
  const idMatch = rawId.match(/(\d+)/);
  if (!idMatch) {
    throw new Error(`Unexpected zellij pane id from ${context}: ${rawId || "(empty)"}`);
  }
  return `pane:${idMatch[1]}`;
}
function readZellijPanes() {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const output = zellijActionSync(["list-panes", "--json", "--geometry", "--state", "--tab"]);
      if (!output.trim()) {
        throw new Error("Unexpected zellij list-panes output: empty");
      }
      const parsed = JSON.parse(output);
      if (!Array.isArray(parsed)) {
        throw new Error("Unexpected zellij list-panes output: not an array");
      }
      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt < 2) sleepSync2(50);
    }
  }
  throw lastError;
}
function createZellijTiledPane(name, tabId) {
  const args = ["new-pane", "--tab-id", String(tabId), "--name", name, "--cwd", process.cwd()];
  return parseZellijPaneSurface(zellijActionSync(args).trim(), "new-pane");
}
function createZellijStackedPane(name, anchorSurface) {
  const args = [
    "new-pane",
    "--stacked",
    "--near-current-pane",
    "--name",
    name,
    "--cwd",
    process.cwd()
  ];
  return parseZellijPaneSurface(zellijActionSync(args, anchorSurface).trim(), "new-pane --stacked");
}
function createZellijTab(name) {
  const tabIdRaw = zellijActionSync(["new-tab", "--name", name, "--cwd", process.cwd()]).trim();
  const tabId = Number(tabIdRaw);
  if (!Number.isInteger(tabId)) {
    throw new Error(`Unexpected zellij tab id from new-tab: ${tabIdRaw || "(empty)"}`);
  }
  try {
    const panes = readZellijPanes();
    const pane = panes.find(
      (candidate) => candidate.tab_id === tabId && isUsableZellijTiledPane(candidate) && typeof candidate.id === "number"
    );
    if (!pane) {
      throw new Error(`Could not find initial pane for zellij tab ${tabId}`);
    }
    const surface = `pane:${pane.id}`;
    try {
      zellijActionSync(["rename-pane", name], surface);
    } catch {
    }
    return surface;
  } catch (error) {
    try {
      zellijActionSync(["close-tab", "--tab-id", String(tabId)]);
    } catch {
    }
    throw error;
  }
}
function envPositiveInteger(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
function sleepSync2(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
function zellijSurfaceLockPath() {
  const session = (process.env.ZELLIJ_SESSION_NAME ?? process.env.ZELLIJ ?? "default").replace(
    /[^A-Za-z0-9_.-]/g,
    "_"
  );
  return join(tmpdir(), `pi-zellij-surface-${session}.lock`);
}
function withZellijSurfaceLock(callback) {
  const lockPath = zellijSurfaceLockPath();
  const deadline = Date.now() + 1e4;
  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner"), `${process.pid}
`);
      break;
    } catch (error) {
      const code = error.code;
      if (code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 3e4) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for zellij surface lock: ${lockPath}`, {
          cause: error
        });
      }
      sleepSync2(50);
    }
  }
  try {
    return callback();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}
function createZellijSurfaceUnlocked(name) {
  const parentPaneIdRaw = process.env.ZELLIJ_PANE_ID;
  const parentPaneId = parentPaneIdRaw ? Number(parentPaneIdRaw) : NaN;
  const minColumns = envPositiveInteger(
    "PI_SUBAGENT_ZELLIJ_MIN_COLUMNS",
    DEFAULT_ZELLIJ_SUBAGENT_MIN_COLUMNS
  );
  const minRows = envPositiveInteger(
    "PI_SUBAGENT_ZELLIJ_MIN_ROWS",
    DEFAULT_ZELLIJ_SUBAGENT_MIN_ROWS
  );
  const plan = Number.isInteger(parentPaneId) ? selectZellijPlacement(readZellijPanes(), parentPaneId, minColumns, minRows) : null;
  if (plan?.mode === "split") {
    return createZellijTiledPane(name, plan.tabId);
  }
  if (plan?.mode === "stack") {
    return createZellijStackedPane(name, `pane:${plan.targetPaneId}`);
  }
  return createZellijTab(name);
}
function createZellijSurface(name) {
  return withZellijSurfaceLock(() => createZellijSurfaceUnlocked(name));
}
var zellijAdapter = {
  name: "zellij",
  isAvailable() {
    return !!(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) && hasCommand("zellij");
  },
  setupHint() {
    return "Start pi inside zellij (`zellij --session pi`, then run `pi`).";
  },
  createSurface(name, _opts) {
    void _opts;
    return createZellijSurface(name);
  },
  createSurfaceSplit(name, direction, fromSurface, _opts) {
    void _opts;
    const directionArg = direction === "left" || direction === "right" ? "right" : "down";
    const args = ["new-pane", "--direction", directionArg, "--name", name, "--cwd", process.cwd()];
    let rawId;
    try {
      rawId = zellijActionSync(args, fromSurface).trim();
    } catch {
      if (!fromSurface) throw new Error("Failed to create zellij pane");
      rawId = zellijActionSync(args).trim();
    }
    const surface = parseZellijPaneSurface(rawId, "new-pane");
    if (direction === "left" || direction === "up") {
      try {
        zellijActionSync(["move-pane", direction], surface);
      } catch {
      }
    }
    try {
      zellijActionSync(["rename-pane", name], surface);
    } catch {
    }
    return surface;
  },
  closeSurface(surface) {
    zellijActionSync(["close-pane"], surface);
  },
  sendCommand(surface, command) {
    zellijActionSync(["write-chars", command], surface);
    zellijActionSync(["write", "13"], surface);
  },
  sendEscape(surface) {
    zellijActionSync(["write", "27"], surface);
  },
  readScreen(surface, lines = 50) {
    const paneId = zellijPaneId(surface);
    const raw = execFileSync5(
      "zellij",
      ["action", "dump-screen", "--pane-id", paneId],
      { encoding: "utf8" }
    );
    return tailLines(raw, lines);
  },
  async readScreenAsync(surface, lines = 50) {
    const paneId = zellijPaneId(surface);
    const { stdout } = await execFileAsync4(
      "zellij",
      ["action", "dump-screen", "--pane-id", paneId],
      { encoding: "utf8" }
    );
    return tailLines(stdout, lines);
  },
  renameCurrentTab(title) {
    const paneId = process.env.ZELLIJ_PANE_ID;
    if (paneId) {
      zellijActionSync(["rename-pane", title], `pane:${paneId}`);
    } else {
      zellijActionSync(["rename-pane", title]);
    }
  },
  renameWorkspace(title) {
    void title;
  }
};

// src/mux/adapters/wezterm.ts
import { execFile as execFile5, execFileSync as execFileSync6 } from "node:child_process";
import { promisify as promisify5 } from "node:util";
var execFileAsync5 = promisify5(execFile5);
var weztermAdapter = {
  name: "wezterm",
  isAvailable() {
    return !!process.env.WEZTERM_UNIX_SOCKET && hasCommand("wezterm");
  },
  setupHint() {
    return "Start pi inside WezTerm.";
  },
  createSurface(name, opts) {
    return this.createSurfaceSplit(name, "right", void 0, opts);
  },
  createSurfaceSplit(name, direction, fromSurface, opts) {
    const args = ["cli", "split-pane"];
    if (direction === "left") args.push("--left");
    else if (direction === "right") args.push("--right");
    else if (direction === "up") args.push("--top");
    else args.push("--bottom");
    args.push("--cwd", process.cwd());
    if (fromSurface) {
      args.push("--pane-id", fromSurface);
    }
    const paneId = execFileSync6("wezterm", args, { encoding: "utf8" }).trim();
    if (!paneId || !/^\d+$/.test(paneId)) {
      throw new Error(`Unexpected wezterm split-pane output: ${paneId || "(empty)"}`);
    }
    try {
      execFileSync6("wezterm", ["cli", "set-tab-title", "--pane-id", paneId, name], {
        encoding: "utf8"
      });
    } catch {
    }
    void opts;
    return paneId;
  },
  closeSurface(surface) {
    execFileSync6("wezterm", ["cli", "kill-pane", "--pane-id", surface], {
      encoding: "utf8"
    });
  },
  sendCommand(surface, command) {
    execFileSync6("wezterm", ["cli", "send-text", "--pane-id", surface, "--no-paste", command + "\n"], {
      encoding: "utf8"
    });
  },
  sendEscape(surface) {
    execFileSync6("wezterm", ["cli", "send-text", "--pane-id", surface, "--no-paste", "\x1B"], { encoding: "utf8" });
  },
  readScreen(surface, lines = 50) {
    const raw = execFileSync6(
      "wezterm",
      ["cli", "get-text", "--pane-id", surface],
      { encoding: "utf8" }
    );
    return tailLines(raw, lines);
  },
  async readScreenAsync(surface, lines = 50) {
    const { stdout } = await execFileAsync5(
      "wezterm",
      ["cli", "get-text", "--pane-id", surface],
      { encoding: "utf8" }
    );
    return tailLines(stdout, lines);
  },
  renameCurrentTab(title) {
    const paneId = process.env.WEZTERM_PANE;
    const args = ["cli", "set-tab-title"];
    if (paneId) args.push("--pane-id", paneId);
    args.push(title);
    execFileSync6("wezterm", args, { encoding: "utf8" });
  },
  renameWorkspace(title) {
    const paneId = process.env.WEZTERM_PANE;
    const args = ["cli", "set-window-title"];
    if (paneId) args.push("--pane-id", paneId);
    args.push(title);
    try {
      execFileSync6("wezterm", args, { encoding: "utf8" });
    } catch {
    }
  }
};

// src/mux/adapters/termio.ts
import { execFile as execFile6, execFileSync as execFileSync7 } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
import { promisify as promisify6 } from "node:util";
var execFileAsync6 = promisify6(execFile6);
var DEFAULT_SPLIT_RATIO = "0.35";
var cachedCliPath;
function resolveTermioCliPath() {
  if (cachedCliPath !== void 0) return cachedCliPath;
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
    join2(homedir(), "Applications/termio.app/Contents/Resources/termio")
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
function mapTermioDirection(direction) {
  return direction === "left" || direction === "right" ? "right" : "down";
}
function termioSplitRatio() {
  const raw = process.env.PI_SUBAGENT_TERMIO_RATIO?.trim();
  if (!raw) return DEFAULT_SPLIT_RATIO;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? String(parsed) : DEFAULT_SPLIT_RATIO;
}
function buildTermioRunArgs(params) {
  return [
    "sessions",
    "run",
    params.command,
    "--direction",
    mapTermioDirection(params.direction),
    "--ratio",
    params.ratio ?? termioSplitRatio(),
    "--json"
  ];
}
function formatTermioCliError(error, args) {
  const stderr = error?.stderr;
  const detail = typeof stderr === "string" ? stderr : stderr?.toString("utf8");
  const fallback = error instanceof Error ? error.message : String(error);
  return new Error(`termio ${args.join(" ")} failed: ${(detail ?? fallback).trim()}`);
}
function requireTermioCli() {
  const cli = resolveTermioCliPath();
  if (!cli) throw new Error(`termio CLI not found. ${termioAdapter.setupHint()}`);
  return cli;
}
function runTermio(args) {
  const cli = requireTermioCli();
  try {
    return execFileSync7(cli, args, { encoding: "utf8" });
  } catch (error) {
    throw formatTermioCliError(error, args);
  }
}
function runTermioJson(args) {
  const stdout = runTermio(args).trim();
  if (!stdout) throw new Error(`termio ${args.join(" ")} returned empty stdout`);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`termio ${args.join(" ")} returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`termio ${args.join(" ")} returned unexpected JSON: ${stdout.slice(0, 200)}`);
  }
  return parsed;
}
var termioAdapter = {
  name: "termio",
  /**
   * TERM_PROGRAM 是 termio 终端自身的标记（与 otty/orca 后端的判定方式一致），
   * TERMIOD_SESSION_ID 是「确实挂在一个 termio 会话上」的兜底证据 ——
   * 没有它，分屏就没有可锚定的调用方 pane。
   */
  isAvailable() {
    const insideTermio = process.env.TERM_PROGRAM === "termio" || !!process.env.TERMIOD_SESSION_ID;
    return insideTermio && resolveTermioCliPath() !== null;
  },
  setupHint() {
    return "Start pi inside termio (open a termio session, then run `pi`), or point TERMIO_CLI at the termio CLI.";
  },
  createSurface(name, opts) {
    return this.createSurfaceSplit(name, "right", void 0, opts);
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
  createSurfaceSplit(_name, direction, _fromSurface, _opts) {
    const shell = process.env.SHELL?.trim() || "/bin/sh";
    const args = buildTermioRunArgs({ command: `exec ${shellEscape(shell)} -l`, direction });
    const payload = runTermioJson(args);
    const target = payload.target;
    if (typeof target !== "string" || !target.startsWith("termio://session/")) {
      throw new Error(`Unexpected termio run output: ${JSON.stringify(payload).slice(0, 200)}`);
    }
    return target;
  },
  closeSurface(surface) {
    runTermio(["sessions", "close", surface]);
  },
  sendCommand(surface, command) {
    runTermio(["sessions", "send", surface, command]);
  },
  /**
   * termio 只接受命名按键，由终端自己的按键编码器生成字节。
   * 手动写 ESC 字节在应用模式下会错位，所以必须走 `--key escape`。
   */
  sendEscape(surface) {
    runTermio(["sessions", "send", surface, "--key", "escape"]);
  },
  readScreen(surface, lines = 50) {
    return runTermio(["sessions", "read", surface, "--lines", String(Math.max(1, lines))]);
  },
  async readScreenAsync(surface, lines = 50) {
    const cli = requireTermioCli();
    const args = ["sessions", "read", surface, "--lines", String(Math.max(1, lines))];
    try {
      const { stdout } = await execFileAsync6(cli, args, { encoding: "utf8" });
      return stdout;
    } catch (error) {
      throw formatTermioCliError(error, args);
    }
  },
  /** termio CLI 没有改名接口（标题由 termio 按 agent 与项目自生成），保持 no-op。 */
  renameCurrentTab(_title) {
  },
  renameWorkspace(_title) {
  }
};

// src/mux/index.ts
var ADAPTERS = [
  herdrAdapter,
  cmuxAdapter,
  tmuxAdapter,
  zellijAdapter,
  weztermAdapter,
  termioAdapter
];
function parseMuxPreference(raw) {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed) return { preference: null, invalidRaw: null };
  if (trimmed === "cmux" || trimmed === "tmux" || trimmed === "zellij" || trimmed === "wezterm" || trimmed === "herdr" || trimmed === "termio") {
    return { preference: trimmed, invalidRaw: null };
  }
  return { preference: null, invalidRaw: trimmed };
}
function muxPreference() {
  return parseMuxPreference(process.env.PI_SUBAGENT_MUX).preference;
}
function getMuxBackend() {
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
function detectMux() {
  return getMuxBackend() !== null;
}

// src/diagnostics/diagnostics.ts
var ambientUiResolver = () => null;
function emitDiagnostic(diagnostic, context) {
  if (diagnostic.audience.human) {
    const ui = ambientUiResolver();
    if (ui?.hasUI) ui.ui.notify(diagnostic.message.replace(/\n+$/, ""), "warning");
    else process.stderr.write(diagnostic.message);
  }
  if (diagnostic.audience.structured) {
    context?.collector?.push(diagnostic);
  }
}

// src/backends/select.ts
var warnedInvalidValues = /* @__PURE__ */ new Set();
var detectMuxImpl = detectMux;
function selectBackend() {
  const raw = (process.env.PI_SUBAGENT_MODE ?? "auto").toLowerCase();
  if (raw === "pane") return "pane";
  if (raw === "headless") return "headless";
  if (raw !== "auto" && !warnedInvalidValues.has(raw)) {
    warnedInvalidValues.add(raw);
    emitDiagnostic({
      code: "invalid-subagent-mode",
      audience: { human: true },
      message: `[subagents] invalid PI_SUBAGENT_MODE="${raw}"; using auto (valid: pane | headless | auto)
`
    });
  }
  return detectMuxImpl() ? "pane" : "headless";
}

// src/bin/pi-mux-detect.ts
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join as join3, dirname } from "node:path";
function buildDetectionPayload({
  env,
  getMuxBackend: getMuxBackend2,
  selectBackend: selectBackend2
}) {
  const rawMode = (env.PI_SUBAGENT_MODE ?? "").trim().toLowerCase();
  const modeForced = rawMode === "pane" ? "pane" : rawMode === "headless" ? "headless" : null;
  const { preference: muxPreference2, invalidRaw: muxPreferenceInvalid } = parseMuxPreference(env.PI_SUBAGENT_MUX);
  const backend = selectBackend2();
  const mux = backend === "headless" ? null : getMuxBackend2();
  let reason;
  if (modeForced === "headless") {
    reason = "PI_SUBAGENT_MODE=headless forced headless backend";
  } else if (modeForced === "pane") {
    if (mux) {
      if (muxPreference2) {
        reason = `PI_SUBAGENT_MODE=pane forced pane backend; mux=${mux} selected via PI_SUBAGENT_MUX`;
      } else {
        reason = `PI_SUBAGENT_MODE=pane forced pane backend; mux=${mux} from detection order [herdr,cmux,tmux,zellij,wezterm,termio]`;
      }
    } else {
      reason = "PI_SUBAGENT_MODE=pane forced pane backend; no mux available";
    }
  } else {
    if (backend === "pane" && mux) {
      if (muxPreference2) {
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
    muxPreference: muxPreference2,
    muxPreferenceInvalid,
    reason
  };
}
function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "Usage: pi-mux-detect [--help|-h] [--version]\n  (no args) \u2014 detect mux backend and print JSON payload to stdout\n"
    );
    process.exit(0);
  }
  if (args.includes("--version")) {
    const pkgPath = join3(dirname(fileURLToPath(import.meta.url)), "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    process.stdout.write(pkg.version + "\n");
    process.exit(0);
  }
  if (args.length > 0) {
    process.stderr.write(`Unknown argument: ${args[0]}
Usage: pi-mux-detect [--help|-h] [--version]
`);
    process.exit(2);
  }
  try {
    const payload = buildDetectionPayload({
      env: process.env,
      getMuxBackend,
      selectBackend
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
export {
  buildDetectionPayload
};

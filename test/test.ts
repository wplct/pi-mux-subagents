import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as subagentsModule from "../src/index.ts";

import {
  getLeafId,
  getEntryCount,
  getNewEntries,
  findLastAssistantMessage,
  appendBranchSummary,
  copySessionFile,
  mergeNewEntries,
  seedSubagentSessionFile,
} from "../src/launch/session.ts";

import { shellEscape } from "../src/mux/shell.ts";
import {
  isCmuxAvailable,
  isWezTermAvailable,
  isHerdrAvailable,
  isTermioAvailable,
  muxSetupHint,
  getMuxBackend,
} from "../src/mux/index.ts";
import {
  parseHerdrJson,
  parseHerdrPaneInfo,
  parseHerdrTabCreateResult,
  parseHerdrPaneSplitResult,
  parseHerdrPaneList,
  findPaneByTerminalId,
  encodeHerdrSurface,
  decodeHerdrSurface,
  buildHerdrTabCreateArgs,
  buildHerdrPaneSplitArgs,
  buildHerdrSendCommandArgs,
  isHerdrPaneNotFoundError,
  runHerdrPaneActionWithRetry,
  combineHerdrReadOutput,
  herdrAdapter,
} from "../src/mux/adapters/herdr.ts";
import {
  parseCmuxFocusedSnapshot,
  parseCmuxFocusedSnapshotFromJson,
  parseCmuxJson,
  parseCmuxPaneRefForSurface,
  parseCmuxPaneRefForSurfaceFromJson,
  isCmuxForegroundAppIdentity,
  shouldRestoreCmuxFocusAfterLaunch,
} from "../src/mux/adapters/cmux.ts";
import {
  buildTmuxSplitArgs,
  shouldSetTmuxPaneTitle,
} from "../src/mux/adapters/tmux.ts";
import {
  canSplitZellijPane,
  predictZellijSplitDirection,
  selectZellijPlacement,
  selectZellijStackPlacement,
} from "../src/mux/adapters/zellij.ts";
import {
  __test__ as termioTest,
  buildTermioRunArgs,
  mapTermioDirection,
  resolveTermioCliPath,
  termioAdapter,
  termioSplitRatio,
} from "../src/mux/adapters/termio.ts";
import {
  shouldMarkUserTookOver,
  shouldAutoExitOnAgentEnd,
  writeAutoExitDoneSidecar,
} from "../src/tools/subagent-done.ts";
import { pollForExit } from "../src/mux/index.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  return {
    registeredTools,
    registeredCommands,
    api: {
      on() {},
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer() {},
      registerShortcut() {},
      getAllTools() {
        return [];
      },
    } as any,
  };
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe("package integration scripts", () => {
  it("runs integration test files serially to avoid shared mux and LLM contention", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.match(pkg.scripts["test:integration"], /--test-concurrency=1/);
    assert.match(pkg.scripts["test:integration:slow"], /--test-concurrency=1/);
  });
});

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousDeniedTools = process.env.PI_DENY_TOOLS;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;
  delete process.env.PI_DENY_TOOLS;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    restoreEnvVar("PI_DENY_TOOLS", previousDeniedTools);
    rmSync(root, { recursive: true, force: true });
  }
}

const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getEntryCount", () => {
    it("counts non-empty lines", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG]);
      assert.equal(getEntryCount(file), 3);
    });

    it("returns 0 for empty file", () => {
      const file = join(dir, "empty2.jsonl");
      writeFileSync(file, "\n\n");
      assert.equal(getEntryCount(file), 0);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(
        sourceFile,
        [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      writeFileSync(
        targetFile,
        [SESSION_HEADER, USER_MSG].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });
});

describe("seedSubagentSessionFile", () => {
  let dir: string;
  before(() => {
    dir = createTestDir();
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a lineage-only child session with parent linkage and no copied turns", () => {
    const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
    const childFile = join(dir, "lineage-child.jsonl");

    seedSubagentSessionFile({
      mode: "lineage-only",
      parentSessionFile: parentFile,
      childSessionFile: childFile,
      childCwd: "/tmp/child-cwd",
    });

    const lines = readFileSync(childFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);

    const header = JSON.parse(lines[0]);
    assert.equal(header.type, "session");
    assert.equal(header.parentSession, parentFile);
    assert.equal(header.cwd, "/tmp/child-cwd");
  });

  it("creates a forked child session with copied context before the triggering user turn", () => {
    const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
    const childFile = join(dir, "fork-child.jsonl");

    seedSubagentSessionFile({
      mode: "fork",
      parentSessionFile: parentFile,
      childSessionFile: childFile,
      childCwd: "/tmp/fork-child-cwd",
    });

    const entries = readFileSync(childFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(entries.length, 2);
    assert.equal(entries[0].type, "session");
    assert.equal(entries[0].parentSession, parentFile);
    assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
    assert.equal(entries[1].type, "model_change");
    assert.equal(entries.some((entry) => entry.type === "message"), false);
  });
});

describe("subagent discovery", () => {
  const testApi = (subagentsModule as any).__test__;

  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "lineage-mode-test-agent",
        [
          "name: lineage-mode-test-agent",
          "model: anthropic/test-lineage",
          "session-mode: lineage-only",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "invalid-mode-test-agent",
        [
          "name: invalid-mode-test-agent",
          "model: anthropic/test-invalid",
          "session-mode: sideways",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("resolves session mode with fork override precedence", () => {
    assert.equal(testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null), "standalone");
    assert.equal(
      testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      "lineage-only",
    );
    assert.equal(
      testApi.resolveEffectiveSessionMode(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      "fork",
    );
  });

  it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
    assert.deepEqual(testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null), {
      sessionMode: "standalone",
      seededSessionMode: null,
      inheritsConversationContext: false,
      taskDelivery: "artifact",
    });
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      {
        sessionMode: "lineage-only",
        seededSessionMode: "lineage-only",
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "fork" }),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
  });

  it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review,lint", taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["", "/skill:review", "/skill:lint", "@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: undefined, taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for direct launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review", taskDelivery: "direct", taskArg: "do the task" }),
      ["/skill:review", "do the task"],
    );
  });

  it("lists visible agents from discovery", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "visible-discovery-test-agent",
        [
          "name: visible-discovery-test-agent",
          "description: Visible test agent",
          "model: anthropic/test-visible",
        ].join("\n"),
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((t) => t.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.ok(agents.some((agent: any) => agent.name === "visible-discovery-test-agent"));
      assert.match(result.content[0].text, /visible-discovery-test-agent/);
    });
  });

  it("hides disable-model-invocation agents from listings but keeps direct loading", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(
        projectAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "model: anthropic/test-hidden",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((t) => t.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "hidden-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /hidden-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-hidden");
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("lets a hidden project agent shadow a visible global agent", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir, globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Global visible agent",
          "model: anthropic/test-global",
        ].join("\n"),
        "You are the global visible agent.",
      );
      writeAgentFile(
        projectAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Project hidden agent",
          "model: anthropic/test-project",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the project hidden agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const tool = registeredTools.find((t) => t.name === "subagents_list");
      assert.ok(tool, "expected subagents_list to be registered");

      const result = await tool.execute();
      const agents = result.details?.agents ?? [];

      assert.equal(agents.some((agent: any) => agent.name === "shadowed-discovery-test-agent"), false);
      assert.doesNotMatch(result.content[0].text, /shadowed-discovery-test-agent/);

      const loaded = testApi.loadAgentDefaults("shadowed-discovery-test-agent");
      assert.ok(loaded, "expected project override to remain directly loadable");
      assert.equal(loaded.model, "anthropic/test-project");
      assert.equal(loaded.body, "You are the project hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });
});

describe("subagent-done.ts", () => {
  describe("shouldMarkUserTookOver", () => {
    it("ignores the initial injected task before the first agent run", () => {
      assert.equal(shouldMarkUserTookOver(false), false);
    });

    it("treats later input as manual takeover", () => {
      assert.equal(shouldMarkUserTookOver(true), true);
    });
  });

  describe("shouldAutoExitOnAgentEnd", () => {
    it("auto-exits after normal completion when there was no takeover", () => {
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messages), true);
    });

    it("auto-exits after normal completion even when the user sent the prompt", () => {
      // Upstream commit 2105cf4 (PR #42): a user-driven follow-up that runs
      // to a normal stop must still trigger auto-exit. The previous behavior
      // stranded the pane open after manual takeover.
      const messages = [{ role: "assistant", stopReason: "stop" }];
      assert.equal(shouldAutoExitOnAgentEnd(true, messages), true);
    });

    it("stays open after Escape aborts the run", () => {
      // Abort still leaves the session inspectable / follow-up-able regardless
      // of who started the turn — preserved across the upstream port.
      const messagesNoTakeover = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(false, messagesNoTakeover), false);
      const messagesWithTakeover = [{ role: "assistant", stopReason: "aborted" }];
      assert.equal(shouldAutoExitOnAgentEnd(true, messagesWithTakeover), false);
    });
  });

  describe("writeAutoExitDoneSidecar", () => {
    it("writes a durable done sidecar when no .exit file exists", () => {
      const dir = createTestDir();
      try {
        const sessionFile = join(dir, "session.jsonl");
        writeAutoExitDoneSidecar(sessionFile);
        const written = JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8"));
        assert.deepEqual(written, { type: "done" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not overwrite an existing ping sidecar from caller_ping", () => {
      const dir = createTestDir();
      try {
        const sessionFile = join(dir, "session.jsonl");
        const ping = { type: "ping", name: "sub", message: "halp" };
        writeFileSync(`${sessionFile}.exit`, JSON.stringify(ping));
        writeAutoExitDoneSidecar(sessionFile);
        const written = JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8"));
        assert.deepEqual(written, ping);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("pollForExit external surface-close", () => {
  it("bails out with a clear error after consecutive read failures", async () => {
    const dir = createTestDir();
    try {
      const sessionFile = join(dir, "poll.jsonl");
      let calls = 0;
      await assert.rejects(
        pollForExit("surface-x", new AbortController().signal, {
          interval: 1,
          sessionFile,
          readScreen: async () => {
            calls++;
            throw new Error("surface gone");
          },
          maxConsecutiveReadFailures: 3,
        } as any),
        /Subagent surface closed externally before completion/,
      );
      assert.ok(calls >= 3, `expected at least 3 read attempts, got ${calls}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns done when .exit appears despite read failures", async () => {
    const dir = createTestDir();
    try {
      const sessionFile = join(dir, "poll.jsonl");
      let calls = 0;
      const result = await pollForExit("surface-x", new AbortController().signal, {
        interval: 1,
        sessionFile,
        readScreen: async () => {
          calls++;
          if (calls === 2) {
            writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
          }
          throw new Error("surface gone");
        },
        maxConsecutiveReadFailures: 10,
      } as any);
      assert.equal(result.reason, "done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns ping when caller_ping .exit appears despite read failures", async () => {
    const dir = createTestDir();
    try {
      const sessionFile = join(dir, "poll.jsonl");
      let calls = 0;
      const result = await pollForExit("surface-x", new AbortController().signal, {
        interval: 1,
        sessionFile,
        readScreen: async () => {
          calls++;
          if (calls === 2) {
            writeFileSync(
              `${sessionFile}.exit`,
              JSON.stringify({ type: "ping", name: "sub", message: "halp" }),
            );
          }
          throw new Error("surface gone");
        },
        maxConsecutiveReadFailures: 10,
      } as any);
      assert.equal(result.reason, "ping");
      assert.deepEqual(result.ping, { name: "sub", message: "halp" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns sentinel when Claude sentinel file appears despite read failures", async () => {
    const dir = createTestDir();
    try {
      const sentinelFile = join(dir, "claude.sentinel");
      let calls = 0;
      const result = await pollForExit("surface-x", new AbortController().signal, {
        interval: 1,
        sentinelFile,
        readScreen: async () => {
          calls++;
          if (calls === 2) {
            writeFileSync(sentinelFile, "");
          }
          throw new Error("surface gone");
        },
        maxConsecutiveReadFailures: 10,
      } as any);
      assert.equal(result.reason, "sentinel");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
describe("resolveResumeLaunchBehavior", () => {
  // Resumed pi subagents default to auto-exit so follow-up work shuts the pane
  // down after a normal completion.
  it("defaults resumed subagents to auto-exit and non-interactive tracking", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.equal(typeof testApi.resolveResumeLaunchBehavior, "function");

    assert.deepEqual(testApi.resolveResumeLaunchBehavior({}), {
      autoExit: true,
      interactive: false,
    });
    assert.deepEqual(testApi.resolveResumeLaunchBehavior({ autoExit: false }), {
      autoExit: false,
      interactive: true,
    });
    assert.deepEqual(testApi.resolveResumeLaunchBehavior({ autoExit: true }), {
      autoExit: true,
      interactive: false,
    });
  });

  it("registers subagent_resume with an autoExit override", () => {
    const previousDeniedTools = process.env.PI_DENY_TOOLS;
    delete process.env.PI_DENY_TOOLS;
    try {
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const resumeTool = registeredTools.find((tool) => tool.name === "subagent_resume");
      assert.ok(resumeTool, "expected subagent_resume tool to be registered");

      const autoExitSchema = resumeTool.parameters.properties.autoExit;
      assert.ok(autoExitSchema, "autoExit parameter must be present");
      assert.equal(autoExitSchema.type, "boolean");
      assert.match(autoExitSchema.description, /Defaults to true/);
    } finally {
      restoreEnvVar("PI_DENY_TOOLS", previousDeniedTools);
    }
  });
});

describe("subagent startup delay", () => {
  it("defaults to 500ms when no env var is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });

  it("uses PI_SUBAGENT_SHELL_READY_DELAY_MS when it is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 2500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });
});

describe("subagents widget rendering", () => {
  it("keeps every rendered line within a very narrow width", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime: 1_000_000 - 13_000,
          sessionFile: "sess1",
          entries: 13,
          bytes: 55.6 * 1024,
        },
        {
          id: "a2",
          name: "B",
          task: "",
          surface: "s2",
          startTime: 1_000_000 - 21_000,
          sessionFile: "sess2",
          entries: 21,
          bytes: 115.6 * 1024,
        },
        {
          id: "a3",
          name: "C",
          task: "",
          surface: "s3",
          startTime: 1_000_000 - 27_000,
          sessionFile: "sess3",
          entries: 27,
          bytes: 106.8 * 1024,
        },
      ], 16);

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.borderLine, "function");

    const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime: Date.now() - 5_000,
          sessionFile: "sess1",
          entries: 1,
          bytes: 1,
        },
      ], width);

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });

  it("renders blocked tasks with a distinct status, keyed on (orchestrationId, taskIndex)", () => {
    const testApi = (subagentsModule as any).__test__;
    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines(
        [
          {
            id: "a1",
            name: "A",
            task: "",
            backend: "pane",
            startTime: 1_000_000 - 5000,
            blocked: {
              orchestrationId: "7a3f91e2",
              taskIndex: 0,
              message: "which schema?",
            },
          },
        ],
        60,
      );
      // Find the row that actually corresponds to the agent (skip the title
      // which has "N running" — that's about the count, not this row's state).
      const row = lines.find((l) => l.includes(" A ")) ?? "";
      assert.ok(/blocked/i.test(row), `expected blocked indicator in row, got: ${row}`);
      assert.ok(
        !/starting…|running…/i.test(row),
        `blocked row must not say starting…/running…, got: ${row}`,
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("removes a virtual blocked row when that task transitions to terminal, even if the orchestration is still running", () => {
    const testApi = (subagentsModule as any).__test__;
    // Minimal fake pi (emitter routes through piForRegistry → sendMessage).
    const fakePi = {
      registerTool: () => {},
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      sendUserMessage: () => {},
      sendMessage: () => {},
      on: () => {},
    };
    (subagentsModule as any).default(fakePi);
    testApi.resetRegistry();
    const registry = testApi.getRegistry();
    const running = testApi.getRunningSubagents();
    const virt = testApi.getVirtualBlocked();

    const id = registry.dispatchAsync({
      config: { mode: "parallel", tasks: [
        { name: "a", agent: "x", task: "t1" },
        { name: "b", agent: "x", task: "t2" },
      ] },
    });
    registry.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    registry.onTaskLaunched(id, 1, { sessionKey: "sess-b" });
    registry.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "?" });

    const key = `${id}:0`;
    assert.ok(virt.has(key), "virtual blocked row must exist after onTaskBlocked");
    assert.ok(running.has(`virt-${key}`), "runningSubagents must contain the virtual row");

    // Only task 0 goes terminal; task 1 still running. The virtual row must
    // clear right now, not wait for orchestration_complete.
    registry.onTaskTerminal(id, 0, {
      name: "a", index: 0, state: "completed", exitCode: 0, elapsedMs: 1,
    });
    assert.ok(!virt.has(key), "virtual blocked row must be dropped on per-task terminal");
    assert.ok(!running.has(`virt-${key}`), "runningSubagents must no longer contain the virtual row");
  });

  it("removes the virtual blocked row the moment subagent_resume starts (blocked -> running)", () => {
    const testApi = (subagentsModule as any).__test__;
    const fakePi = {
      registerTool: () => {},
      registerCommand: () => {},
      registerMessageRenderer: () => {},
      sendUserMessage: () => {},
      sendMessage: () => {},
      on: () => {},
    };
    (subagentsModule as any).default(fakePi);
    testApi.resetRegistry();
    const registry = testApi.getRegistry();
    const running = testApi.getRunningSubagents();
    const virt = testApi.getVirtualBlocked();

    const id = registry.dispatchAsync({
      config: { mode: "serial", tasks: [{ name: "a", agent: "x", task: "t" }] },
    });
    registry.onTaskLaunched(id, 0, { sessionKey: "sess-a" });
    registry.onTaskBlocked(id, 0, { sessionKey: "sess-a", message: "?" });

    const key = `${id}:0`;
    assert.ok(virt.has(key), "virtual blocked row must exist after block");
    assert.ok(running.has(`virt-${key}`), "runningSubagents must contain virt row");

    registry.onResumeStarted("sess-a");

    assert.ok(!virt.has(key), "virtual row must be dropped on resume-start");
    assert.ok(!running.has(`virt-${key}`), "runningSubagents must not contain virt row after resume-start");
    assert.equal(
      registry.getSnapshot(id).tasks[0].state,
      "running",
      "registry snapshot must transition blocked -> running on resume-start",
    );
  });
});

describe("mux", () => {
  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      // Inside single quotes, everything is literal
      assert.ok(escaped.includes("$world"));
    });
  });

  // Pure cmux JSON parsing helpers used by the focus snapshot/restore path
  // around subagent pane creation. These power both runtime focus preservation
  // and the integration harness's getFocusedSurface / getSurfacePane helpers.
  describe("parseCmuxFocusedSnapshot", () => {
    it("parses focused surface and pane refs", () => {
      assert.deepEqual(
        parseCmuxFocusedSnapshot({ focused: { surface_ref: "surface:3", pane_ref: "pane:2" } }),
        { surfaceRef: "surface:3", paneRef: "pane:2" },
      );
    });

    it("does not fall back to caller refs", () => {
      assert.equal(
        parseCmuxFocusedSnapshot({ caller: { surface_ref: "surface:1", pane_ref: "pane:1" } }),
        null,
      );
    });

    it("returns null for malformed values", () => {
      assert.equal(parseCmuxFocusedSnapshot(null), null);
      assert.equal(parseCmuxFocusedSnapshot({ focused: {} }), null);
    });
  });

  describe("parseCmuxJson", () => {
    it("returns null for malformed JSON text", () => {
      assert.equal(parseCmuxJson("not json"), null);
    });

    it("parses valid JSON text", () => {
      assert.deepEqual(parseCmuxJson('{"ok":true}'), { ok: true });
    });
  });

  describe("parseCmuxFocusedSnapshotFromJson", () => {
    it("returns null for malformed JSON text", () => {
      assert.equal(parseCmuxFocusedSnapshotFromJson("not json"), null);
    });

    it("returns null when focused is absent or not an object", () => {
      assert.equal(
        parseCmuxFocusedSnapshotFromJson(
          '{"focused":null,"caller":{"surface_ref":"surface:1","pane_ref":"pane:1"}}',
        ),
        null,
      );
      assert.equal(
        parseCmuxFocusedSnapshotFromJson('{"caller":{"surface_ref":"surface:1","pane_ref":"pane:1"}}'),
        null,
      );
    });

    it("parses focused refs without falling back to caller refs", () => {
      assert.deepEqual(
        parseCmuxFocusedSnapshotFromJson(
          '{"caller":{"surface_ref":"surface:1","pane_ref":"pane:1"},"focused":{"surface_ref":"surface:2","pane_ref":"pane:3"}}',
        ),
        { surfaceRef: "surface:2", paneRef: "pane:3" },
      );
    });
  });

  describe("parseCmuxPaneRefForSurface", () => {
    it("parses top-level pane refs for a surface", () => {
      assert.equal(
        parseCmuxPaneRefForSurface({ surface_ref: "surface:7", pane_ref: "pane:4" }, "surface:7"),
        "pane:4",
      );
    });

    it("parses caller pane refs for identify --surface output", () => {
      assert.equal(
        parseCmuxPaneRefForSurface(
          { caller: { surface_ref: "surface:7", pane_ref: "pane:4" } },
          "surface:7",
        ),
        "pane:4",
      );
    });

    it("returns null when the surface does not match", () => {
      assert.equal(
        parseCmuxPaneRefForSurface({ surface_ref: "surface:8", pane_ref: "pane:4" }, "surface:7"),
        null,
      );
    });
  });

  describe("parseCmuxPaneRefForSurfaceFromJson", () => {
    it("returns null for malformed JSON text", () => {
      assert.equal(parseCmuxPaneRefForSurfaceFromJson("not json", "surface:7"), null);
    });

    it("parses caller refs from cmux identify --surface JSON text", () => {
      assert.equal(
        parseCmuxPaneRefForSurfaceFromJson(
          '{"caller":{"surface_ref":"surface:7","pane_ref":"pane:4"}}',
          "surface:7",
        ),
        "pane:4",
      );
    });
  });

  describe("isCmuxForegroundAppIdentity", () => {
    it("recognizes the cmux app by bundle id or localized name", () => {
      assert.equal(
        isCmuxForegroundAppIdentity({ bundleIdentifier: "com.cmuxterm.app", localizedName: "cmux" }),
        true,
      );
      assert.equal(isCmuxForegroundAppIdentity({ localizedName: "CMUX" }), true);
      assert.equal(
        isCmuxForegroundAppIdentity({ bundleIdentifier: "company.thebrowser.Browser", localizedName: "Arc" }),
        false,
      );
    });
  });

  describe("shouldRestoreCmuxFocusAfterLaunch", () => {
    const snapshot = { surfaceRef: "surface:1", paneRef: "pane:1" };
    const child = { surface: "surface:2", paneRef: "pane:2" };

    it("skips focus restore when cmux was not the foreground macOS app", () => {
      assert.equal(
        shouldRestoreCmuxFocusAfterLaunch({
          cmuxWasForeground: false,
          snapshot,
          currentFocus: { surfaceRef: "surface:2", paneRef: "pane:2" },
          child,
        }),
        false,
      );
    });

    it("skips focus restore when cmux is no longer foreground before restore", () => {
      assert.equal(
        shouldRestoreCmuxFocusAfterLaunch({
          cmuxWasForeground: true,
          cmuxIsForeground: false,
          snapshot,
          currentFocus: { surfaceRef: "surface:2", paneRef: "pane:2" },
          child,
        }),
        false,
      );
    });

    it("restores cmux-internal focus when cmux was foreground and launch moved focus", () => {
      assert.equal(
        shouldRestoreCmuxFocusAfterLaunch({
          cmuxWasForeground: true,
          snapshot,
          currentFocus: { surfaceRef: "surface:2", paneRef: "pane:2" },
          child,
        }),
        true,
      );
      assert.equal(
        shouldRestoreCmuxFocusAfterLaunch({
          cmuxWasForeground: true,
          snapshot,
          currentFocus: { surfaceRef: "surface:9", paneRef: "pane:3" },
          child,
          callerSnapshot: { surfaceRef: "surface:9", paneRef: "pane:3" },
        }),
        true,
      );
    });
  });

  // Regression coverage for the tmux-backend detached-launch contract used by
  // orchestration wrappers (focus: false). Two invariants must hold together:
  //   1. `tmux split-window` argv includes `-d` when opts.detach is true so
  //      tmux does not transfer focus onto the new pane.
  //   2. The follow-up `tmux select-pane -t <pane> -T <name>` cosmetic call
  //      is skipped for detached launches because select-pane re-activates
  //      the target pane as a side-effect, which would re-steal focus.
  // The default (focused / non-detached) path must keep both behaviors
  // unchanged: no `-d` flag, and the title call still runs.
  describe("buildTmuxSplitArgs", () => {
    it("includes -d when opts.detach is true", () => {
      const args = buildTmuxSplitArgs("right", "%5", { detach: true });
      assert.ok(args.includes("-d"), `expected -d in args, got ${JSON.stringify(args)}`);
      // Sanity: split direction + target pane still propagate.
      assert.ok(args.includes("-h"));
      assert.ok(args.includes("-t"));
      assert.ok(args.includes("%5"));
      assert.ok(args.includes("-P"));
      assert.deepEqual(args.slice(-3), ["-P", "-F", "#{pane_id}"]);
    });

    it("omits -d when opts.detach is false", () => {
      const args = buildTmuxSplitArgs("right", "%5", { detach: false });
      assert.equal(args.includes("-d"), false, `unexpected -d in args ${JSON.stringify(args)}`);
    });

    it("omits -d when opts is undefined (default focused launch)", () => {
      const args = buildTmuxSplitArgs("right", "%5", undefined);
      assert.equal(args.includes("-d"), false);
    });

    it("emits -b for left/up directions and -v for vertical splits", () => {
      const left = buildTmuxSplitArgs("left", undefined, undefined);
      assert.ok(left.includes("-h"));
      assert.ok(left.includes("-b"));
      const up = buildTmuxSplitArgs("up", undefined, undefined);
      assert.ok(up.includes("-v"));
      assert.ok(up.includes("-b"));
      const down = buildTmuxSplitArgs("down", undefined, undefined);
      assert.ok(down.includes("-v"));
      assert.equal(down.includes("-b"), false);
    });
  });

  describe("shouldSetTmuxPaneTitle", () => {
    it("returns false when detach is true (skip select-pane -T to preserve focus)", () => {
      assert.equal(shouldSetTmuxPaneTitle({ detach: true }), false);
    });

    it("returns true for the default focused launch so the title is still applied", () => {
      assert.equal(shouldSetTmuxPaneTitle(undefined), true);
      assert.equal(shouldSetTmuxPaneTitle({}), true);
      assert.equal(shouldSetTmuxPaneTitle({ detach: false }), true);
    });
  });

  describe("isCmuxAvailable", () => {
    it("returns boolean based on CMUX_SOCKET_PATH", () => {
      // Can't easily mock env in node:test, just verify it returns a boolean
      const result = isCmuxAvailable();
      assert.equal(typeof result, "boolean");
    });
  });

  describe("isWezTermAvailable", () => {
    it("returns boolean based on WEZTERM_UNIX_SOCKET", () => {
      const result = isWezTermAvailable();
      assert.equal(typeof result, "boolean");
    });
  });

  describe("isHerdrAvailable", () => {
    it("returns boolean based on HERDR_ENV", () => {
      const result = isHerdrAvailable();
      assert.equal(typeof result, "boolean");
    });
  });

  describe("isTermioAvailable", () => {
    it("returns boolean based on TERM_PROGRAM/TERMIOD_SESSION_ID", () => {
      const result = isTermioAvailable();
      assert.equal(typeof result, "boolean");
    });
  });

  describe("termio adapter", () => {
    const TERMIO_KEYS = [
      "TERM_PROGRAM",
      "TERMIOD_SESSION_ID",
      "TERMIO_SESSION",
      "TERMIO_CLI",
      "PI_SUBAGENT_TERMIO_RATIO",
    ] as const;

    function snapshotTermioEnv(): Record<string, string | undefined> {
      const snap: Record<string, string | undefined> = {};
      for (const k of TERMIO_KEYS) snap[k] = process.env[k];
      return snap;
    }

    function restoreTermioEnv(snap: Record<string, string | undefined>): void {
      for (const k of TERMIO_KEYS) restoreEnvVar(k, snap[k]);
      termioTest.clearCliPathCache();
    }

    it("identifies itself and names termio in its setup hint", () => {
      assert.equal(termioAdapter.name, "termio");
      assert.match(termioAdapter.setupHint(), /termio/i);
    });

    it("collapses directions termio cannot express into right/down", () => {
      assert.equal(mapTermioDirection("right"), "right");
      assert.equal(mapTermioDirection("left"), "right");
      assert.equal(mapTermioDirection("down"), "down");
      assert.equal(mapTermioDirection("up"), "down");
    });

    it("builds the run argv with a normalized direction, ratio and JSON output", () => {
      const env = snapshotTermioEnv();
      try {
        delete process.env.PI_SUBAGENT_TERMIO_RATIO;
        assert.deepEqual(buildTermioRunArgs({ command: "exec /bin/zsh -l", direction: "left" }), [
          "sessions",
          "run",
          "exec /bin/zsh -l",
          "--direction",
          "right",
          "--ratio",
          "0.35",
          "--json",
        ]);

        const explicit = buildTermioRunArgs({ command: "x", direction: "up", ratio: "0.6" });
        assert.equal(explicit[explicit.indexOf("--direction") + 1], "down");
        assert.equal(explicit[explicit.indexOf("--ratio") + 1], "0.6");
      } finally {
        restoreTermioEnv(env);
      }
    });

    it("keeps the default split ratio when PI_SUBAGENT_TERMIO_RATIO is invalid", () => {
      const env = snapshotTermioEnv();
      try {
        for (const bad of ["", "0", "-1", "1.5", "abc"]) {
          process.env.PI_SUBAGENT_TERMIO_RATIO = bad;
          assert.equal(termioSplitRatio(), "0.35", `ratio for ${JSON.stringify(bad)}`);
        }
        process.env.PI_SUBAGENT_TERMIO_RATIO = "0.25";
        assert.equal(termioSplitRatio(), "0.25");
      } finally {
        restoreTermioEnv(env);
      }
    });

    it("prefers the TERMIO_CLI override when resolving the CLI", () => {
      const env = snapshotTermioEnv();
      try {
        termioTest.clearCliPathCache();
        process.env.TERMIO_CLI = "/nonexistent/termio";
        assert.equal(resolveTermioCliPath(), "/nonexistent/termio");
      } finally {
        restoreTermioEnv(env);
      }
    });

    it("reports unavailable when the process is not attached to termio", () => {
      const env = snapshotTermioEnv();
      try {
        termioTest.clearCliPathCache();
        delete process.env.TERM_PROGRAM;
        delete process.env.TERMIOD_SESSION_ID;
        delete process.env.TERMIO_SESSION;
        assert.equal(termioAdapter.isAvailable(), false);
      } finally {
        restoreTermioEnv(env);
      }
    });

    it("rejects non-JSON CLI output instead of inventing a surface", () => {
      const env = snapshotTermioEnv();
      const dir = mkdtempSync(join(tmpdir(), "termio-stub-"));
      try {
        const stub = join(dir, "termio");
        writeFileSync(stub, "#!/bin/sh\necho not-json\n", { mode: 0o755 });
        termioTest.clearCliPathCache();
        process.env.TERMIO_CLI = stub;
        assert.throws(
          () => termioAdapter.createSurfaceSplit("probe", "right"),
          /non-JSON output/,
        );
      } finally {
        restoreTermioEnv(env);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("returns the session link that termio reports for a new pane", () => {
      const env = snapshotTermioEnv();
      const dir = mkdtempSync(join(tmpdir(), "termio-stub-"));
      try {
        const stub = join(dir, "termio");
        writeFileSync(
          stub,
          '#!/bin/sh\necho \'{"created":true,"ok":true,"target":"termio://session/abc"}\'\n',
          { mode: 0o755 },
        );
        termioTest.clearCliPathCache();
        process.env.TERMIO_CLI = stub;
        assert.equal(termioAdapter.createSurfaceSplit("probe", "right"), "termio://session/abc");
      } finally {
        restoreTermioEnv(env);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("zellij placement", () => {
    const pane = (overrides: Partial<Record<string, unknown>>) => ({
      id: 1,
      is_plugin: false,
      is_floating: false,
      is_selectable: true,
      exited: false,
      pane_rows: 20,
      pane_columns: 80,
      tab_id: 1,
      ...overrides,
    });

    it("matches Zellij direction and minimum split rules", () => {
      assert.equal(predictZellijSplitDirection(pane({ pane_rows: 5, pane_columns: 11 })), "right");
      assert.equal(predictZellijSplitDirection(pane({ pane_rows: 11, pane_columns: 5 })), "down");
      assert.equal(predictZellijSplitDirection(pane({ pane_rows: 5, pane_columns: 10 })), null);
      assert.equal(predictZellijSplitDirection(pane({ pane_rows: 4, pane_columns: 80 })), null);

      assert.equal(canSplitZellijPane(pane({ pane_rows: 5, pane_columns: 11 })), true);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 11, pane_columns: 5 })), true);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 5, pane_columns: 10 })), false);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 4, pane_columns: 80 })), false);

      assert.equal(canSplitZellijPane(pane({ pane_rows: 30, pane_columns: 100 }), 80, 20), false);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 45, pane_columns: 100 }), 80, 20), true);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 30, pane_columns: 170 }), 80, 20), true);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 31, pane_columns: 47 }), 50, 10), false);
      assert.equal(canSplitZellijPane(pane({ pane_rows: 31, pane_columns: 77 }), 50, 10), true);
    });

    it("uses tab-scoped split only when all Zellij split candidates are safe", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 40, pane_columns: 120 }),
          pane({ id: 11, tab_id: 1, pane_rows: 120, pane_columns: 100 }),
          pane({ id: 12, tab_id: 2, pane_rows: 60, pane_columns: 200 }),
        ],
        10,
      );

      assert.deepEqual(plan, {
        mode: "split",
        anchorPaneId: 11,
        targetPaneId: 11,
        tabId: 1,
        splitDirection: "down",
      });
    });

    it("stacks when any Zellij split candidate would fall below Pi's configured minimum", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 100, pane_columns: 47 }),
          pane({ id: 11, tab_id: 1, pane_rows: 31, pane_columns: 77 }),
        ],
        10,
        50,
        10,
      );

      assert.deepEqual(plan, {
        mode: "stack",
        anchorPaneId: 11,
        targetPaneId: 11,
        tabId: 1,
      });
    });

    it("stacks when Zellij would split a pane below Pi's usable minimum", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 20, pane_columns: 20 }),
          pane({ id: 11, tab_id: 1, pane_rows: 18, pane_columns: 60 }),
          pane({ id: 12, tab_id: 1, pane_rows: 10, pane_columns: 70 }),
        ],
        10,
      );

      assert.deepEqual(plan, {
        mode: "stack",
        anchorPaneId: 11,
        targetPaneId: 11,
        tabId: 1,
      });
    });

    it("never chooses the parent pane as the stack target", () => {
      const plan = selectZellijStackPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 60, pane_columns: 200 }),
          pane({ id: 11, tab_id: 1, pane_rows: 10, pane_columns: 20 }),
          pane({ id: 12, tab_id: 1, pane_rows: 8, pane_columns: 30 }),
        ],
        10,
      );

      assert.deepEqual(plan, {
        mode: "stack",
        anchorPaneId: 12,
        targetPaneId: 12,
        tabId: 1,
      });
    });

    it("does not stack when the only usable pane is the parent", () => {
      const plan = selectZellijStackPlacement(
        [pane({ id: 10, tab_id: 1, pane_rows: 60, pane_columns: 200 })],
        10,
      );

      assert.equal(plan, null);
    });

    it("stacks on the largest usable non-parent pane when none can split", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 5, pane_columns: 10 }),
          pane({ id: 11, tab_id: 1, pane_rows: 6, pane_columns: 8 }),
          pane({ id: 12, tab_id: 2, pane_rows: 60, pane_columns: 200 }),
        ],
        10,
      );

      assert.deepEqual(plan, {
        mode: "stack",
        anchorPaneId: 11,
        targetPaneId: 11,
        tabId: 1,
      });
    });

    it("ignores floating, plugin, exited, unselectable, and other-tab panes", () => {
      const plan = selectZellijPlacement(
        [
          pane({ id: 10, tab_id: 1, pane_rows: 5, pane_columns: 10 }),
          pane({ id: 11, tab_id: 1, pane_rows: 60, pane_columns: 200, is_floating: true }),
          pane({ id: 12, tab_id: 1, pane_rows: 60, pane_columns: 200, is_plugin: true }),
          pane({ id: 13, tab_id: 1, pane_rows: 60, pane_columns: 200, exited: true }),
          pane({ id: 14, tab_id: 1, pane_rows: 60, pane_columns: 200, is_selectable: false }),
          pane({ id: 15, tab_id: 2, pane_rows: 60, pane_columns: 200 }),
        ],
        10,
      );

      assert.equal(plan, null);
    });

    it("returns null when the parent pane cannot be found", () => {
      assert.equal(selectZellijPlacement([pane({ id: 10 })], 99), null);
    });
  });

  describe("herdr adapter — pure parsers", () => {
    const validPane = {
      pane_id: "p_1",
      tab_id: "t_1",
      workspace_id: "w_1",
      terminal_id: "term-aaaa",
      focused: false,
    };

    it("parseHerdrJson returns null for malformed JSON", () => {
      assert.equal(parseHerdrJson("not json"), null);
      assert.equal(parseHerdrJson(""), null);
    });

    it("parseHerdrJson parses valid JSON", () => {
      assert.deepEqual(parseHerdrJson('{"a":1}'), { a: 1 });
    });

    it("parseHerdrPaneInfo accepts a pane with all required fields", () => {
      assert.deepEqual(parseHerdrPaneInfo(validPane), validPane);
    });

    it("parseHerdrPaneInfo rejects when any required field is missing", () => {
      assert.equal(parseHerdrPaneInfo({ ...validPane, pane_id: "" }), null);
      assert.equal(parseHerdrPaneInfo({ ...validPane, tab_id: undefined }), null);
      const { workspace_id: _w, ...withoutWorkspace } = validPane;
      assert.equal(parseHerdrPaneInfo(withoutWorkspace), null);
      assert.equal(parseHerdrPaneInfo({ ...validPane, terminal_id: 42 }), null);
    });

    it("parseHerdrPaneInfo preserves focused only when boolean", () => {
      assert.equal(parseHerdrPaneInfo({ ...validPane, focused: true })?.focused, true);
      assert.equal(parseHerdrPaneInfo({ ...validPane, focused: "yes" })?.focused, undefined);
    });

    it("parseHerdrPaneInfo accepts the actual pane get { result: { pane } } envelope", () => {
      assert.deepEqual(
        parseHerdrPaneInfo({ result: { pane: validPane, type: "pane_info" } }),
        validPane,
      );
    });

    it("parseHerdrTabCreateResult extracts the root pane", () => {
      const sample = { result: { tab: { id: "t_2" }, root_pane: validPane } };
      assert.deepEqual(parseHerdrTabCreateResult(sample), validPane);
    });

    it("parseHerdrTabCreateResult returns null when root_pane is missing", () => {
      assert.equal(parseHerdrTabCreateResult({ result: {} }), null);
      assert.equal(parseHerdrTabCreateResult({}), null);
      assert.equal(parseHerdrTabCreateResult(null), null);
    });

    it("parseHerdrPaneSplitResult extracts the new pane", () => {
      const sample = { result: { pane: validPane } };
      assert.deepEqual(parseHerdrPaneSplitResult(sample), validPane);
    });

    it("parseHerdrPaneSplitResult returns null when pane is malformed", () => {
      assert.equal(parseHerdrPaneSplitResult({ result: { pane: { pane_id: "p_1" } } }), null);
      assert.equal(parseHerdrPaneSplitResult({ result: null }), null);
      assert.equal(parseHerdrPaneSplitResult(null), null);
    });

    it("parseHerdrPaneList accepts a top-level array", () => {
      assert.deepEqual(parseHerdrPaneList([validPane]), [validPane]);
    });

    it("parseHerdrPaneList accepts a { result: [...] } envelope", () => {
      assert.deepEqual(parseHerdrPaneList({ result: [validPane] }), [validPane]);
    });

    it("parseHerdrPaneList accepts the actual { result: { panes: [...] } } envelope", () => {
      assert.deepEqual(
        parseHerdrPaneList({ result: { panes: [validPane], type: "pane_list" } }),
        [validPane],
      );
    });

    it("parseHerdrPaneList drops malformed entries silently", () => {
      const sample = [validPane, { pane_id: "p_2" }, null, validPane];
      assert.deepEqual(parseHerdrPaneList(sample), [validPane, validPane]);
    });

    it("parseHerdrPaneList returns null when input is not list-shaped", () => {
      assert.equal(parseHerdrPaneList("nope"), null);
      assert.equal(parseHerdrPaneList(undefined), null);
      assert.equal(parseHerdrPaneList({ result: "still not an array" }), null);
    });
  });

  describe("herdr adapter — surface encode/decode", () => {
    it("round-trips a tab surface", () => {
      const surface = encodeHerdrSurface("tab", "w_1", "term-abc");
      assert.deepEqual(decodeHerdrSurface(surface), {
        kind: "tab",
        workspaceId: "w_1",
        terminalId: "term-abc",
      });
    });

    it("round-trips a pane surface", () => {
      const surface = encodeHerdrSurface("pane", "ws_42", "terminal:42");
      assert.deepEqual(decodeHerdrSurface(surface), {
        kind: "pane",
        workspaceId: "ws_42",
        terminalId: "terminal:42",
      });
    });

    it("URI-encodes components so embedded delimiters are safe", () => {
      const surface = encodeHerdrSurface("tab", "w 1", "term/with:colon");
      assert.equal(surface.split(":").length, 4);
      assert.deepEqual(decodeHerdrSurface(surface), {
        kind: "tab",
        workspaceId: "w 1",
        terminalId: "term/with:colon",
      });
    });

    it("rejects non-herdr surfaces", () => {
      assert.equal(decodeHerdrSurface("pane:1"), null);
      assert.equal(decodeHerdrSurface("surface:3"), null);
      assert.equal(decodeHerdrSurface("%5"), null);
      assert.equal(decodeHerdrSurface(""), null);
    });

    it("rejects malformed herdr surfaces", () => {
      assert.equal(decodeHerdrSurface("herdr:tab"), null);
      assert.equal(decodeHerdrSurface("herdr:tab:w_1"), null);
      assert.equal(decodeHerdrSurface("herdr:bogus:w_1:term-1"), null);
      assert.equal(decodeHerdrSurface("herdr:tab::term-1"), null);
      assert.equal(decodeHerdrSurface("herdr:tab:w_1:"), null);
    });
  });

  describe("herdr adapter — terminal-id resolution", () => {
    const paneA: import("../src/mux/types.ts").HerdrPaneInfo = {
      pane_id: "p_3",
      tab_id: "t_2",
      workspace_id: "w_1",
      terminal_id: "term-aaaa",
    };
    const paneB = {
      pane_id: "p_4",
      tab_id: "t_3",
      workspace_id: "w_1",
      terminal_id: "term-bbbb",
    } as typeof paneA;

    it("finds the pane matching the stored terminal_id", () => {
      assert.equal(findPaneByTerminalId([paneA, paneB], "term-bbbb"), paneB);
    });

    it("returns null when terminal_id is no longer present", () => {
      assert.equal(findPaneByTerminalId([paneA], "term-missing"), null);
    });

    it("survives id compaction: same terminal_id, different pane_id after renumber", () => {
      const compacted = { ...paneA, pane_id: "p_1", tab_id: "t_1" };
      const resolved = findPaneByTerminalId([compacted], "term-aaaa");
      assert.deepEqual(resolved, compacted);
      assert.notEqual(resolved?.pane_id, paneA.pane_id);
      assert.notEqual(resolved?.tab_id, paneA.tab_id);
    });
  });

  describe("herdr adapter — argv builders + read combination", () => {
    it("buildHerdrTabCreateArgs includes --no-focus when detach is true", () => {
      const args = buildHerdrTabCreateArgs({
        workspaceId: "w_1",
        cwd: "/tmp/proj",
        label: "child",
        detach: true,
      });
      assert.ok(args.includes("--no-focus"), `expected --no-focus in ${JSON.stringify(args)}`);
      assert.deepEqual(args.slice(0, 8), [
        "tab",
        "create",
        "--workspace",
        "w_1",
        "--cwd",
        "/tmp/proj",
        "--label",
        "child",
      ]);
    });

    it("buildHerdrTabCreateArgs omits --no-focus when detach is false", () => {
      const args = buildHerdrTabCreateArgs({
        workspaceId: "w_1",
        cwd: "/tmp/proj",
        label: "child",
        detach: false,
      });
      assert.equal(args.includes("--no-focus"), false);
    });

    it("buildHerdrPaneSplitArgs translates left/right to right and up/down to down", () => {
      const right = buildHerdrPaneSplitArgs({ paneId: "p_1", direction: "right", detach: false });
      const left = buildHerdrPaneSplitArgs({ paneId: "p_1", direction: "left", detach: false });
      const down = buildHerdrPaneSplitArgs({ paneId: "p_1", direction: "down", detach: false });
      const up = buildHerdrPaneSplitArgs({ paneId: "p_1", direction: "up", detach: false });
      assert.deepEqual(right, ["pane", "split", "p_1", "--direction", "right"]);
      assert.deepEqual(left, ["pane", "split", "p_1", "--direction", "right"]);
      assert.deepEqual(down, ["pane", "split", "p_1", "--direction", "down"]);
      assert.deepEqual(up, ["pane", "split", "p_1", "--direction", "down"]);
    });

    it("buildHerdrPaneSplitArgs appends --no-focus on detach", () => {
      const args = buildHerdrPaneSplitArgs({ paneId: "p_1", direction: "right", detach: true });
      assert.ok(args.includes("--no-focus"));
    });

    it("buildHerdrSendCommandArgs sends text and Enter instead of pane run", () => {
      assert.deepEqual(buildHerdrSendCommandArgs("p_1", "yes please proceed"), [
        ["pane", "send-text", "p_1", "yes please proceed"],
        ["pane", "send-keys", "p_1", "Enter"],
      ]);
    });

    it("isHerdrPaneNotFoundError recognizes Herdr compacted-id failures", () => {
      const error = new Error(
        'Command failed: herdr pane send-text old "cmd"\n{"error":{"code":"pane_not_found"}}',
      );
      assert.equal(isHerdrPaneNotFoundError(error), true);
      assert.equal(isHerdrPaneNotFoundError(new Error("permission denied")), false);
    });

    it("runHerdrPaneActionWithRetry re-resolves after pane_not_found", () => {
      const resolved: string[] = [];
      const attempted: string[] = [];
      const ids = ["old-pane", "new-pane"];

      runHerdrPaneActionWithRetry({
        retryDelayMs: 0,
        resolvePaneId: () => {
          const id = ids.shift() ?? "new-pane";
          resolved.push(id);
          return id;
        },
        run: (paneId) => {
          attempted.push(paneId);
          if (paneId === "old-pane") {
            throw new Error('{"error":{"code":"pane_not_found"}}');
          }
        },
      });

      assert.deepEqual(resolved, ["old-pane", "new-pane"]);
      assert.deepEqual(attempted, ["old-pane", "new-pane"]);
    });

    it("runHerdrPaneActionWithRetry retries transient terminal_id resolution races", () => {
      let resolves = 0;
      const attempted: string[] = [];

      runHerdrPaneActionWithRetry({
        retryDelayMs: 0,
        resolvePaneId: () => {
          resolves += 1;
          if (resolves === 1) {
            throw new Error(
              "Could not resolve herdr surface to a live pane (terminal_id=term-new; kind=tab; workspace_id=w_1). The pane may have been closed externally.",
            );
          }
          return "new-pane";
        },
        run: (paneId) => {
          attempted.push(paneId);
        },
      });

      assert.equal(resolves, 2);
      assert.deepEqual(attempted, ["new-pane"]);
    });

    it("runHerdrPaneActionWithRetry does not retry non-compaction failures", () => {
      let attempts = 0;
      assert.throws(
        () => runHerdrPaneActionWithRetry({
          resolvePaneId: () => "pane-1",
          run: () => {
            attempts += 1;
            throw new Error("permission denied");
          },
        }),
        /permission denied/,
      );
      assert.equal(attempts, 1);
    });

    it("combineHerdrReadOutput uses visible when recent-unwrapped is empty", () => {
      assert.equal(combineHerdrReadOutput("", "hi"), "hi");
    });

    it("combineHerdrReadOutput uses recent-unwrapped when visible is empty", () => {
      assert.equal(combineHerdrReadOutput("scrollback", ""), "scrollback");
    });

    it("combineHerdrReadOutput concatenates with a single newline separator", () => {
      assert.equal(
        combineHerdrReadOutput("scrollback line\n", "visible bit"),
        "scrollback line\nvisible bit",
      );
    });

    it("combineHerdrReadOutput places the visible block last so the sentinel scan catches short output", () => {
      const out = combineHerdrReadOutput("noise\n", "__SUBAGENT_DONE_0__");
      const last5 = out.split("\n").slice(-5).join("\n");
      assert.match(last5, /__SUBAGENT_DONE_0__/);
    });
  });

  describe("herdr adapter — adapter object", () => {
    it("declares name as 'herdr'", () => {
      assert.equal(herdrAdapter.name, "herdr");
    });

    it("setupHint mentions running pi inside herdr", () => {
      assert.match(herdrAdapter.setupHint(), /herdr/i);
      assert.match(herdrAdapter.setupHint(), /run `?pi`?/i);
    });

    it("isAvailable returns false when HERDR_ENV is unset", () => {
      const prev = process.env.HERDR_ENV;
      delete process.env.HERDR_ENV;
      try {
        assert.equal(herdrAdapter.isAvailable(), false);
      } finally {
        if (prev === undefined) delete process.env.HERDR_ENV;
        else process.env.HERDR_ENV = prev;
      }
    });

    it("isAvailable returns false when HERDR_ENV is set to something other than '1'", () => {
      const prev = process.env.HERDR_ENV;
      process.env.HERDR_ENV = "0";
      try {
        assert.equal(herdrAdapter.isAvailable(), false);
      } finally {
        if (prev === undefined) delete process.env.HERDR_ENV;
        else process.env.HERDR_ENV = prev;
      }
    });
  });

  describe("herdr backend selection — muxSetupHint and getMuxBackend", () => {
    const HERDR_KEYS = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "PI_SUBAGENT_MUX"];

    function snapshot(): Record<string, string | undefined> {
      const snap: Record<string, string | undefined> = {};
      for (const k of HERDR_KEYS) snap[k] = process.env[k];
      return snap;
    }
    function restore(snap: Record<string, string | undefined>): void {
      for (const [k, v] of Object.entries(snap)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    it("muxSetupHint returns the herdr setup hint when PI_SUBAGENT_MUX=herdr", () => {
      const snap = snapshot();
      try {
        for (const k of HERDR_KEYS) delete process.env[k];
        process.env.PI_SUBAGENT_MUX = "herdr";
        const hint = muxSetupHint();
        assert.match(hint, /herdr/i);
        assert.equal(hint.includes("cmux"), false, `expected herdr-specific hint, got: ${hint}`);
      } finally {
        restore(snap);
      }
    });

    it("muxSetupHint composite fallback mentions herdr alongside the other backends", () => {
      const snap = snapshot();
      try {
        for (const k of HERDR_KEYS) delete process.env[k];
        const hint = muxSetupHint();
        assert.match(hint, /herdr/i);
        assert.match(hint, /cmux/i);
      } finally {
        restore(snap);
      }
    });

    it("getMuxBackend returns null when PI_SUBAGENT_MUX=herdr but herdr is not available", () => {
      const snap = snapshot();
      try {
        for (const k of HERDR_KEYS) delete process.env[k];
        process.env.PI_SUBAGENT_MUX = "herdr";
        assert.equal(getMuxBackend(), null);
      } finally {
        restore(snap);
      }
    });

    it("getMuxBackend returns \"herdr\" when PI_SUBAGENT_MUX=herdr and herdr is available", () => {
      const snap = snapshot();
      const originalIsAvailable = herdrAdapter.isAvailable;
      try {
        for (const k of HERDR_KEYS) delete process.env[k];
        process.env.PI_SUBAGENT_MUX = "herdr";
        (herdrAdapter as { isAvailable: () => boolean }).isAvailable = () => true;
        assert.equal(getMuxBackend(), "herdr");
      } finally {
        (herdrAdapter as { isAvailable: () => boolean }).isAvailable = originalIsAvailable;
        restore(snap);
      }
    });

    it("getMuxBackend auto-detect returns \"herdr\" when herdr is available (ADAPTERS ordering)", () => {
      const snap = snapshot();
      const originalIsAvailable = herdrAdapter.isAvailable;
      try {
        for (const k of HERDR_KEYS) delete process.env[k];
        (herdrAdapter as { isAvailable: () => boolean }).isAvailable = () => true;
        assert.equal(getMuxBackend(), "herdr");
      } finally {
        (herdrAdapter as { isAvailable: () => boolean }).isAvailable = originalIsAvailable;
        restore(snap);
      }
    });
  });

  describe("herdr adapter — failure messages", () => {
    it("closeSurface throws with a message naming the offending non-herdr surface", () => {
      assert.throws(
        () => herdrAdapter.closeSurface("zellij:tab:42"),
        (err: Error) => {
          assert.match(err.message, /non-herdr surface/i);
          assert.match(err.message, /closeSurface/);
          assert.match(err.message, /zellij:tab:42/);
          return true;
        },
      );
    });

    it("sendCommand throws with a message naming the offending non-herdr surface", () => {
      assert.throws(
        () => herdrAdapter.sendCommand("not-a-surface", "echo hi"),
        (err: Error) => {
          assert.match(err.message, /non-herdr surface/i);
          assert.match(err.message, /not-a-surface/);
          return true;
        },
      );
    });

    it("sendEscape throws with a message naming the offending non-herdr surface", () => {
      assert.throws(
        () => herdrAdapter.sendEscape("herdr:tab:w_1"),
        (err: Error) => {
          assert.match(err.message, /non-herdr surface/i);
          assert.match(err.message, /herdr:tab:w_1/);
          return true;
        },
      );
    });

    it("createSurface throws an actionable error when HERDR_PANE_ID is unset", () => {
      const prev = process.env.HERDR_PANE_ID;
      delete process.env.HERDR_PANE_ID;
      try {
        assert.throws(
          () => herdrAdapter.createSurface("child"),
          (err: Error) => {
            assert.match(err.message, /HERDR_PANE_ID/);
            assert.match(err.message, /herdr pane/i);
            return true;
          },
        );
      } finally {
        if (prev === undefined) delete process.env.HERDR_PANE_ID;
        else process.env.HERDR_PANE_ID = prev;
      }
    });

    it("pinned-Herdr setup hint surfaces an actionable Herdr instruction when herdr is unavailable", () => {
      const HERDR_KEYS = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "PI_SUBAGENT_MUX"];
      const snap: Record<string, string | undefined> = {};
      for (const k of HERDR_KEYS) snap[k] = process.env[k];
      try {
        for (const k of HERDR_KEYS) delete process.env[k];
        process.env.PI_SUBAGENT_MUX = "herdr";
        const hint = muxSetupHint();
        assert.match(hint, /herdr/i);
        assert.match(hint, /run `?pi`?/i);
      } finally {
        for (const [k, v] of Object.entries(snap)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
  });
});

describe("subagents __test__ — extension-level seams", () => {
  const api = (subagentsModule as any).__test__;

  it("exposes LauncherDeps override setter + getter", () => {
    assert.equal(typeof api.setLauncherDepsOverride, "function");
    assert.equal(typeof api.getLauncherDepsOverride, "function");
    const fake = { launch: async () => ({}) as any, waitForCompletion: async () => ({}) as any };
    api.setLauncherDepsOverride(fake);
    assert.equal(api.getLauncherDepsOverride(), fake);
    api.setLauncherDepsOverride(null);
    assert.equal(api.getLauncherDepsOverride(), null);
  });

  it("exposes watchSubagent override setter + getter", () => {
    assert.equal(typeof api.setWatchSubagentOverride, "function");
    assert.equal(typeof api.getWatchSubagentOverride, "function");
    const fake = async () => ({}) as any;
    api.setWatchSubagentOverride(fake);
    assert.equal(api.getWatchSubagentOverride(), fake);
    api.setWatchSubagentOverride(null);
    assert.equal(api.getWatchSubagentOverride(), null);
  });

  it("exposes registry introspection seams for tool-boundary tests", () => {
    assert.equal(typeof api.getRegistry, "function");
    assert.equal(typeof api.resetRegistry, "function");
    const r1 = api.getRegistry();
    assert.ok(r1 && typeof r1.dispatchAsync === "function");
    api.resetRegistry();
    const r2 = api.getRegistry();
    assert.notEqual(r1, r2, "resetRegistry must return a fresh instance");
  });

  it("exposes mux-availability override so subagent_resume tool-boundary tests run on no-mux hosts", () => {
    assert.equal(typeof api.setMuxAvailableOverride, "function");
    assert.equal(typeof api.getMuxAvailableOverride, "function");
    api.setMuxAvailableOverride(true);
    assert.equal(api.getMuxAvailableOverride(), true);
    api.setMuxAvailableOverride(false);
    assert.equal(api.getMuxAvailableOverride(), false);
    api.setMuxAvailableOverride(null);
    assert.equal(api.getMuxAvailableOverride(), null);
  });
});

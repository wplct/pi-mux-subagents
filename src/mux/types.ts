export type MuxBackend = "cmux" | "tmux" | "zellij" | "wezterm" | "herdr" | "termio";

export interface MuxAdapter {
  readonly name: MuxBackend;
  isAvailable(): boolean;
  setupHint(): string;
  createSurface(name: string, opts?: { detach?: boolean }): string;
  createSurfaceSplit(name: string, direction: "left" | "right" | "up" | "down", fromSurface?: string, opts?: { detach?: boolean }): string;
  closeSurface(surface: string): void;
  sendCommand(surface: string, command: string): void;
  sendEscape(surface: string): void;
  readScreen(surface: string, lines?: number): string;
  readScreenAsync(surface: string, lines?: number): Promise<string>;
  renameCurrentTab(title: string): void;
  renameWorkspace(title: string): void;
}

export interface ZellijPaneSnapshot {
  id: number;
  is_plugin?: boolean;
  is_floating?: boolean;
  is_selectable?: boolean;
  exited?: boolean;
  pane_rows?: number;
  pane_columns?: number;
  tab_id?: number;
  is_focused?: boolean;
}

export type ZellijSplitDirection = "down" | "right";

export type ZellijPlacementPlan =
  | {
      mode: "split";
      anchorPaneId: number;
      targetPaneId: number;
      tabId: number;
      splitDirection: ZellijSplitDirection;
    }
  | { mode: "stack"; anchorPaneId: number; targetPaneId: number; tabId: number };

export type CmuxFocusSnapshot = {
  surfaceRef?: string;
  paneRef?: string;
};

export type CmuxCreatedSurface = {
  surface: string;
  paneRef?: string;
};

export type CmuxAppIdentity = {
  bundleIdentifier?: string;
  localizedName?: string;
};

export interface HerdrPaneInfo {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  terminal_id: string;
  focused?: boolean;
}

export type HerdrSurfaceKind = "tab" | "pane";

export interface HerdrSurface {
  kind: HerdrSurfaceKind;
  workspaceId: string;
  terminalId: string;
}

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "ping" | "sentinel";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Ping data if reason is "ping" */
  ping?: { name: string; message: string };
}

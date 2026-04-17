/**
 * Shared config for the daemon runtime and installer.
 *
 * Config lives at ~/.isteam/daemon.json and is written by the setup wizard.
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

export const ISTEAM_DIR       = join(homedir(), ".isteam");
export const DAEMON_CONFIG    = join(ISTEAM_DIR, "daemon.json");
export const DAEMON_LOG       = join(ISTEAM_DIR, "daemon.log");
export const DAEMON_ERROR_LOG = join(ISTEAM_DIR, "daemon-error.log");
export const DAEMON_PID_FILE  = join(ISTEAM_DIR, "daemon.pid");
export const DAEMON_QUEUE_DIR = join(ISTEAM_DIR, "queue");

export const LAUNCHD_LABEL    = "team.is.mcp-daemon";
export const SYSTEMD_UNIT     = "isteam-mcp-daemon";

export type PermissionMode = "acceptEdits" | "bypassPermissions" | "plan";

export interface DaemonConfig {
  /** is.team API token (ist_…) */
  token: string;
  /**
   * User-chosen 6-char alphanumeric name for this agent (e.g. "HOME01",
   * "MACM01", "DEV001"). Appears in the is.team dashboard as the agent's
   * badge. Distinguishes this terminal/daemon from other agents run by
   * the same user. Must match /^[A-Z0-9]{6}$/.
   */
  agentName: string;
  /** Card id the daemon listens to (col-…) */
  agentCardId: string;
  /** Workspace id */
  workspaceId: string;
  /** Board id */
  boardId: string;
  /** Node id (same as cardId for kanban columns, but kept explicit) */
  nodeId: string;
  /** Card display title — used in logs/chat relay */
  cardTitle: string;
  /** Working directory Claude runs in */
  workingDir: string;
  /** Permission flag passed to claude */
  permissionMode: PermissionMode;
  /** Absolute path to the claude binary */
  claudePath: string;
  /** Base URL (defaults to https://is.team) */
  baseUrl?: string;
}

/** Validation helper used by both setup wizard and runtime. */
export function isValidAgentName(s: string): boolean {
  return /^[A-Z0-9]{6}$/.test(s);
}

export function ensureIsteamDir(): void {
  if (!existsSync(ISTEAM_DIR))    mkdirSync(ISTEAM_DIR, { recursive: true });
  if (!existsSync(DAEMON_QUEUE_DIR)) mkdirSync(DAEMON_QUEUE_DIR, { recursive: true });
}

export function readDaemonConfig(): DaemonConfig | null {
  if (!existsSync(DAEMON_CONFIG)) return null;
  try {
    return JSON.parse(readFileSync(DAEMON_CONFIG, "utf-8")) as DaemonConfig;
  } catch {
    return null;
  }
}

export function writeDaemonConfig(cfg: DaemonConfig): void {
  ensureIsteamDir();
  writeFileSync(DAEMON_CONFIG, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

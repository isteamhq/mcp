/**
 * Platform-specific service installers for the daemon.
 *
 * macOS → launchd agent in ~/Library/LaunchAgents
 * Linux → systemd user unit in ~/.config/systemd/user
 */

import { homedir, platform } from "os";
import { join, dirname } from "path";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";

import {
  DAEMON_LOG,
  DAEMON_ERROR_LOG,
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
} from "./daemon-config.js";

/* ------------------------------------------------------------------ */
/*  Paths                                                              */
/* ------------------------------------------------------------------ */

function launchdPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function systemdUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", `${SYSTEMD_UNIT}.service`);
}

function whichBinary(name: string): string | null {
  try {
    const p = execSync(`command -v ${name}`, { stdio: "pipe" }).toString().trim();
    if (p && existsSync(p)) return p;
  } catch { /* ignore */ }
  return null;
}

function nodePath(): string {
  return whichBinary("node") ?? process.execPath;
}

function npxPath(): string | null {
  return whichBinary("npx");
}

/**
 * How we launch the daemon from the service file.
 *
 * Priority:
 *   1. Globally installed package — fastest start, no network check.
 *      Detected via `npm root -g` + file existence.
 *   2. Development (running from source) — resolve daemon.js relative to this
 *      module. Only used when someone runs the built code locally.
 *   3. `npx -y @isteam/mcp@latest daemon run` — works without a global
 *      install, but cold-start is slow and requires network the first time.
 */
interface LaunchCommand {
  /** Absolute path to the executable launchd/systemd will spawn. */
  program: string;
  /** Arguments passed to the program. */
  args: string[];
  /** Human-readable description for the installer output. */
  description: string;
}

function resolveLaunchCommand(): LaunchCommand {
  // (1) Globally installed
  try {
    const root = execSync("npm root -g", { stdio: "pipe" }).toString().trim();
    const candidate = join(root, "@isteam", "mcp", "dist", "daemon.js");
    if (existsSync(candidate)) {
      return {
        program: nodePath(),
        args: [candidate],
        description: `node ${candidate}`,
      };
    }
  } catch { /* fallthrough */ }

  // (2) Dev fallback — relative to this source file
  try {
    const here = new URL(import.meta.url).pathname;
    const devCandidate = join(dirname(here), "daemon.js");
    if (existsSync(devCandidate)) {
      return {
        program: nodePath(),
        args: [devCandidate],
        description: `node ${devCandidate} (dev path)`,
      };
    }
  } catch { /* fallthrough */ }

  // (3) npx fallback — requires npx in PATH
  const npx = npxPath();
  if (!npx) {
    throw new Error("Could not locate npx. Install Node.js (which ships with npx) or run `npm install -g @isteam/mcp`.");
  }
  return {
    program: npx,
    args: ["-y", "@isteam/mcp@latest", "daemon", "run"],
    description: `npx @isteam/mcp@latest daemon run`,
  };
}

/* ------------------------------------------------------------------ */
/*  macOS (launchd)                                                    */
/* ------------------------------------------------------------------ */

function buildPlist(): string {
  const cmd = resolveLaunchCommand();
  const argElements = [cmd.program, ...cmd.args]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
${argElements}
  </array>

  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>

  <key>StandardOutPath</key>
  <string>${DAEMON_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${DAEMON_ERROR_LOG}</string>

  <key>ProcessType</key>
  <string>Interactive</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function launchdInstall(): void {
  const plistPath = launchdPlistPath();
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(plistPath, buildPlist());
  // Reload if already present
  try { execSync(`launchctl bootout gui/$(id -u) ${plistPath} 2>/dev/null`, { stdio: "pipe" }); } catch { /* ignore */ }
  execSync(`launchctl bootstrap gui/$(id -u) ${plistPath}`, { stdio: "pipe" });
  execSync(`launchctl enable gui/$(id -u)/${LAUNCHD_LABEL}`, { stdio: "pipe" });
}

function launchdUninstall(): void {
  const plistPath = launchdPlistPath();
  try { execSync(`launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL} 2>/dev/null`, { stdio: "pipe" }); } catch { /* ignore */ }
  if (existsSync(plistPath)) unlinkSync(plistPath);
}

function launchdControl(verb: "start" | "stop" | "restart"): void {
  const label = `gui/$(id -u)/${LAUNCHD_LABEL}`;
  if (verb === "start")   execSync(`launchctl kickstart ${label}`, { stdio: "pipe" });
  if (verb === "stop")    execSync(`launchctl kill TERM ${label}`, { stdio: "pipe" });
  if (verb === "restart") execSync(`launchctl kickstart -k ${label}`, { stdio: "pipe" });
}

function launchdStatus(): { loaded: boolean; pid: number | null } {
  try {
    const out = execSync(`launchctl print gui/$(id -u)/${LAUNCHD_LABEL} 2>/dev/null`, { stdio: "pipe" }).toString();
    const pidMatch = out.match(/pid\s*=\s*(\d+)/);
    return { loaded: true, pid: pidMatch ? parseInt(pidMatch[1], 10) : null };
  } catch {
    return { loaded: false, pid: null };
  }
}

/* ------------------------------------------------------------------ */
/*  Linux (systemd user)                                               */
/* ------------------------------------------------------------------ */

function buildUnit(): string {
  const cmd = resolveLaunchCommand();
  const execStart = [cmd.program, ...cmd.args].map((a) => /\s/.test(a) ? `"${a}"` : a).join(" ");

  return `[Unit]
Description=is.team MCP daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=10
StandardOutput=append:${DAEMON_LOG}
StandardError=append:${DAEMON_ERROR_LOG}

[Install]
WantedBy=default.target
`;
}

function systemdInstall(): void {
  const unitPath = systemdUnitPath();
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, buildUnit());
  execSync("systemctl --user daemon-reload", { stdio: "pipe" });
  execSync(`systemctl --user enable ${SYSTEMD_UNIT}.service`, { stdio: "pipe" });
  execSync(`systemctl --user start  ${SYSTEMD_UNIT}.service`, { stdio: "pipe" });
}

function systemdUninstall(): void {
  try { execSync(`systemctl --user stop    ${SYSTEMD_UNIT}.service`, { stdio: "pipe" }); } catch { /* ignore */ }
  try { execSync(`systemctl --user disable ${SYSTEMD_UNIT}.service`, { stdio: "pipe" }); } catch { /* ignore */ }
  const unitPath = systemdUnitPath();
  if (existsSync(unitPath)) unlinkSync(unitPath);
  try { execSync("systemctl --user daemon-reload", { stdio: "pipe" }); } catch { /* ignore */ }
}

function systemdControl(verb: "start" | "stop" | "restart"): void {
  execSync(`systemctl --user ${verb} ${SYSTEMD_UNIT}.service`, { stdio: "pipe" });
}

function systemdStatus(): { loaded: boolean; pid: number | null } {
  try {
    const out = execSync(`systemctl --user show ${SYSTEMD_UNIT}.service --no-page`, { stdio: "pipe" }).toString();
    const active = /ActiveState=active/.test(out);
    const pidMatch = out.match(/MainPID=(\d+)/);
    const pid = pidMatch ? parseInt(pidMatch[1], 10) : null;
    return { loaded: active, pid: pid && pid > 0 ? pid : null };
  } catch {
    return { loaded: false, pid: null };
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export type SupportedPlatform = "darwin" | "linux";

export function currentPlatform(): SupportedPlatform | null {
  const p = platform();
  if (p === "darwin" || p === "linux") return p;
  return null;
}

export function installService(): void {
  const p = currentPlatform();
  if (p === "darwin") return launchdInstall();
  if (p === "linux")  return systemdInstall();
  throw new Error(`Unsupported platform: ${platform()}. Daemon mode supports macOS and Linux only.`);
}

export function uninstallService(): void {
  const p = currentPlatform();
  if (p === "darwin") return launchdUninstall();
  if (p === "linux")  return systemdUninstall();
}

export function controlService(verb: "start" | "stop" | "restart"): void {
  const p = currentPlatform();
  if (p === "darwin") return launchdControl(verb);
  if (p === "linux")  return systemdControl(verb);
  throw new Error(`Unsupported platform: ${platform()}`);
}

export function serviceStatus(): { loaded: boolean; pid: number | null; platform: SupportedPlatform | null } {
  const p = currentPlatform();
  if (p === "darwin") return { ...launchdStatus(), platform: p };
  if (p === "linux")  return { ...systemdStatus(), platform: p };
  return { loaded: false, pid: null, platform: null };
}

export function servicePaths(): { service: string; log: string; errorLog: string } {
  const p = currentPlatform();
  return {
    service:  p === "darwin" ? launchdPlistPath() : systemdUnitPath(),
    log:      DAEMON_LOG,
    errorLog: DAEMON_ERROR_LOG,
  };
}

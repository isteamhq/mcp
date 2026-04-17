/**
 * `npx @isteam/mcp daemon <verb>` command dispatcher.
 *
 * Verbs: install | uninstall | start | stop | restart | status | logs | run
 *
 * The `run` verb foreground-runs the daemon (used by launchd/systemd).
 * All other verbs are for user-facing management.
 */

import { spawn } from "child_process";
import { existsSync } from "fs";

import {
  installService,
  uninstallService,
  controlService,
  serviceStatus,
  servicePaths,
  currentPlatform,
} from "./service-installer.js";
import {
  readDaemonConfig,
  DAEMON_LOG,
  DAEMON_ERROR_LOG,
  DAEMON_CONFIG,
} from "./daemon-config.js";

const BOLD  = "\x1b[1m";
const DIM   = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW= "\x1b[33m";
const RED   = "\x1b[31m";
const CYAN  = "\x1b[36m";
const RESET = "\x1b[0m";

function log(msg = ""): void { process.stdout.write(msg + "\n"); }
function success(msg: string) { log(`${GREEN}✓${RESET} ${msg}`); }
function warn(msg: string)    { log(`${YELLOW}⚠${RESET} ${msg}`); }
function error(msg: string)   { log(`${RED}✗${RESET} ${msg}`); }
function info(msg: string)    { log(`${DIM}${msg}${RESET}`); }

function ensurePlatform(): void {
  if (!currentPlatform()) {
    error("Daemon mode is only supported on macOS and Linux.");
    process.exit(1);
  }
}

function ensureConfig(): void {
  if (!readDaemonConfig()) {
    error(`No daemon config at ${DAEMON_CONFIG}.`);
    info("Run `npx @isteam/mcp setup` first and choose 'Yes' when asked to run in background.");
    process.exit(1);
  }
}

function printHelp(): void {
  log("");
  log(`${BOLD}is.team daemon${RESET}`);
  log(`${DIM}${"─".repeat(40)}${RESET}`);
  log("");
  log(`${BOLD}Usage:${RESET} npx @isteam/mcp daemon <verb>`);
  log("");
  log(`${BOLD}Verbs:${RESET}`);
  log(`  ${CYAN}install${RESET}    Install service (launchd/systemd) and start`);
  log(`  ${CYAN}uninstall${RESET}  Stop and remove the service`);
  log(`  ${CYAN}start${RESET}      Start the daemon`);
  log(`  ${CYAN}stop${RESET}       Stop the daemon`);
  log(`  ${CYAN}restart${RESET}    Restart the daemon`);
  log(`  ${CYAN}status${RESET}     Show current status + config summary`);
  log(`  ${CYAN}logs${RESET}       Tail daemon output (--follow to stream)`);
  log(`  ${CYAN}run${RESET}        Run in foreground (used by the service)`);
  log("");
}

function cmdInstall(): void {
  ensurePlatform();
  ensureConfig();

  info("Installing service...");
  try {
    installService();
    const paths = servicePaths();
    success(`Service installed and started (${paths.service}).`);
    log("");
    info("The daemon will now run automatically on login + after crashes.");
    info(`Watch logs: npx @isteam/mcp daemon logs --follow`);
  } catch (e) {
    error(`Install failed: ${String(e)}`);
    process.exit(1);
  }
}

function cmdUninstall(): void {
  ensurePlatform();
  info("Uninstalling service...");
  try {
    uninstallService();
    success("Service removed.");
  } catch (e) {
    error(`Uninstall failed: ${String(e)}`);
    process.exit(1);
  }
}

function cmdControl(verb: "start" | "stop" | "restart"): void {
  ensurePlatform();
  try {
    controlService(verb);
    success(`Daemon ${verb} issued.`);
  } catch (e) {
    error(`${verb} failed: ${String(e)}`);
    process.exit(1);
  }
}

function cmdStatus(): void {
  ensurePlatform();
  const cfg = readDaemonConfig();
  const s = serviceStatus();
  const paths = servicePaths();

  log("");
  log(`${BOLD}is.team daemon status${RESET}`);
  log(`${DIM}${"─".repeat(40)}${RESET}`);
  log("");
  log(`${BOLD}Platform:${RESET}     ${s.platform ?? "unsupported"}`);
  log(`${BOLD}Service:${RESET}      ${s.loaded ? `${GREEN}loaded${RESET}` : `${YELLOW}not loaded${RESET}`}`);
  log(`${BOLD}PID:${RESET}          ${s.pid ?? "—"}`);
  log(`${BOLD}Service file:${RESET} ${paths.service}`);
  log(`${BOLD}Log:${RESET}          ${paths.log}`);
  log(`${BOLD}Error log:${RESET}    ${paths.errorLog}`);
  log("");
  if (cfg) {
    log(`${BOLD}Config:${RESET}`);
    log(`  card:        ${cfg.cardTitle} (${cfg.agentCardId})`);
    log(`  workspace:   ${cfg.workspaceId}`);
    log(`  working dir: ${cfg.workingDir}`);
    log(`  permissions: ${cfg.permissionMode}`);
    log(`  claude:      ${cfg.claudePath}`);
  } else {
    warn(`No config at ${DAEMON_CONFIG} — daemon will not start. Run setup first.`);
  }
  log("");
}

function cmdLogs(follow: boolean): void {
  if (!existsSync(DAEMON_LOG)) {
    warn(`No log file yet at ${DAEMON_LOG}.`);
    info("Logs appear after the daemon runs for the first time.");
    return;
  }
  const args = follow ? ["-f", DAEMON_LOG, DAEMON_ERROR_LOG] : ["-n", "200", DAEMON_LOG];
  const child = spawn("tail", args, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function cmdRun(): void {
  ensureConfig();
  // Delegate to the daemon entry point.
  import("./daemon.js").catch((e) => {
    error(`Daemon failed to start: ${String(e)}`);
    process.exit(1);
  });
}

/* ------------------------------------------------------------------ */

export async function runDaemonCli(argv: string[]): Promise<void> {
  const verb = argv[0];
  switch (verb) {
    case "install":   return cmdInstall();
    case "uninstall": return cmdUninstall();
    case "start":     return cmdControl("start");
    case "stop":      return cmdControl("stop");
    case "restart":   return cmdControl("restart");
    case "status":    return cmdStatus();
    case "logs":      return cmdLogs(argv.includes("--follow") || argv.includes("-f"));
    case "run":       return cmdRun();
    case "help":
    case "--help":
    case "-h":
    case undefined:   return printHelp();
    default:
      error(`Unknown verb: ${verb}`);
      printHelp();
      process.exit(1);
  }
}

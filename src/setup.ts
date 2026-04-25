#!/usr/bin/env node

/**
 * Interactive setup wizard for @isteam/mcp.
 *
 * Usage:
 *   npx @isteam/mcp setup
 *   npx @isteam/mcp setup --token ist_xxx
 *   npx @isteam/mcp setup --token ist_xxx --yes
 */

import { createInterface } from "readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync, spawn } from "child_process";
import { homedir, platform } from "os";

import { writeDaemonConfig, isValidAgentName, type PermissionMode } from "./daemon-config.js";
import { installService, currentPlatform } from "./service-installer.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const BOLD  = "\x1b[1m";
const DIM   = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED   = "\x1b[31m";
const CYAN  = "\x1b[36m";
const RESET = "\x1b[0m";

function log(msg: string) { process.stdout.write(msg + "\n"); }
function success(msg: string) { log(`${GREEN}✓${RESET} ${msg}`); }
function warn(msg: string) { log(`${YELLOW}⚠${RESET} ${msg}`); }
function error(msg: string) { log(`${RED}✗${RESET} ${msg}`); }
function info(msg: string) { log(`${DIM}${msg}${RESET}`); }

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function confirm(question: string): Promise<boolean> {
  const answer = await ask(`${question} ${DIM}(y/n)${RESET} `);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}

async function selectFromList<T>(
  question: string,
  options: Array<{ label: string; value: T }>,
): Promise<T> {
  log(question);
  options.forEach((opt, i) => log(`  ${BOLD}${i + 1}${RESET}. ${opt.label}`));
  for (;;) {
    const answer = await ask(`${BOLD}Choice [1-${options.length}]:${RESET} `);
    const n = parseInt(answer, 10);
    if (Number.isFinite(n) && n >= 1 && n <= options.length) {
      return options[n - 1].value;
    }
    warn(`Invalid choice. Enter 1-${options.length}.`);
  }
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function resolveClaudePath(): string {
  try {
    const p = execSync("which claude", { stdio: "pipe" }).toString().trim();
    if (p) return p;
  } catch { /* ignore */ }
  return "claude";
}

/**
 * Ask the user for an agent name (1–6 chars). Loops until input validates.
 * In --yes mode, synthesize a random one to keep non-interactive callers
 * (CI, scripts) working without prompting.
 */
async function askAgentName(yesMode: boolean): Promise<string> {
  if (yesMode) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let id = "";
    for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
    info(`--yes mode: auto-generated agent name ${id}`);
    return id;
  }
  for (;;) {
    const raw = await ask(`${BOLD}Agent name (max 6 chars):${RESET} `);
    const norm = raw.trim().toUpperCase();
    if (isValidAgentName(norm)) return norm;
    warn("Must be 1-6 alphanumeric characters (A-Z, 0-9). Try again.");
  }
}

/* ------------------------------------------------------------------ */
/*  Parse args                                                         */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);
// Remove "setup" if present (npx @isteam/mcp setup --token ...)
const filteredArgs = args.filter((a) => a !== "setup");

let argToken: string | null = null;
let argYes = false;

for (let i = 0; i < filteredArgs.length; i++) {
  if (filteredArgs[i] === "--token" && filteredArgs[i + 1]) {
    argToken = filteredArgs[i + 1];
    i++;
  } else if (filteredArgs[i] === "--yes" || filteredArgs[i] === "-y") {
    argYes = true;
  }
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  log("");
  log(`${BOLD}🤖 is.team MCP Setup${RESET}`);
  log(`${DIM}${"─".repeat(40)}${RESET}`);
  log("");

  // Step 1: Confirm directory
  const cwd = process.cwd();
  if (!argYes) {
    log(`${BOLD}Project directory:${RESET} ${cwd}`);
    log("");
    const ok = await confirm("Run setup in this directory?");
    if (!ok) {
      info("Cancelled. Navigate to your project directory first, then run again.");
      process.exit(0);
    }
    log("");
  }

  // Step 2: Check Claude CLI
  log(`${BOLD}Checking prerequisites...${RESET}`);
  if (commandExists("claude")) {
    success("Claude CLI found");
  } else {
    error("Claude CLI not found");
    log("");
    log("  Install Claude CLI:");
    log(`  ${CYAN}https://docs.anthropic.com/en/docs/claude-code/getting-started${RESET}`);
    log("");
    log("  After installing, run this setup again.");
    process.exit(1);
  }

  // Check Node.js
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1), 10);
  if (major >= 18) {
    success(`Node.js ${nodeVersion}`);
  } else {
    error(`Node.js ${nodeVersion} — version 18+ required`);
    process.exit(1);
  }

  log("");

  // Step 3: Get token
  let token = argToken;
  if (!token) {
    log(`${BOLD}API Token${RESET}`);
    log(`Get your token: ${CYAN}https://is.team${RESET} → Account Settings → API tab`);
    log("");
    token = await ask(`${BOLD}Paste your token:${RESET} `);
    if (!token || !token.startsWith("ist_")) {
      error("Invalid token. Tokens start with 'ist_'");
      process.exit(1);
    }
    log("");
  }

  // Step 4: Validate token
  log(`${BOLD}Validating token...${RESET}`);
  try {
    const res = await fetch("https://is.team/api/mcp/auth", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      success("Token valid");
    } else {
      error("Token invalid or expired. Generate a new one at is.team → Account Settings → API");
      process.exit(1);
    }
  } catch {
    error("Could not reach is.team. Check your internet connection.");
    process.exit(1);
  }

  log("");

  // Step 5: Ask for agent name (mandatory)
  log(`${BOLD}Agent name${RESET}`);
  log("Pick a label (up to 6 characters) that identifies this terminal in the is.team dashboard.");
  log(`Examples: ${DIM}ME, DEV, HOME01, LAPTP1, PROD01${RESET}. Uppercase letters and digits only.`);
  log("Use a different name in each project/terminal so you can tell your agents apart.");
  log("");

  const agentName = await askAgentName(argYes);
  log("");

  // Step 6: Create/update .mcp.json
  log(`${BOLD}Configuring MCP...${RESET}`);
  const mcpConfigPath = join(cwd, ".mcp.json");
  let mcpConfig: Record<string, unknown> = {};

  if (existsSync(mcpConfigPath)) {
    try {
      mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
      info("Existing .mcp.json found — adding is-team server");
    } catch {
      info("Invalid .mcp.json — creating new one");
    }
  }

  const servers = (mcpConfig.mcpServers ?? {}) as Record<string, unknown>;
  servers["is-team"] = {
    command: "npx",
    args: ["-y", "@isteam/mcp"],
    env: {
      IST_API_TOKEN: token,
      IST_AGENT_NAME: agentName,
    },
  };
  mcpConfig.mcpServers = servers;

  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + "\n");
  success(`.mcp.json configured (agent name: ${agentName})`);

  // Step 6: Update Claude settings for auto-accept
  const claudeSettingsDir = join(homedir(), ".claude");
  const claudeSettingsPath = join(claudeSettingsDir, "settings.json");
  let claudeSettings: Record<string, unknown> = {};

  if (!existsSync(claudeSettingsDir)) {
    mkdirSync(claudeSettingsDir, { recursive: true });
  }

  if (existsSync(claudeSettingsPath)) {
    try {
      claudeSettings = JSON.parse(readFileSync(claudeSettingsPath, "utf-8"));
    } catch { /* start fresh */ }
  }

  // Add mcp__is-team__* to allowedTools
  const allowedTools = (claudeSettings.allowedTools ?? []) as string[];
  const mcpPattern = "mcp__is-team__*";
  if (!allowedTools.includes(mcpPattern)) {
    allowedTools.push(mcpPattern);
    claudeSettings.allowedTools = allowedTools;
    writeFileSync(claudeSettingsPath, JSON.stringify(claudeSettings, null, 2) + "\n");
    success("Claude permissions configured (auto-accept is.team tools)");
  } else {
    success("Claude permissions already configured");
  }

  log("");

  // Step 7: Run in background? (daemon mode)
  const canDaemon = !!currentPlatform();
  if (canDaemon && !argYes) {
    log(`${BOLD}Background mode${RESET}`);
    log("Run Claude as a persistent daemon: survives terminal closure, auto-restarts on crash,");
    log("and auto-executes any task assigned to a chosen card. You control it entirely from is.team.");
    log("");

    const wantsDaemon = await confirm("Run in background as a daemon?");
    log("");

    if (wantsDaemon) {
      await setupDaemon(token, cwd, agentName);
      return;
    }
  } else if (!canDaemon) {
    info(`Background mode skipped — ${platform()} is not supported yet (macOS/Linux only).`);
    log("");
  }

  // Step 8: Autonomy mode (foreground path)
  log(`${BOLD}Autonomy Mode${RESET}`);
  log("When enabled, Claude will auto-approve all tool calls (file edits, bash commands, etc.).");
  log("You can control the agent entirely from the card chat — no terminal interaction needed.");
  log("");

  const enableAutonomy = argYes || await confirm("Enable full autonomy mode? (recommended for MCP agents)");
  log("");

  // Step 9: Launch Claude
  log(`${BOLD}Starting Claude with MCP streaming...${RESET}`);
  if (enableAutonomy) {
    success("Autonomy mode enabled — all permissions auto-approved");
  }
  log("");
  log(`${BOLD}How to use the agent live:${RESET}`);
  log(`  ${DIM}•${RESET} Open the workspace in is.team — your agent ${BOLD}${agentName}${RESET} appears in the top-right team panel.`);
  log(`  ${DIM}•${RESET} Drag it onto a card to start chatting; messages flow into ${CYAN}card chat${RESET}, not this terminal.`);
  log(`  ${DIM}•${RESET} Add tasks to the card — the agent picks them up automatically.`);
  log(`  ${DIM}•${RESET} Press ${CYAN}Ctrl+C${RESET} here to stop the agent and free its slot in the workspace.`);
  log(`  ${DIM}•${RESET} Closing this terminal also stops the agent. To keep it alive across reboots,`);
  log(`     re-run setup and answer ${BOLD}yes${RESET} to background mode.`);
  log("");

  const claudeArgs = ["--dangerously-load-development-channels", "server:is-team"];
  if (enableAutonomy) {
    claudeArgs.push("--dangerously-skip-permissions");
  }

  const claude = spawn("claude", claudeArgs, {
    stdio: "inherit",
    cwd,
  });

  claude.on("error", () => {
    error("Failed to start Claude. Make sure it's installed and in your PATH.");
    process.exit(1);
  });

  claude.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

/* ------------------------------------------------------------------ */
/*  Daemon setup flow                                                  */
/* ------------------------------------------------------------------ */

interface CardSummary {
  cardId: string;
  title: string;
  workspace: string;
  board: string;
  workspaceId: string;
  boardId: string;
  nodeId: string;
}

async function fetchCards(token: string): Promise<CardSummary[]> {
  const res = await fetch("https://is.team/api/mcp/exec", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "list_cards" }),
  });
  if (!res.ok) throw new Error(`list_cards failed: ${res.status}`);
  const text = await res.text();
  try {
    const json = JSON.parse(text) as { cards?: CardSummary[] };
    return json.cards ?? [];
  } catch {
    throw new Error("list_cards returned non-JSON response");
  }
}

async function setupDaemon(token: string, cwd: string, agentName: string): Promise<void> {
  log(`${BOLD}Daemon setup${RESET}`);
  log(`${DIM}${"─".repeat(40)}${RESET}`);
  log("");

  // Pick workspace (cards endpoint is the cheapest way to enumerate workspaces
  // the user has access to — we dedup by workspaceId)
  log("Fetching your workspaces...");
  let cards: CardSummary[];
  try {
    cards = await fetchCards(token);
  } catch (e) {
    error(`Failed to list workspaces: ${String(e)}`);
    process.exit(1);
  }
  const workspaces = Array.from(
    new Map(cards.map((c) => [c.workspaceId, { workspaceId: c.workspaceId, name: c.workspace }])).values(),
  );
  if (workspaces.length === 0) {
    error("No workspaces with LLM access found.");
    info("Open is.team, create a card with LLM access enabled, then run setup again.");
    process.exit(1);
  }

  log("");
  let workspaceId: string;
  let workspaceName: string;
  if (workspaces.length === 1) {
    workspaceId   = workspaces[0].workspaceId;
    workspaceName = workspaces[0].name;
    info(`Using your only workspace: ${BOLD}${workspaceName}${RESET}`);
  } else {
    const chosen = await selectFromList(
      `${BOLD}Which workspace should this agent join?${RESET}`,
      workspaces.map((w) => ({ label: w.name, value: w })),
    );
    workspaceId   = chosen.workspaceId;
    workspaceName = chosen.name;
  }
  log("");

  // Permission mode
  const permissionMode: PermissionMode = await selectFromList(
    `${BOLD}Permission mode for Claude subprocesses:${RESET}`,
    [
      { label: `acceptEdits ${DIM}— auto-approve file edits, prompt for shell commands (recommended)${RESET}`, value: "acceptEdits" },
      { label: `bypassPermissions ${DIM}— fully autonomous, no prompts (risky, use only on trusted cards)${RESET}`, value: "bypassPermissions" },
      { label: `plan ${DIM}— planning mode only, no writes${RESET}`, value: "plan" },
    ],
  );
  log("");

  // Working directory
  const wdAnswer = await ask(`${BOLD}Working directory${RESET} ${DIM}(default: ${cwd})${RESET}: `);
  const workingDir = wdAnswer.trim() || cwd;
  if (!existsSync(workingDir)) {
    error(`Directory does not exist: ${workingDir}`);
    process.exit(1);
  }
  log("");

  // Persist config — no card baked in; agent starts idle and the user assigns
  // it from the workspace UI by dragging the agent badge onto a card.
  const claudePath = resolveClaudePath();
  writeDaemonConfig({
    token,
    agentName,
    workspaceId,
    workingDir,
    permissionMode,
    claudePath,
  });
  success(`Config written to ~/.isteam/daemon.json (agent name: ${agentName})`);

  // Install service
  log("");
  log(`${BOLD}Installing service...${RESET}`);
  try {
    installService();
    success("Service installed and started");
  } catch (e) {
    error(`Service install failed: ${String(e)}`);
    info("You can retry with: npx @isteam/mcp daemon install");
    process.exit(1);
  }

  log("");
  log(`${GREEN}${BOLD}✓ Daemon is running${RESET}`);
  log("");
  log(`Agent ${BOLD}${agentName}${RESET} is now online in workspace ${BOLD}${workspaceName}${RESET},`);
  log(`waiting in the team-members panel for an assignment.`);
  log("");
  log(`${BOLD}How to use it:${RESET}`);
  log(`  ${DIM}1.${RESET} Open the workspace in is.team — your agent appears in the top-right team panel.`);
  log(`  ${DIM}2.${RESET} Drag the agent badge onto any card to assign it. Tasks added to that card`);
  log(`     will be picked up and executed automatically.`);
  log(`  ${DIM}3.${RESET} Drag the agent off the card (or remove the assignment) to park it as idle.`);
  log(`  ${DIM}4.${RESET} The agent keeps running after you close this terminal.`);
  log("");
  log(`${BOLD}Daemon commands:${RESET}`);
  log(`  ${CYAN}npx @isteam/mcp daemon status${RESET}      check daemon state`);
  log(`  ${CYAN}npx @isteam/mcp daemon logs --follow${RESET} tail output`);
  log(`  ${CYAN}npx @isteam/mcp daemon restart${RESET}     restart daemon`);
  log(`  ${CYAN}npx @isteam/mcp daemon stop${RESET}        stop the daemon`);
  log(`  ${CYAN}npx @isteam/mcp daemon uninstall${RESET}   remove the daemon entirely`);
  log("");
}

main().catch((e) => {
  error(String(e));
  process.exit(1);
});

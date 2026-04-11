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
import { homedir } from "os";

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

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
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

  // Step 5: Create/update .mcp.json
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
    },
  };
  mcpConfig.mcpServers = servers;

  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + "\n");
  success(".mcp.json configured");

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

  // Step 7: Ask about autonomy mode
  log(`${BOLD}Autonomy Mode${RESET}`);
  log("When enabled, Claude will auto-approve all tool calls (file edits, bash commands, etc.).");
  log("You can control the agent entirely from the card chat — no terminal interaction needed.");
  log("");

  const enableAutonomy = argYes || await confirm("Enable full autonomy mode? (recommended for MCP agents)");
  log("");

  // Step 8: Launch Claude
  log(`${BOLD}Starting Claude with MCP streaming...${RESET}`);
  if (enableAutonomy) {
    success("Autonomy mode enabled — all permissions auto-approved");
  }
  log(`${DIM}Press Ctrl+C to stop${RESET}`);
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

main().catch((e) => {
  error(String(e));
  process.exit(1);
});

#!/usr/bin/env node
/**
 * is.team MCP daemon.
 *
 * Long-running process (one per installed agent) that watches an is.team
 * card for newly-assigned tasks and dispatches each one to a headless
 * `claude --print` subprocess. Output is streamed back to the card chat
 * so the user can monitor progress from the UI without a terminal open.
 *
 * Managed by launchd (macOS) or systemd (Linux). Not meant to be invoked
 * directly by end-users — the CLI subcommands handle install/start/stop.
 */

import { spawn } from "child_process";
import { appendFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";

import { initializeApp } from "firebase/app";
import { getAuth, signInWithCustomToken } from "firebase/auth";
import { getFirestore, doc, onSnapshot, type Unsubscribe } from "firebase/firestore";
import {
  getDatabase,
  ref as rtdbRef,
  set as rtdbSet,
  update as rtdbUpdate,
  remove as rtdbRemove,
  onDisconnect,
  get as rtdbGet,
} from "firebase/database";

import {
  readDaemonConfig,
  ensureIsteamDir,
  DAEMON_LOG,
  DAEMON_ERROR_LOG,
  DAEMON_PID_FILE,
  DAEMON_QUEUE_DIR,
  type DaemonConfig,
} from "./daemon-config.js";

/* ------------------------------------------------------------------ */
/*  Bootstrap                                                          */
/* ------------------------------------------------------------------ */

ensureIsteamDir();
writeFileSync(DAEMON_PID_FILE, String(process.pid));

const cfgOrNull = readDaemonConfig();
if (!cfgOrNull) {
  logError("No daemon config found at ~/.isteam/daemon.json — run `npx @isteam/mcp setup` first.");
  process.exit(1);
}
// At this point TS still sees cfgOrNull as possibly null after process.exit;
// re-bind to a non-null const so the rest of the file keeps working cleanly.
const cfg: DaemonConfig = cfgOrNull;

const BASE_URL = cfg.baseUrl ?? "https://is.team";

/* ------------------------------------------------------------------ */
/*  Logging                                                            */
/* ------------------------------------------------------------------ */

function ts(): string {
  return new Date().toISOString();
}

function logInfo(msg: string): void {
  const line = `[${ts()}] ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(DAEMON_LOG, line); } catch { /* ignore */ }
}

function logError(msg: string): void {
  const line = `[${ts()}] ERROR ${msg}\n`;
  process.stderr.write(line);
  try { appendFileSync(DAEMON_ERROR_LOG, line); } catch { /* ignore */ }
}

process.on("uncaughtException", (err) => {
  logError(`uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});
process.on("unhandledRejection", (reason) => {
  logError(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});

logInfo(`daemon starting — agent card ${cfg.agentCardId} (${cfg.cardTitle}) in workspace ${cfg.workspaceId}`);
logInfo(`working directory: ${cfg.workingDir}`);
logInfo(`permission mode: ${cfg.permissionMode}`);
logInfo(`claude path: ${cfg.claudePath}`);

/* ------------------------------------------------------------------ */
/*  Firebase                                                           */
/* ------------------------------------------------------------------ */

const firebaseConfig = {
  apiKey:            "AIzaSyAtVm8c_16pHqS7855CSuPwFpvRm7sD_RQ",
  authDomain:        "auth.is.team",
  projectId:         "isteam-3c6d7",
  storageBucket:     "isteam-3c6d7.firebasestorage.app",
  messagingSenderId: "874701522516",
  appId:             "1:874701522516:web:11861df4a6b0860956cfc1",
  databaseURL:       "https://isteam-3c6d7-default-rtdb.europe-west1.firebasedatabase.app",
};

const app    = initializeApp(firebaseConfig);
const auth   = getAuth(app);
const db     = getFirestore(app);
const rtdb   = getDatabase(app);

const FIREBASE_TOKEN_TTL = 55 * 60 * 1000;
let authTime = 0;

async function ensureAuth(): Promise<void> {
  if (auth.currentUser && Date.now() - authTime < FIREBASE_TOKEN_TTL) return;

  const res = await fetch(`${BASE_URL}/api/mcp/auth`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok) throw new Error(`Firebase auth failed: ${res.status} ${res.statusText}`);

  const { customToken } = (await res.json()) as { customToken: string };
  await signInWithCustomToken(auth, customToken);
  authTime = Date.now();
  logInfo("firebase authenticated");
}

/* ------------------------------------------------------------------ */
/*  Agent session presence (so the UI shows the agent as online)       */
/* ------------------------------------------------------------------ */

const SESSION_ID = `daemon-${process.pid}-${Date.now()}`;
const AGENT_ID   = "DMN" + Math.random().toString(36).slice(2, 4).toUpperCase();
const SESSION_ROOT = "agentSessions";
const PRESENCE_ROOT = "aiPresence";

async function writeSession(): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) return;

  // Remove any stale sessions for this uid
  const wsRef = rtdbRef(rtdb, `${SESSION_ROOT}/${cfg.workspaceId}`);
  const snap = await rtdbGet(wsRef);
  if (snap.exists()) {
    const sessions = snap.val() as Record<string, { uid?: string }>;
    for (const [sid, data] of Object.entries(sessions)) {
      if (data.uid === uid && sid !== SESSION_ID) {
        await rtdbRemove(rtdbRef(rtdb, `${SESSION_ROOT}/${cfg.workspaceId}/${sid}`));
      }
    }
  }

  const sessionRef = rtdbRef(rtdb, `${SESSION_ROOT}/${cfg.workspaceId}/${SESSION_ID}`);
  await rtdbSet(sessionRef, {
    uid,
    agentId: AGENT_ID,
    mode: "daemon",
    status: "subscribed",
    assignedCard: { cardId: cfg.agentCardId, boardId: cfg.boardId, nodeId: cfg.nodeId },
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
  });
  await onDisconnect(sessionRef).remove();

  const presenceRef = rtdbRef(rtdb, `${PRESENCE_ROOT}/${cfg.workspaceId}/${cfg.nodeId}/${uid}`);
  await rtdbSet(presenceRef, { active: true, subscribedAt: Date.now(), daemon: true });
  await onDisconnect(presenceRef).remove();
}

async function setStatus(status: "idle" | "working" | "subscribed"): Promise<void> {
  const sessionRef = rtdbRef(rtdb, `${SESSION_ROOT}/${cfg.workspaceId}/${SESSION_ID}`);
  await rtdbUpdate(sessionRef, { status, lastHeartbeat: Date.now() }).catch(() => {});
}

setInterval(() => {
  ensureAuth()
    .then(() => writeSession())
    .catch((e) => logError(`heartbeat failed: ${String(e)}`));
}, 30_000);

/* ------------------------------------------------------------------ */
/*  API relay helpers                                                   */
/* ------------------------------------------------------------------ */

async function apiExec(tool: string, cardId: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/mcp/exec`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tool, cardId, args }),
  });
  const text = await res.text();
  if (!res.ok) {
    logError(`apiExec ${tool} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return text;
}

async function postChat(msg: string): Promise<void> {
  await apiExec("chat_respond", cfg.agentCardId, { content: msg }).catch((e) =>
    logError(`postChat failed: ${String(e)}`),
  );
}

/* ------------------------------------------------------------------ */
/*  Task queue                                                          */
/* ------------------------------------------------------------------ */

interface QueuedTask {
  id: string;
  taskNumber: number;
  title: string;
}

const queue: QueuedTask[] = [];
const processedTaskIds = new Set<string>();
let working = false;

function queueFile(taskId: string): string {
  return join(DAEMON_QUEUE_DIR, `${taskId}.json`);
}

function persistQueueEntry(t: QueuedTask): void {
  try { writeFileSync(queueFile(t.id), JSON.stringify(t)); } catch { /* ignore */ }
}

function removeQueueEntry(taskId: string): void {
  try { if (existsSync(queueFile(taskId))) unlinkSync(queueFile(taskId)); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/*  Claude spawn                                                        */
/* ------------------------------------------------------------------ */

function buildPrompt(task: QueuedTask): string {
  return [
    `You are the is.team autonomous agent assigned to card "${cfg.cardTitle}" (id: ${cfg.agentCardId}).`,
    ``,
    `A new task has been assigned to you:`,
    `  #${task.taskNumber} — ${task.title}`,
    `  task id: ${task.id}`,
    ``,
    `Do the following, in order:`,
    `  1. Call the read_card tool with cardId "${cfg.agentCardId}" to see the task's full description, connected cards, and available move targets.`,
    `  2. Work on the task using whatever tools you need (file edits, shell commands, web searches, etc.). When you need to ask the user a question, use ask_chat — they are monitoring the card chat, not the terminal.`,
    `  3. When the task is complete, use complete_task with the task number and move it to the appropriate connected card (usually "Done" or the next pipeline stage).`,
    `  4. Post a short chat summary (via chat_respond) describing what you did.`,
    ``,
    `Stay focused on this single task. Do not touch other tasks on the card.`,
  ].join("\n");
}

function runClaude(task: QueuedTask): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const args = [
      "--print",
      "--permission-mode", cfg.permissionMode,
    ];
    if (cfg.permissionMode === "bypassPermissions") {
      // Claude expects --dangerously-skip-permissions for fully autonomous mode
      args.push("--dangerously-skip-permissions");
    }
    args.push(buildPrompt(task));

    logInfo(`spawning claude for task #${task.taskNumber} (id ${task.id})`);

    const child = spawn(cfg.claudePath, args, {
      cwd: cfg.workingDir,
      env: { ...process.env, IST_API_TOKEN: cfg.token },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      const s = chunk.toString();
      stdout += s;
      try { appendFileSync(DAEMON_LOG, s); } catch { /* ignore */ }
    });
    child.stderr?.on("data", (chunk) => {
      const s = chunk.toString();
      stderr += s;
      try { appendFileSync(DAEMON_ERROR_LOG, s); } catch { /* ignore */ }
    });

    const timeout = setTimeout(() => {
      logError(`task #${task.taskNumber} timed out after 30 minutes — killing`);
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, 30 * 60 * 1000);

    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Worker                                                              */
/* ------------------------------------------------------------------ */

async function processQueue(): Promise<void> {
  if (working) return;
  const task = queue.shift();
  if (!task) return;
  working = true;
  await setStatus("working");

  logInfo(`→ starting task #${task.taskNumber}: ${task.title}`);
  await postChat(`🤖 Agent started task #${task.taskNumber} — ${task.title}`);

  try {
    const { exitCode, stdout } = await runClaude(task);
    removeQueueEntry(task.id);

    const summary = stdout.trim().slice(-1500) || "(no output)";
    if (exitCode === 0) {
      logInfo(`✓ task #${task.taskNumber} completed`);
      await postChat(`✅ Agent finished task #${task.taskNumber}.\n\n\`\`\`\n${summary}\n\`\`\``);
    } else {
      logError(`✗ task #${task.taskNumber} exited ${exitCode}`);
      await postChat(`⚠️ Agent exited with code ${exitCode} on task #${task.taskNumber}. Check daemon logs.\n\n\`\`\`\n${summary}\n\`\`\``);
    }
  } catch (err) {
    logError(`task #${task.taskNumber} failed: ${String(err)}`);
    await postChat(`⚠️ Agent crashed on task #${task.taskNumber}: ${String(err)}`);
  } finally {
    working = false;
    await setStatus("subscribed");
    // Drain the rest of the queue without starving the event loop
    if (queue.length > 0) setImmediate(() => processQueue());
  }
}

/* ------------------------------------------------------------------ */
/*  Firestore subscription                                              */
/* ------------------------------------------------------------------ */

let nodeUnsub: Unsubscribe | null = null;
let initialLoad = true;

type TaskEntry = { id: string; title?: string; taskNumber?: number };

async function subscribe(): Promise<void> {
  await ensureAuth();
  await writeSession();
  await setStatus("subscribed");

  const nodeRef = doc(db, "workspaces", cfg.workspaceId, "boards", cfg.boardId, "canvasNodes", cfg.nodeId);

  nodeUnsub = onSnapshot(nodeRef, (snap) => {
    if (!snap.exists()) {
      logError("agent card not found — did it get deleted?");
      return;
    }
    const data = snap.data() as { data?: { tasks?: TaskEntry[] } };
    const tasks = data.data?.tasks ?? [];

    if (initialLoad) {
      for (const t of tasks) processedTaskIds.add(t.id);
      initialLoad = false;
      logInfo(`baseline set: ${processedTaskIds.size} existing tasks ignored`);
      return;
    }

    for (const t of tasks) {
      if (processedTaskIds.has(t.id)) continue;
      processedTaskIds.add(t.id);
      const entry: QueuedTask = {
        id: t.id,
        taskNumber: t.taskNumber ?? 0,
        title: t.title ?? "(untitled)",
      };
      persistQueueEntry(entry);
      queue.push(entry);
      logInfo(`queued task #${entry.taskNumber}: ${entry.title}`);
    }

    // Also clear processed set for tasks that left the card
    const currentIds = new Set(tasks.map((t) => t.id));
    for (const id of processedTaskIds) {
      if (!currentIds.has(id)) processedTaskIds.delete(id);
    }

    if (!working && queue.length > 0) processQueue();
  }, (err) => {
    logError(`firestore listener error: ${String(err)}`);
  });

  logInfo(`subscribed to card ${cfg.agentCardId}`);
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                           */
/* ------------------------------------------------------------------ */

async function shutdown(signal: string): Promise<void> {
  logInfo(`shutdown (${signal})`);
  if (nodeUnsub) nodeUnsub();
  try {
    const sessionRef = rtdbRef(rtdb, `${SESSION_ROOT}/${cfg.workspaceId}/${SESSION_ID}`);
    await rtdbRemove(sessionRef);
    const uid = auth.currentUser?.uid;
    if (uid) {
      const presenceRef = rtdbRef(rtdb, `${PRESENCE_ROOT}/${cfg.workspaceId}/${cfg.nodeId}/${uid}`);
      await rtdbRemove(presenceRef);
    }
  } catch (e) {
    logError(`shutdown cleanup failed: ${String(e)}`);
  }
  try { if (existsSync(DAEMON_PID_FILE)) unlinkSync(DAEMON_PID_FILE); } catch { /* ignore */ }
  process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

subscribe().catch((err) => {
  logError(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});

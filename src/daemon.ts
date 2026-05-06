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
import {
  getFirestore,
  doc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  type Unsubscribe,
} from "firebase/firestore";
import {
  getDatabase,
  ref as rtdbRef,
  set as rtdbSet,
  update as rtdbUpdate,
  remove as rtdbRemove,
  onDisconnect,
  onValue,
  get as rtdbGet,
} from "firebase/database";

import {
  readDaemonConfig,
  ensureIsteamDir,
  isValidAgentName,
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

if (cfg.agentCardId) {
  logInfo(`daemon starting — agent card ${cfg.agentCardId} (${cfg.cardTitle}) in workspace ${cfg.workspaceId}`);
} else {
  logInfo(`daemon starting — idle in workspace ${cfg.workspaceId}, waiting for UI assignment`);
}
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
const AGENT_ID   = isValidAgentName(cfg.agentName)
  ? cfg.agentName
  : (() => {
      // Old configs won't have agentName — synthesize a deterministic fallback
      // from whatever stable id is available so the badge stays consistent
      // across restarts.
      const seed = (cfg.agentCardId ?? cfg.workspaceId ?? "AGENT0").slice(-5).toUpperCase().padStart(5, "0");
      return ("D" + seed).slice(0, 6);
    })();
const SESSION_ROOT = "agentSessions";
const PRESENCE_ROOT = "aiPresence";

/**
 * Shared state — `currentCard` is the card this daemon is actively watching
 * (mirrored to RTDB as the session's `assignedCard`). `null` means the
 * daemon is running but idle (visible in team-members panel, ready to be
 * dragged onto a card from the UI). Mutated by attachCard/detachCard/goIdle.
 */
let currentCard: { cardId: string; boardId: string; nodeId: string } | null = null;

/**
 * One-time (at startup) + defensive (after token refresh that wiped our
 * session): clear stale sessions for this uid and write the full session
 * record reflecting `currentCard`. Does not touch the Firestore card
 * listener — attachCard owns that.
 */
async function initSession(): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) return;

  // Remove ONLY zombie sessions for this uid (no heartbeat in > 2 minutes).
  // Never remove other live sessions — a user can legitimately run both a
  // daemon and a stdio MCP (via Claude Code) at the same time, with
  // different SESSION_IDs. If we blindly wiped peers, the two would
  // ping-pong deleting each other every 30s.
  const STALE_THRESHOLD = 2 * 60 * 1000;
  const wsRef = rtdbRef(rtdb, `${SESSION_ROOT}/${cfg.workspaceId}`);
  const snap = await rtdbGet(wsRef);
  if (snap.exists()) {
    const sessions = snap.val() as Record<string, { uid?: string; lastHeartbeat?: number }>;
    const now = Date.now();
    for (const [sid, data] of Object.entries(sessions)) {
      const stale = now - (data.lastHeartbeat ?? 0) > STALE_THRESHOLD;
      if (data.uid === uid && sid !== SESSION_ID && stale) {
        await rtdbRemove(rtdbRef(rtdb, `${SESSION_ROOT}/${cfg.workspaceId}/${sid}`));
      }
    }
  }

  const sessionRef = rtdbRef(rtdb, `${SESSION_ROOT}/${cfg.workspaceId}/${SESSION_ID}`);
  await rtdbSet(sessionRef, {
    uid,
    agentId: AGENT_ID,
    mode: "daemon",
    status: currentCard ? "subscribed" : "idle",
    assignedCard: currentCard,
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
  });
  await onDisconnect(sessionRef).remove();

  if (currentCard) {
    const presenceRef = rtdbRef(rtdb, `${PRESENCE_ROOT}/${cfg.workspaceId}/${currentCard.nodeId}/${uid}`);
    await rtdbSet(presenceRef, { active: true, subscribedAt: Date.now(), daemon: true });
    await onDisconnect(presenceRef).remove();
  }
}

/**
 * Periodic: only touch `lastHeartbeat`. Must NOT overwrite `assignedCard` or
 * `status` — the UI flips those to reassign the daemon between cards or park
 * it as idle. Re-writing the full session would fight the UI and make the
 * badge flicker.
 *
 * Also re-registers onDisconnect handlers after token refresh (the WebSocket
 * reconnect fires any stale onDisconnect and may remove the session).
 */
async function heartbeat(): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) return;

  const sessionRef = rtdbRef(rtdb, `${SESSION_ROOT}/${cfg.workspaceId}/${SESSION_ID}`);
  const snap = await rtdbGet(sessionRef);

  // Session was removed (stale onDisconnect after token refresh, network blip,
  // etc.) — recreate it. initSession writes based on `currentCard` so the
  // restored session reflects our real state (subscribed vs idle).
  if (!snap.exists()) {
    logInfo("session lost — re-initializing");
    await initSession();
    return;
  }

  await rtdbUpdate(sessionRef, { lastHeartbeat: Date.now() });
  await onDisconnect(sessionRef).remove();

  if (currentCard) {
    // Always re-set presence (not just re-register onDisconnect). A stale
    // onDisconnect can wipe it on a websocket reconnect; if we only refresh
    // the handler the badge stays gone until the next attachCard, which means
    // the frontend's `useAiPresence` flips to false and routes the user's
    // chat to the built-in Gemini path instead of our daemon. Idempotent
    // write is cheap and fixes the flapping.
    const presenceRef = rtdbRef(rtdb, `${PRESENCE_ROOT}/${cfg.workspaceId}/${currentCard.nodeId}/${uid}`);
    await rtdbSet(presenceRef, { active: true, subscribedAt: Date.now(), daemon: true });
    await onDisconnect(presenceRef).remove();
  }
}

async function setStatus(status: "idle" | "working" | "subscribed"): Promise<void> {
  const sessionRef = rtdbRef(rtdb, `${SESSION_ROOT}/${cfg.workspaceId}/${SESSION_ID}`);
  await rtdbUpdate(sessionRef, { status, lastHeartbeat: Date.now() }).catch(() => {});
}

let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

heartbeatInterval = setInterval(() => {
  ensureAuth()
    .then(() => heartbeat())
    .catch((e) => logError(`heartbeat failed: ${String(e)}`));
}, 30_000);

/**
 * Listen to our own session. The UI can set `assignedCard: null` to detach
 * the agent — when that happens we clean up and exit. launchd/systemd are
 * configured to NOT restart on a clean exit (code 0), so this acts as the
 * user-facing "stop the daemon from the web UI" control.
 */
let sessionWatchUnsub: Unsubscribe | null = null;
let connectWatchUnsub: Unsubscribe | null = null;

/**
 * Firebase RTDB fires server-side `onDisconnect` handlers on every WebSocket
 * drop — including the idle/keepalive reconnects that happen every few
 * minutes. That wipes our session + presence, making the badge flicker until
 * the next 30s heartbeat restores it. Hook `.info/connected` so we re-write
 * state the instant the WS comes back up, syncing to whatever the UI set
 * while we were offline (could be a different card, could be idle).
 */
function watchConnection(): void {
  let connectedOnce = false;
  connectWatchUnsub = onValue(rtdbRef(rtdb, ".info/connected"), (snap) => {
    const connected = snap.val() === true;
    if (!connected) return;
    if (!connectedOnce) { connectedOnce = true; return; }
    void (async () => {
      try {
        const sessionRef = rtdbRef(rtdb, `${SESSION_ROOT}/${cfg.workspaceId}/${SESSION_ID}`);
        const cur = await rtdbGet(sessionRef);

        // Our own server-side onDisconnect wiped the session. Recreate from
        // `currentCard` (our authoritative local state).
        if (!cur.exists()) {
          logInfo("WS reconnected — session wiped, restoring from local state");
          await initSession();
          return;
        }

        // Session exists — the UI may have changed `assignedCard` while we
        // were offline. Reconcile local state to whatever the UI set.
        const val = cur.val() as { assignedCard?: { cardId: string; boardId: string; nodeId: string } | null };
        const uiCard = val.assignedCard ?? null;

        if (!uiCard && currentCard) {
          logInfo("WS reconnected — UI parked us as idle during disconnect");
          await goIdle();
        } else if (uiCard && (!currentCard || currentCard.nodeId !== uiCard.nodeId)) {
          logInfo(`WS reconnected — UI moved us to ${uiCard.cardId} during disconnect`);
          await attachCard(uiCard);
        } else {
          // Local state matches UI — just refresh onDisconnect handlers.
          await onDisconnect(sessionRef).remove();
          const uid = auth.currentUser?.uid;
          if (uid && currentCard) {
            const presenceRef = rtdbRef(rtdb, `${PRESENCE_ROOT}/${cfg.workspaceId}/${currentCard.nodeId}/${uid}`);
            await onDisconnect(presenceRef).remove();
          }
        }
      } catch (e) {
        logError(`reconnect handling failed: ${String(e)}`);
      }
    })();
  });
}

/**
 * Watch our own session for UI-driven card reassignment. The UI can:
 *   - set `assignedCard: null` → park the daemon as idle (badge moves to
 *     the team-members panel, daemon stays running, ready for reassignment)
 *   - set `assignedCard` to a different card → daemon detaches from the old
 *     card and attaches to the new one (same process, no re-setup needed)
 */
function watchSession(): void {
  const sessionRef = rtdbRef(rtdb, `${SESSION_ROOT}/${cfg.workspaceId}/${SESSION_ID}`);
  let seenInitial = false;
  sessionWatchUnsub = onValue(sessionRef, (snap) => {
    if (!snap.exists()) return;
    const val = snap.val() as { assignedCard?: { cardId: string; boardId: string; nodeId: string } | null };
    // Skip the first snapshot — it echoes our own initSession write.
    if (!seenInitial) { seenInitial = true; return; }

    // UI calls rtdbUpdate({assignedCard: null}) to detach. Firebase treats
    // `null` in an update as a key delete, so in the snapshot the field is
    // `undefined` (not `null`). Check for falsy to catch both.
    const uiCard = val.assignedCard ?? null;

    if (!uiCard) {
      if (currentCard) {
        logInfo("UI removed card assignment — going idle");
        void goIdle();
      }
      return;
    }

    if (!currentCard || currentCard.nodeId !== uiCard.nodeId) {
      logInfo(`UI moved agent to card ${uiCard.cardId} — attaching`);
      void attachCard(uiCard);
    }
  });
}

/**
 * Park the daemon as idle: stop the Firestore watcher + clear presence,
 * update the RTDB session to `status: "idle"` + `assignedCard: null`.
 * The daemon keeps running so the user can reassign it from the UI.
 */
async function goIdle(): Promise<void> {
  detachCard();
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const sessionRef = rtdbRef(rtdb, `${SESSION_ROOT}/${cfg.workspaceId}/${SESSION_ID}`);
  await rtdbUpdate(sessionRef, {
    status: "idle",
    assignedCard: null,
    lastHeartbeat: Date.now(),
  }).catch((e) => logError(`goIdle session update failed: ${String(e)}`));
}

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
  // Prefer the card we are currently attached to (UI may have moved us).
  // Fall back to the bootstrap card if a legacy config supplied one.
  const targetCardId = currentCard?.cardId ?? cfg.agentCardId;
  if (!targetCardId) {
    logError(`postChat skipped — no card attached: ${msg.slice(0, 80)}`);
    return;
  }
  await apiExec("chat_respond", targetCardId, { content: msg }).catch((e) =>
    logError(`postChat failed: ${String(e)}`),
  );
}

/* ------------------------------------------------------------------ */
/*  Work queue (tasks + chat messages)                                  */
/* ------------------------------------------------------------------ */

interface QueuedTask {
  kind: "task";
  id: string;
  taskNumber: number;
  title: string;
}

interface QueuedChat {
  kind: "chat";
  /** Firestore message id — also doubles as the dedupe key. */
  id: string;
  /** Author of the user-side message. */
  senderName: string;
  /** Raw message body forwarded to claude as the prompt. */
  content: string;
}

type QueuedItem = QueuedTask | QueuedChat;

const queue: QueuedItem[] = [];
const processedTaskIds = new Set<string>();
const processedChatIds = new Set<string>();
let working = false;

function queueFile(id: string): string {
  return join(DAEMON_QUEUE_DIR, `${id}.json`);
}

function persistQueueEntry(item: QueuedItem): void {
  try { writeFileSync(queueFile(item.id), JSON.stringify(item)); } catch { /* ignore */ }
}

function removeQueueEntry(id: string): void {
  try { if (existsSync(queueFile(id))) unlinkSync(queueFile(id)); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/*  Claude spawn                                                        */
/* ------------------------------------------------------------------ */

function buildTaskPrompt(task: QueuedTask): string {
  // Tasks only flow in when we are attached to a card, so currentCard is set
  // here. Fall back to legacy cfg fields just in case to keep this routine
  // safe under unusual race conditions (e.g. detach mid-dispatch).
  const cardId    = currentCard?.cardId ?? cfg.agentCardId ?? "(unknown card)";
  const cardTitle = cfg.cardTitle ?? "(card)";
  return [
    `You are the is.team autonomous agent assigned to card "${cardTitle}" (id: ${cardId}).`,
    ``,
    `A new task has been assigned to you:`,
    `  #${task.taskNumber} — ${task.title}`,
    `  task id: ${task.id}`,
    ``,
    `Do the following, in order:`,
    `  1. Call the read_card tool with cardId "${cardId}" to see the task's full description, connected cards, and available move targets.`,
    `  2. Work on the task using whatever tools you need (file edits, shell commands, web searches, etc.). When you need to ask the user a question, use ask_chat — they are monitoring the card chat, not the terminal.`,
    `  3. When the task is complete, use complete_task with the task number and move it to the appropriate connected card (usually "Done" or the next pipeline stage).`,
    `  4. Post a short chat summary (via chat_respond) describing what you did.`,
    ``,
    `Stay focused on this single task. Do not touch other tasks on the card.`,
  ].join("\n");
}

function buildChatPrompt(chat: QueuedChat): string {
  // Conversational counterpart to buildTaskPrompt — the user just sent a chat
  // message on the subscribed card and expects a reply, not a full task run.
  // Keep this prompt TIGHT: tool-use license here is what runs the container
  // out of memory on small Fly tiers (claude OOM-killed at 5min on a single
  // "selam" because the model wandered into read_card + list_cards before
  // replying).
  const cardId    = currentCard?.cardId ?? cfg.agentCardId ?? "(unknown card)";
  const cardTitle = cfg.cardTitle ?? "(card)";
  return [
    `You are the is.team autonomous agent for card "${cardTitle}" (id: ${cardId}).`,
    ``,
    `A user just sent this message in the card chat:`,
    `  ${chat.senderName}: ${chat.content}`,
    ``,
    `Reply with ONE call to chat_respond and exit immediately. Do not call any other tools unless the user explicitly asked you to look something up or do something. Keep the reply short — one or two sentences.`,
    ``,
    `Required call shape: chat_respond({ cardId: "${cardId}", content: "<your reply>" })`,
  ].join("\n");
}

function buildPrompt(item: QueuedItem): string {
  return item.kind === "task" ? buildTaskPrompt(item) : buildChatPrompt(item);
}

/** Per-image path the entrypoint writes to. Pass via --mcp-config so claude
 *  loads the is-team MCP server (chat_respond, read_card, complete_task, …)
 *  on every spawn. Without it the chat prompt's "respond via chat_respond"
 *  instruction silently no-ops because the tool isn't registered. */
const CLAUDE_MCP_CONFIG_PATH = "/root/.isteam/mcp.json";

function runClaude(item: QueuedItem): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const args = [
      "--print",
      "--permission-mode", cfg.permissionMode,
      "--mcp-config", CLAUDE_MCP_CONFIG_PATH,
    ];
    if (cfg.permissionMode === "bypassPermissions") {
      // Claude expects --dangerously-skip-permissions for fully autonomous mode
      args.push("--dangerously-skip-permissions");
    }
    args.push(buildPrompt(item));

    const label = item.kind === "task"
      ? `task #${item.taskNumber} (id ${item.id})`
      : `chat ${item.id} from ${item.senderName}`;
    logInfo(`spawning claude for ${label}`);

    // Forward IST_* to claude → MCP server child. Entrypoint unsets these
    // after writing daemon.json, so process.env doesn't have them — we have
    // to rebuild the bag from cfg every spawn.
    const child = spawn(cfg.claudePath, args, {
      cwd: cfg.workingDir,
      env: {
        ...process.env,
        IST_API_TOKEN:   cfg.token,
        IST_BASE_URL:    cfg.baseUrl,
        IST_AGENT_NAME:  cfg.agentName,
        IST_WORKSPACE_ID: cfg.workspaceId,
      },
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
      // Mirror to fly logs so we don't have to SSH into the machine and read
      // /root/.isteam/daemon-error.log to debug a crash.
      for (const ln of s.split("\n")) {
        if (ln.trim()) logError(`[claude stderr] ${ln}`);
      }
      try { appendFileSync(DAEMON_ERROR_LOG, s); } catch { /* ignore */ }
    });

    const timeout = setTimeout(() => {
      logError(`${label} timed out after 30 minutes — killing`);
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
  const item = queue.shift();
  if (!item) return;
  working = true;
  await setStatus("working");

  // Tasks get a "starting" announcement; chat replies don't, since the user
  // is already watching the chat thread and a "starting" line is just noise.
  if (item.kind === "task") {
    logInfo(`→ starting task #${item.taskNumber}: ${item.title}`);
    await postChat(`🤖 Agent started task #${item.taskNumber} — ${item.title}`);
  } else {
    logInfo(`→ starting chat reply (msg ${item.id} from ${item.senderName})`);
  }

  try {
    const { exitCode, stdout, stderr } = await runClaude(item);
    removeQueueEntry(item.id);

    const stdoutTail = stdout.trim().slice(-1500);
    const stderrTail = stderr.trim().slice(-1500);
    // On failure, the actually useful signal is in stderr, not stdout. Prefer
    // it when both are present so the user doesn't have to dig through logs.
    const failureBody = stderrTail || stdoutTail || "(no output)";
    const successBody = stdoutTail || "(no output)";

    if (item.kind === "task") {
      if (exitCode === 0) {
        logInfo(`✓ task #${item.taskNumber} completed`);
        await postChat(`✅ Agent finished task #${item.taskNumber}.\n\n\`\`\`\n${successBody}\n\`\`\``);
      } else {
        logError(`✗ task #${item.taskNumber} exited ${exitCode}`);
        await postChat(`⚠️ Agent exited with code ${exitCode} on task #${item.taskNumber}.\n\n\`\`\`\n${failureBody}\n\`\`\``);
      }
    } else {
      // For chat replies, claude is *expected* to call chat_respond itself,
      // but we can't trust it to always pick the tool path — sometimes the
      // model just emits plain text and exits 0 silently, leaving the user
      // staring at an empty thread. Always post stdout as a fallback when it
      // contains anything beyond noise. Worst case: the user sees a doubled
      // reply (chat_respond + stdout); much better than the silent failure.
      if (exitCode === 0) {
        logInfo(`✓ chat reply ${item.id} completed (stdout ${stdoutTail.length} chars)`);
        if (stdoutTail.length > 0) {
          await postChat(stdoutTail);
        } else {
          // No stdout AND no chat_respond call — surface to the user so they
          // know the agent ran but didn't speak. Otherwise it looks frozen.
          await postChat(`(agent ran but produced no reply — check daemon logs)`);
        }
      } else {
        logError(`✗ chat reply ${item.id} exited ${exitCode}`);
        await postChat(`⚠️ Agent crashed while replying (exit ${exitCode}).\n\n\`\`\`\n${failureBody}\n\`\`\``);
      }
    }
  } catch (err) {
    logError(`${item.kind} ${item.id} failed: ${String(err)}`);
    await postChat(`⚠️ Agent crashed: ${String(err)}`);
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
let chatUnsub: Unsubscribe | null = null;
let initialLoad     = true;
let chatInitialLoad = true;
/** Floor for chat-listener events — anything older is treated as "history". */
let chatBaselineTs  = 0;

type TaskEntry = { id: string; title?: string; taskNumber?: number };
type ChatMessageDoc = {
  role?:         string;       // "user" | "assistant" | "system"
  content?:      string;
  timestamp?:    number;
  senderName?:   string;
  isAutomation?: boolean;
};

/**
 * Stop watching the current card. Keeps the daemon process alive and the
 * RTDB session present — it just parks the agent in "idle" so it shows up
 * in the user's team-members panel for reassignment.
 */
function detachCard(): void {
  if (nodeUnsub) { nodeUnsub(); nodeUnsub = null; }
  if (chatUnsub) { chatUnsub(); chatUnsub = null; }
  processedTaskIds.clear();
  processedChatIds.clear();
  initialLoad     = true;
  chatInitialLoad = true;
  chatBaselineTs  = 0;

  const prev = currentCard;
  currentCard = null;
  if (!prev) return;

  // Best-effort: clear the aiPresence marker we wrote for this card.
  const uid = auth.currentUser?.uid;
  if (uid) {
    const presenceRef = rtdbRef(rtdb, `${PRESENCE_ROOT}/${cfg.workspaceId}/${prev.nodeId}/${uid}`);
    rtdbRemove(presenceRef).catch(() => {});
  }
  logInfo(`detached from card ${prev.cardId}`);
}

/**
 * Subscribe to a card's canvasNode and start dispatching any new tasks
 * assigned to it. Safe to call for a switch (stops the previous watcher).
 */
async function attachCard(card: { cardId: string; boardId: string; nodeId: string }): Promise<void> {
  if (currentCard && currentCard.nodeId === card.nodeId) return;
  detachCard();

  currentCard      = card;
  initialLoad      = true;
  chatInitialLoad  = true;
  chatBaselineTs   = Date.now();
  processedTaskIds.clear();
  processedChatIds.clear();

  // Sync RTDB: session status + assignedCard so the UI badge lands on this
  // card, and aiPresence so the "MCP Subscribed" glow appears.
  const uid = auth.currentUser?.uid;
  if (uid) {
    const sessionRef = rtdbRef(rtdb, `${SESSION_ROOT}/${cfg.workspaceId}/${SESSION_ID}`);
    await rtdbUpdate(sessionRef, {
      status: "subscribed",
      assignedCard: card,
      lastHeartbeat: Date.now(),
    }).catch((e) => logError(`attachCard session update failed: ${String(e)}`));
    await onDisconnect(sessionRef).remove();

    const presenceRef = rtdbRef(rtdb, `${PRESENCE_ROOT}/${cfg.workspaceId}/${card.nodeId}/${uid}`);
    await rtdbSet(presenceRef, { active: true, subscribedAt: Date.now(), daemon: true });
    await onDisconnect(presenceRef).remove();
  }

  const nodeRef = doc(db, "workspaces", cfg.workspaceId, "boards", card.boardId, "canvasNodes", card.nodeId);
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
        kind: "task",
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

  // ── Chat listener ──────────────────────────────────────────────────────────
  // Watches `canvasNodes/{nodeId}/chatMessages` for new user messages and
  // queues each one for a claude-driven reply. Filters:
  //   - role === "user" (skip assistant + system; assistant entries are our
  //     own chat_respond writes coming back through the listener)
  //   - timestamp >= chatBaselineTs (ignore historical messages on first load)
  //   - dedupe by message id (Firestore can replay docs on reconnect)
  const chatRef = collection(
    db,
    "workspaces", cfg.workspaceId,
    "boards",      card.boardId,
    "canvasNodes", card.nodeId,
    "chatMessages",
  );
  const chatQuery = query(chatRef, where("timestamp", ">=", chatBaselineTs), orderBy("timestamp", "asc"));
  chatUnsub = onSnapshot(chatQuery, (snap) => {
    if (chatInitialLoad) {
      // First snapshot is the post-baseline window — usually empty, but if
      // there are any in-flight messages mark them processed so we don't
      // immediately reply to a stale prompt.
      for (const d of snap.docs) processedChatIds.add(d.id);
      chatInitialLoad = false;
      return;
    }

    for (const change of snap.docChanges()) {
      if (change.type !== "added") continue;
      const doc = change.doc;
      if (processedChatIds.has(doc.id)) continue;

      const data = doc.data() as ChatMessageDoc;
      // Only react to genuine user messages — never our own automation
      // posts (would feedback-loop) or system events.
      if (data.role !== "user") continue;
      if (data.isAutomation) continue;
      if (typeof data.content !== "string" || !data.content.trim()) continue;

      processedChatIds.add(doc.id);
      const entry: QueuedChat = {
        kind:       "chat",
        id:         doc.id,
        senderName: data.senderName ?? "user",
        content:    data.content.trim(),
      };
      persistQueueEntry(entry);
      queue.push(entry);
      logInfo(`queued chat ${entry.id} from ${entry.senderName}: ${entry.content.slice(0, 60)}${entry.content.length > 60 ? "…" : ""}`);
    }

    if (!working && queue.length > 0) processQueue();
  }, (err) => {
    logError(`chat listener error: ${String(err)}`);
  });

  logInfo(`attached to card ${card.cardId} (tasks + chat)`);
}

/**
 * Bootstrap: auth → session record → UI watchers → attach to the card
 * baked into ~/.isteam/daemon.json. If the user later drags the agent
 * off or onto a different card, watchSession handles the transition.
 */
async function subscribe(): Promise<void> {
  await ensureAuth();
  await initSession();
  watchConnection();
  watchSession();
  // Backward-compat: if a legacy config baked in a card, attach to it on
  // boot. New configs (post-v2.3) start idle and rely on UI drag-to-assign.
  if (cfg.agentCardId && cfg.boardId && cfg.nodeId) {
    await attachCard({ cardId: cfg.agentCardId, boardId: cfg.boardId, nodeId: cfg.nodeId });
  } else {
    logInfo("idle — drag the agent onto a card from is.team to start watching it");
  }
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                           */
/* ------------------------------------------------------------------ */

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logInfo(`shutdown (${signal})`);
  if (sessionWatchUnsub) { sessionWatchUnsub(); sessionWatchUnsub = null; }
  if (connectWatchUnsub) { connectWatchUnsub(); connectWatchUnsub = null; }
  if (nodeUnsub) { nodeUnsub(); nodeUnsub = null; }
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }

  try {
    const sessionRef = rtdbRef(rtdb, `${SESSION_ROOT}/${cfg.workspaceId}/${SESSION_ID}`);
    await rtdbRemove(sessionRef);
    const uid = auth.currentUser?.uid;
    if (uid && currentCard) {
      const presenceRef = rtdbRef(rtdb, `${PRESENCE_ROOT}/${cfg.workspaceId}/${currentCard.nodeId}/${uid}`);
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

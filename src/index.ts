// Route top-level subcommands (setup, daemon) before starting the MCP server.
const firstArg = process.argv[2];

if (firstArg === "setup") {
  await import("./setup.js");
  await new Promise(() => {}); // setup.ts handles exit
}

if (firstArg === "daemon") {
  const { runDaemonCli } = await import("./daemon-cli.js");
  await runDaemonCli(process.argv.slice(3));
  process.exit(0);
}

import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, signInWithCustomToken } from "firebase/auth";
import {
  getFirestore,
  collection,
  doc,
  onSnapshot,
  query,
  orderBy,
  limitToLast,
  type Unsubscribe,
} from "firebase/firestore";
import {
  getDatabase,
  ref as rtdbRef,
  get as rtdbGet,
  set as rtdbSet,
  update as rtdbUpdate,
  remove as rtdbRemove,
  onDisconnect,
  onValue,
  type Database,
} from "firebase/database";

import { IsTeamClient } from "./api-client.js";

/* ------------------------------------------------------------------ */
/*  Configuration from environment                                     */
/* ------------------------------------------------------------------ */

const API_TOKEN = process.env.IST_API_TOKEN;
const BASE_URL  = process.env.IST_BASE_URL ?? "https://is.team";

if (!API_TOKEN) {
  console.error("Error: IST_API_TOKEN environment variable is required.");
  console.error("Generate a token at: Account Settings → API tab in is.team");
  process.exit(1);
}

const client = new IsTeamClient(BASE_URL, API_TOKEN);

/* ------------------------------------------------------------------ */
/*  Agent Session Identity                                             */
/* ------------------------------------------------------------------ */

/** Generate a random 6-char alphanumeric ID (uppercase) — fallback only. */
function generateAgentId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

/**
 * Prefer the user-provided agent name (set via setup wizard, stored in the
 * project's .mcp.json env). Must be 1–6 alphanumeric characters — validated
 * here so a malformed env value doesn't poison the UI badge.
 */
function resolveAgentId(): string {
  const raw = process.env.IST_AGENT_NAME?.trim().toUpperCase();
  if (raw && /^[A-Z0-9]{1,6}$/.test(raw)) return raw;
  if (raw) {
    process.stderr.write(`[mcp] IST_AGENT_NAME "${raw}" is invalid (must be 1-6 alphanumeric chars) — using random fallback.\n`);
  }
  return generateAgentId();
}

const AGENT_ID    = resolveAgentId();
const SESSION_ID  = `ses-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const AGENT_SESSION_ROOT = "agentSessions";

/** Agent connection mode — always "streaming" since we can't reliably detect client channel support. */
const agentMode: "streaming" | "tools" = "streaming";

process.stderr.write(`\n🤖 Agent ID: ${AGENT_ID}\n\n`);

/* ------------------------------------------------------------------ */
/*  Firebase (for real-time subscriptions)                             */
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

let firebaseApp: FirebaseApp | null = null;
let firestoreDb: ReturnType<typeof getFirestore> | null = null;
let realtimeDb: Database | null = null;
let firebaseAuthenticated = false;
let firebaseAuthTime = 0;
const FIREBASE_TOKEN_TTL = 55 * 60 * 1000; // refresh 5 min before 1h expiry

function getApp(): FirebaseApp {
  if (!firebaseApp) {
    firebaseApp = initializeApp(firebaseConfig);
  }
  return firebaseApp;
}

function getDb(): ReturnType<typeof getFirestore> {
  if (!firestoreDb) {
    firestoreDb = getFirestore(getApp());
  }
  return firestoreDb;
}

function getRtdb(): Database {
  if (!realtimeDb) {
    realtimeDb = getDatabase(getApp());
  }
  return realtimeDb;
}

const AI_PRESENCE_ROOT     = "aiPresence";
const AGENT_ACTIVITY_ROOT  = "agentActivity";

function getAuthUid(): string | null {
  const auth = getAuth(getApp());
  return auth.currentUser?.uid ?? null;
}

/* ------------------------------------------------------------------ */
/*  Agent activity (real-time tool-call indicator for the UI)          */
/* ------------------------------------------------------------------ */

/**
 * Human-readable label for the current tool call. Prefer specifics that the
 * UI can render in a small pill (≤ ~40 chars). Used by `writeAgentActivity`.
 */
function describeActivity(tool: string, args: Record<string, unknown>): string {
  const num = typeof args.taskNumber === "number" ? `#${args.taskNumber}` : "";
  const title = typeof args.title === "string" && args.title.trim()
    ? `: ${args.title.trim().slice(0, 40)}`
    : "";
  switch (tool) {
    case "list_cards":         return "Listing cards";
    case "read_card":          return "Reading card";
    case "create_task":        return `Creating task${title}`;
    case "update_task":        return `Updating task ${num}`.trim();
    case "complete_task":      return `Completing task ${num}`.trim();
    case "move_task":          return `Moving task ${num}`.trim();
    case "add_comment":        return `Commenting on task ${num}`.trim();
    case "log_time":           return `Logging time on task ${num}`.trim();
    case "reorder_tasks":      return "Reordering tasks";
    case "chat_respond":       return "Replying in chat";
    case "chat_history":       return "Reading chat history";
    case "ask_chat":           return "Asking the user";
    case "create_note":        return `Creating note${title}`;
    case "update_note":        return "Updating note";
    case "create_edge":        return "Connecting cards";
    case "delete_edge":        return "Disconnecting cards";
    case "move_node":          return "Moving node";
    case "create_stack":       return "Creating stack";
    case "add_to_stack":       return "Adding to stack";
    case "dissolve_stack":     return "Dissolving stack";
    case "subscribe_card":     return "Subscribing to card";
    case "unsubscribe_card":   return "Unsubscribing from card";
    case "list_integrations":  return "Checking integrations";
    case "list_boards":        return "Listing boards";
    case "create_board":       return `Creating board${title}`;
    case "update_board":       return "Updating board";
    case "delete_board":       return "Deleting board";
    case "list_members":       return "Listing members";
    case "create_card":        return `Creating card${title}`;
    case "update_card":        return "Updating card";
    case "update_card_settings": return "Updating card settings";
    case "delete_card":        return "Deleting card";
    case "list_notes":         return "Listing notes";
    case "list_edges":         return "Listing edges";
    case "delete_note":        return "Deleting note";
    case "delete_task":        return `Deleting task ${num}`.trim();
    case "list_comments":      return "Listing comments";
    case "update_comment":     return "Updating comment";
    case "delete_comment":     return "Deleting comment";
    case "list_worklogs":      return "Listing worklogs";
    case "get_worklog":        return "Reading worklog";
    case "update_worklog":     return "Updating worklog";
    case "delete_worklog":     return "Deleting worklog";
    case "get_active_timer":   return "Reading active timer";
    case "list_files":         return "Listing files";
    case "delete_file":        return "Deleting file";
    case "add_task_attachment":    return "Attaching file";
    case "remove_task_attachment": return "Detaching file";
    case "list_task_attachments":  return "Listing attachments";
    case "invite_members":         return "Sending invites";
    case "list_pending_invites":   return "Listing pending invites";
    case "revoke_invite":          return "Revoking invite";
    case "update_member_role":     return "Updating member role";
    case "remove_member":          return "Removing member";
    case "update_member_profile":  return "Updating member profile";
    case "add_task_subscriber":    return "Adding subscriber";
    case "remove_task_subscriber": return "Removing subscriber";
    case "list_task_subscribers":  return "Listing subscribers";
    case "create_sprint":          return `Creating sprint${title}`;
    case "update_sprint":          return "Updating sprint";
    case "complete_sprint":        return "Completing sprint";
    case "list_sprints":           return "Listing sprints";
    case "get_active_sprint":      return "Reading active sprint";
    case "add_subtask":            return "Linking subtask";
    case "remove_subtask":         return "Unlinking subtask";
    case "list_subtasks":          return "Listing subtasks";
    case "list_all_tasks":         return "Listing all tasks";
    case "list_archived_tasks":    return "Listing archived tasks";
    case "restore_task":           return `Restoring task ${num}`.trim();
    case "list_notifications":     return "Listing notifications";
    case "mark_notification_read": return "Marking notification read";
    case "delete_notification":    return "Deleting notification";
    case "list_forms":             return "Listing forms";
    case "get_form":               return "Reading form";
    case "list_form_submissions":  return "Listing form submissions";
    case "get_workspace_settings": return "Reading workspace settings";
    case "update_workspace_settings": return "Updating workspace settings";
    case "get_user_preferences":   return "Reading user preferences";
    case "update_user_preferences": return "Updating user preferences";
    case "batch_move_nodes":       return "Batch-moving nodes";
    case "batch_delete_nodes":     return "Batch-deleting nodes";
    default:                   return tool.replace(/_/g, " ");
  }
}

/**
 * Write the agent's current tool call to RTDB so every workspace this
 * session is registered in can render a "ISTEAM is creating a task..."
 * indicator on the assigned card. Best-effort — failures don't surface
 * to the tool result.
 */
async function writeAgentActivity(tool: string, args: Record<string, unknown>): Promise<void> {
  if (!firebaseAuthenticated) return;
  const uid = getAuthUid();
  if (!uid) return;
  if (agentWorkspaceIds.length === 0) return;

  const cardId = typeof args.cardId === "string" ? args.cardId : undefined;
  const data = {
    uid,
    agentId: AGENT_ID,
    tool,
    label: describeActivity(tool, args),
    cardId: cardId ?? null,
    startedAt: Date.now(),
  };

  const db = getRtdb();
  await Promise.all(
    agentWorkspaceIds.map(async (wsId) => {
      const ref = rtdbRef(db, `${AGENT_ACTIVITY_ROOT}/${wsId}/${SESSION_ID}`);
      try {
        await rtdbSet(ref, data);
        await onDisconnect(ref).remove();
      } catch { /* best effort */ }
    }),
  );
}

async function clearAgentActivity(): Promise<void> {
  if (agentWorkspaceIds.length === 0) return;
  const db = getRtdb();
  await Promise.all(
    agentWorkspaceIds.map(async (wsId) => {
      const ref = rtdbRef(db, `${AGENT_ACTIVITY_ROOT}/${wsId}/${SESSION_ID}`);
      try { await rtdbRemove(ref); } catch { /* best effort */ }
    }),
  );
}

const PRESENCE_HEARTBEAT_MS = 30_000; // re-write presence every 30s

async function writePresence(workspaceId: string, nodeId: string): Promise<void> {
  await ensureFirebaseAuth();
  const uid = getAuthUid();
  if (!uid) return;
  const db = getRtdb();
  const presenceRef = rtdbRef(db, `${AI_PRESENCE_ROOT}/${workspaceId}/${nodeId}/${uid}`);
  await rtdbSet(presenceRef, { active: true, subscribedAt: Date.now() });
  await onDisconnect(presenceRef).remove();
}

async function setAiPresence(workspaceId: string, nodeId: string): Promise<ReturnType<typeof setInterval>> {
  await writePresence(workspaceId, nodeId);
  process.stderr.write(`[mcp] AI presence set for ${nodeId} (uid: ${getAuthUid()})\n`);
  // Heartbeat: re-write presence periodically to survive RTDB reconnections
  return setInterval(() => {
    writePresence(workspaceId, nodeId).catch((e) =>
      process.stderr.write(`[mcp] Presence heartbeat failed for ${nodeId}: ${String(e)}\n`),
    );
  }, PRESENCE_HEARTBEAT_MS);
}

async function clearAiPresence(workspaceId: string, nodeId: string): Promise<void> {
  const uid = getAuthUid();
  if (!uid) return;
  const db = getRtdb();
  const presenceRef = rtdbRef(db, `${AI_PRESENCE_ROOT}/${workspaceId}/${nodeId}/${uid}`);
  await rtdbRemove(presenceRef);
  process.stderr.write(`[mcp] AI presence cleared for ${nodeId}\n`);
}

/**
 * Authenticate Firebase client SDK using a custom token from the API.
 * Must be called before any Firestore subscription.
 */
async function ensureFirebaseAuth(): Promise<void> {
  const now = Date.now();
  if (firebaseAuthenticated && (now - firebaseAuthTime) < FIREBASE_TOKEN_TTL) return;

  process.stderr.write(`[mcp] ${firebaseAuthenticated ? "Refreshing" : "Authenticating"} Firebase token...\n`);

  const res = await fetch(`${BASE_URL}/api/mcp/auth`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });

  if (!res.ok) {
    throw new Error(`Firebase auth failed: ${res.status} ${res.statusText}`);
  }

  const { customToken } = (await res.json()) as { customToken: string };
  const auth = getAuth(getApp());
  await signInWithCustomToken(auth, customToken);
  firebaseAuthenticated = true;
  firebaseAuthTime = now;
  process.stderr.write("[mcp] Firebase authenticated.\n");
}

/* ------------------------------------------------------------------ */
/*  Agent Session Presence                                             */
/* ------------------------------------------------------------------ */

/** Workspace IDs this agent has access to (populated after auth). */
let agentWorkspaceIds: string[] = [];

/** Active session watchers (one per workspace). */
const sessionWatchers: Array<() => void> = [];
const sessionHeartbeatIntervals: Array<ReturnType<typeof setInterval>> = [];

/**
 * Single source of truth for this agent's card assignment, shared across
 * every workspace this MCP writes sessions into. Per-workspace session
 * entries mirror this value — the watcher detects UI-driven drifts and
 * pushes them back here + fans them out to the other workspaces so the
 * "I have TEST5 idle in workspace B" bug can't happen while TEST5 is
 * subscribed in workspace A.
 */
let authoritativeAssignedCard: { cardId: string; boardId: string; nodeId: string } | null = null;

async function writeAgentSession(workspaceId: string): Promise<void> {
  const uid = getAuthUid();
  if (!uid) return;
  const db = getRtdb();

  // Remove ONLY zombie sessions for this uid (no heartbeat in > 2 minutes).
  // A user can legitimately run multiple MCPs for the same token — e.g.
  // a background daemon plus an interactive Claude Code stdio MCP — and
  // they must coexist. If we wiped every peer, they would ping-pong
  // deleting each other's sessions every heartbeat.
  const STALE_THRESHOLD = 2 * 60 * 1000;
  const wsRef = rtdbRef(db, `${AGENT_SESSION_ROOT}/${workspaceId}`);
  const snap = await rtdbGet(wsRef);
  if (snap.exists()) {
    const sessions = snap.val() as Record<string, { uid?: string; lastHeartbeat?: number }>;
    const now = Date.now();
    for (const [sid, data] of Object.entries(sessions)) {
      const stale = now - (data.lastHeartbeat ?? 0) > STALE_THRESHOLD;
      if (data.uid === uid && sid !== SESSION_ID && stale) {
        await rtdbRemove(rtdbRef(db, `${AGENT_SESSION_ROOT}/${workspaceId}/${sid}`));
        process.stderr.write(`[mcp] Removed zombie session ${sid} (no heartbeat for ${Math.round((now - (data.lastHeartbeat ?? 0)) / 1000)}s)\n`);
      }
    }
  }

  const sessionRef = rtdbRef(db, `${AGENT_SESSION_ROOT}/${workspaceId}/${SESSION_ID}`);
  const sessionData = {
    uid,
    agentId: AGENT_ID,
    mode: agentMode,
    status: authoritativeAssignedCard ? "subscribed" : "idle",
    assignedCard: authoritativeAssignedCard,
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
  };
  await rtdbSet(sessionRef, sessionData);
  await onDisconnect(sessionRef).remove();
}

async function updateSessionHeartbeat(workspaceId: string): Promise<void> {
  await ensureFirebaseAuth(); // Refresh token if expired (tokens last ~1 hour)
  const db = getRtdb();
  const sessionRef = rtdbRef(db, `${AGENT_SESSION_ROOT}/${workspaceId}/${SESSION_ID}`);

  // Check if session was deleted (e.g. stale onDisconnect fired after token refresh or sleep)
  const snap = await rtdbGet(sessionRef);
  if (!snap.exists() || !snap.val()?.agentId) {
    process.stderr.write(`[mcp] Session lost for ${workspaceId}, re-registering...\n`);
    await writeAgentSession(workspaceId);

    // Restore subscription status if an active subscription exists for this workspace
    const activeSub = [...subscriptions.values()].find((s) => s.workspaceId === workspaceId);
    if (activeSub) {
      process.stderr.write(`[mcp] Restoring subscription badge for card ${activeSub.cardId}\n`);
      await updateSessionStatus(workspaceId, "subscribed", {
        cardId: activeSub.cardId,
        boardId: activeSub.boardId,
        nodeId: activeSub.nodeId,
      });
    }
    return;
  }

  await rtdbUpdate(sessionRef, { lastHeartbeat: Date.now() });
  // Re-register onDisconnect — token refresh reconnects the WebSocket,
  // which fires the old onDisconnect handler and removes the session.
  await onDisconnect(sessionRef).remove();
}

async function updateSessionStatus(workspaceId: string, status: "idle" | "subscribed", assignedCard: { cardId: string; boardId: string; nodeId: string } | null): Promise<void> {
  const db = getRtdb();
  const sessionRef = rtdbRef(db, `${AGENT_SESSION_ROOT}/${workspaceId}/${SESSION_ID}`);
  await rtdbUpdate(sessionRef, { status, assignedCard, lastHeartbeat: Date.now() });
}

async function clearAgentSession(workspaceId: string): Promise<void> {
  const db = getRtdb();
  const sessionRef = rtdbRef(db, `${AGENT_SESSION_ROOT}/${workspaceId}/${SESSION_ID}`);
  await rtdbRemove(sessionRef);
}

async function clearAllAgentSessions(): Promise<void> {
  for (const wsId of agentWorkspaceIds) {
    await clearAgentSession(wsId).catch(() => {});
  }
}

/**
 * Start agent session presence for all accessible workspaces.
 * Also watches each session for UI-driven card assignment.
 */
async function startAgentSessions(workspaceIds: string[]): Promise<void> {
  agentWorkspaceIds = workspaceIds;

  for (const wsId of workspaceIds) {
    await writeAgentSession(wsId);
    process.stderr.write(`[mcp] Agent session registered in workspace ${wsId} (${AGENT_ID})\n`);

    // Heartbeat
    const hbInterval = setInterval(() => {
      updateSessionHeartbeat(wsId).catch((e) =>
        process.stderr.write(`[mcp] Session heartbeat failed for ${wsId}: ${String(e)}\n`),
      );
    }, PRESENCE_HEARTBEAT_MS);
    sessionHeartbeatIntervals.push(hbInterval);

    // Watch for UI-driven card assignment
    const db = getRtdb();
    const sessionRef = rtdbRef(db, `${AGENT_SESSION_ROOT}/${wsId}/${SESSION_ID}`);
    let prevAssignedNodeId: string | null = null;

    const unsub = onValue(sessionRef, async (snap) => {
      if (!snap.exists()) return;
      const val = snap.val() as {
        status?: string;
        assignedCard?: { cardId: string; boardId: string; nodeId: string } | null;
      };

      const incomingCard = val.assignedCard ?? null;
      const incomingKey = JSON.stringify(incomingCard);
      const authoritativeKey = JSON.stringify(authoritativeAssignedCard);

      // RTDB value matches our authoritative state — either our own write
      // echoing back, a heartbeat touching only lastHeartbeat, or another
      // workspace's propagation landing here. Either way, no action.
      if (incomingKey === authoritativeKey) return;

      // UI changed the value. Adopt the new state globally and propagate to
      // every other workspace's session entry so this MCP can't appear idle
      // in workspace B while subscribed in workspace A.
      authoritativeAssignedCard = incomingCard;
      for (const otherWsId of agentWorkspaceIds) {
        if (otherWsId === wsId) continue;
        const otherRef = rtdbRef(db, `${AGENT_SESSION_ROOT}/${otherWsId}/${SESSION_ID}`);
        rtdbUpdate(otherRef, {
          assignedCard: incomingCard,
          status: incomingCard ? "subscribed" : "idle",
          lastHeartbeat: Date.now(),
        }).catch((e) => process.stderr.write(`[mcp] propagate to ${otherWsId} failed: ${String(e)}\n`));
      }

      const newNodeId = incomingCard?.nodeId ?? null;

      // UI assigned a card while agent is idle → auto-subscribe
      if (newNodeId && !prevAssignedNodeId && incomingCard) {
        prevAssignedNodeId = newNodeId;
        process.stderr.write(`[mcp] UI assigned card ${incomingCard.cardId} — auto-subscribing...\n`);
        await performSubscribe(incomingCard.cardId, wsId, incomingCard.boardId, incomingCard.nodeId, true);
      }

      // UI removed card assignment while agent is subscribed → auto-unsubscribe
      if (!newNodeId && prevAssignedNodeId) {
        const oldCardId = findCardIdByNodeId(prevAssignedNodeId);
        prevAssignedNodeId = null;
        if (oldCardId) {
          process.stderr.write(`[mcp] UI removed card assignment — auto-unsubscribing ${oldCardId}...\n`);
          await performUnsubscribe(oldCardId, true);
        }
      }

      // UI moved the agent to a different card → unsubscribe from old, subscribe to new
      if (newNodeId && prevAssignedNodeId && newNodeId !== prevAssignedNodeId && incomingCard) {
        const oldCardId = findCardIdByNodeId(prevAssignedNodeId);
        if (oldCardId) {
          process.stderr.write(`[mcp] UI moved agent from ${oldCardId} to ${incomingCard.cardId} — re-subscribing...\n`);
          await performUnsubscribe(oldCardId, true);
        }
        prevAssignedNodeId = newNodeId;
        await performSubscribe(incomingCard.cardId, wsId, incomingCard.boardId, incomingCard.nodeId, true);
      }
    });
    sessionWatchers.push(unsub);
  }
}

function findCardIdByNodeId(nodeId: string): string | null {
  for (const [cardId, sub] of subscriptions) {
    if (sub.nodeId === nodeId) return cardId;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Subscription state                                                 */
/* ------------------------------------------------------------------ */

interface Subscription {
  cardId:          string;
  workspaceId:     string;
  boardId:         string;
  nodeId:          string;
  unsubscribe:     Unsubscribe;
  chatUnsubscribe: Unsubscribe | null;
  taskIds:         Set<string>;
  presenceInterval: ReturnType<typeof setInterval> | null;
}

const subscriptions = new Map<string, Subscription>();

/* ------------------------------------------------------------------ */
/*  Tool input schemas                                                 */
/* ------------------------------------------------------------------ */

const CardIdArg = { cardId: z.string().describe("Board card ID (e.g. col-1773256154568)") };

/** Accept both number and string inputs — MCP clients may send either.
 *  z.preprocess casts before validation so the JSON Schema stays clean (type: number)
 *  while still accepting string values that some MCP clients send. */
const toNum = (v: unknown) => (typeof v === "string" ? Number(v) : v);
const toNumOrNull = (v: unknown) => (v === null ? null : toNum(v));
const zNum = (desc: string) => z.preprocess(toNum, z.number()).describe(desc);
const zNumOptional = (desc: string) => z.number().optional().describe(desc);
const zNumNullableOptional = (desc: string) => z.preprocess(toNumOrNull, z.number().nullable()).optional().describe(desc);

const CreateTaskSchema = {
  ...CardIdArg,
  title:       z.string().describe("Task title (required)"),
  type:        z.enum(["task", "bug", "feature", "story"]).optional().describe("Task type"),
  priority:    z.enum(["low", "medium", "high"]).optional().describe("Priority level"),
  description: z.string().optional().describe("Plain text description"),
  assignee:    z.string().optional().describe("Workspace member UID to assign"),
  assignedBy:  z.string().optional().describe("Reporter UID"),
  parentTask:  zNumOptional("Parent task number in this card"),
  dueDate:     z.string().optional().describe("Due date (ISO, e.g. 2026-04-01)"),
  startDate:   z.string().optional().describe("Start date (ISO)"),
  labels:      z.array(z.string()).optional().describe("Label strings"),
  storyPoints: zNumOptional("Story point estimate"),
  color:       z.string().optional().describe("Task color"),
};

const UpdateTaskSchema = {
  ...CardIdArg,
  taskNumber:  zNum("Task number from the # column"),
  title:       z.string().optional().describe("New title"),
  type:        z.enum(["task", "bug", "feature", "story"]).optional().describe("Task type"),
  priority:    z.enum(["low", "medium", "high"]).optional().describe("Priority level"),
  description: z.string().nullable().optional().describe("Description text, or null to clear"),
  assignee:    z.string().nullable().optional().describe("Member UID, or null to unassign"),
  assignedBy:  z.string().nullable().optional().describe("Reporter UID, or null to clear"),
  parentTask:  zNumNullableOptional("Parent task number, or null to clear"),
  dueDate:     z.string().nullable().optional().describe("Due date, or null to clear"),
  startDate:   z.string().nullable().optional().describe("Start date, or null to clear"),
  labels:      z.array(z.string()).nullable().optional().describe("Labels, or null to clear"),
  storyPoints: zNumNullableOptional("Story points, or null to clear"),
  color:       z.string().nullable().optional().describe("Color, or null to clear"),
  archived:    z.boolean().optional().describe("Archive or unarchive the task"),
};

const CompleteTaskSchema = {
  ...CardIdArg,
  taskNumber: zNum("Task number to mark as done"),
};

const MoveTaskSchema = {
  ...CardIdArg,
  taskNumber:      zNum("Task number to move"),
  targetCardTitle: z.string().describe("Target card name (case-insensitive, from Connected Cards)"),
};

const CommentSchema = {
  ...CardIdArg,
  taskNumber: zNum("Task number to comment on"),
  text:       z.string().describe("Comment text"),
};

const ReadCardSchema = {
  ...CardIdArg,
  user: z.string().optional().describe("Display name — personalizes the prompt for this user"),
};

const LogTimeSchema = {
  ...CardIdArg,
  taskNumber:  zNum("Task number to log time for"),
  duration:    zNum("Duration in seconds (60–86400). Example: 1800 = 30 min, 3600 = 1 hour"),
  description: z.string().optional().describe("What was done during this time (max 2000 chars)"),
  date:        z.string().optional().describe("Date for the worklog (YYYY-MM-DD). Defaults to today"),
};

const ReorderTasksSchema = {
  ...CardIdArg,
  taskNumbers: z.preprocess(
    (v) => Array.isArray(v) ? v.map(toNum) : v,
    z.array(z.number()),
  ).describe("All task numbers in desired order"),
};

const SubscribeCardSchema = {
  ...CardIdArg,
  workspaceId: z.string().describe("Workspace ID that contains the card"),
  boardId:     z.string().describe("Board ID that contains the card"),
  nodeId:      z.string().describe("Canvas node ID of the card"),
};

const UnsubscribeCardSchema = {
  ...CardIdArg,
};

/* ------------------------------------------------------------------ */
/*  McpServer setup                                                    */
/* ------------------------------------------------------------------ */

const server = new McpServer(
  { name: "is.team", version: "3.0.0" },
  {
    capabilities: {
      tools: {},
      logging: {},
      experimental: { "claude/channel": {} },
    },
  },
);

/* ------------------------------------------------------------------ */
/*  Auto-instrument every registered tool with activity tracking.      */
/*                                                                     */
/*  Wrapping `registerTool` once here means every subsequent           */
/*  registration (including the integration helper below) writes a     */
/*  `agentActivity/{ws}/{session}` entry while the handler runs and    */
/*  removes it when the handler resolves or rejects. The UI subscribes */
/*  to that path and renders the current tool call as a small pill on  */
/*  the agent's assigned card — closes ToDo's #117.                    */
/* ------------------------------------------------------------------ */

{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origRegisterTool = (server.registerTool as any).bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = function instrumentedRegisterTool(
    name: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    meta: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (args: any, extra: any) => Promise<any> | any,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapped = async (args: any, extra: any) => {
      const argRecord = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      void writeAgentActivity(name, argRecord);
      try {
        return await handler(args, extra);
      } finally {
        void clearAgentActivity();
      }
    };
    return origRegisterTool(name, meta, wrapped);
  };
}

/* ── list_cards ─────────────────────────────────────────────────── */
server.registerTool("list_cards", {
  title: "List Cards",
  description: "Lists all board cards with LLM access enabled that you can access. Returns card IDs, titles, workspace/board names, and permissions. Use this to discover available cards before calling other tools.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async () => {
  const result = await client.listCards();
  return { content: [{ type: "text" as const, text: result }] };
});

/* ── read_card ──────────────────────────────────────────────────── */
server.registerTool("read_card", {
  title: "Read Card",
  description: "Returns the card content as structured markdown: tasks table, details, connected notes, connected cards, and available actions.",
  inputSchema: ReadCardSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const md = await client.getCard(args.cardId, args.user);
  return { content: [{ type: "text" as const, text: md }] };
});

/* ── create_task ────────────────────────────────────────────────── */
server.registerTool("create_task", {
  title: "Create Task",
  description: "Creates a new task in the specified card. Returns the created task with its auto-assigned number.",
  inputSchema: CreateTaskSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const { cardId, ...body } = args;
  const result = await client.createTask(cardId, body);
  return { content: [{ type: "text" as const, text: result }] };
});

/* ── update_task ────────────────────────────────────────────────── */
server.registerTool("update_task", {
  title: "Update Task",
  description: "Updates any property of an existing task. Only include fields you want to change. Set a field to null to clear it.",
  inputSchema: UpdateTaskSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const { cardId, ...body } = args;
  const result = await client.updateTask(cardId, body);
  return { content: [{ type: "text" as const, text: result }] };
});

/* ── complete_task ──────────────────────────────────────────────── */
server.registerTool("complete_task", {
  title: "Complete Task",
  description: "Marks a task as done. Returns connected cards where the task can be moved next.",
  inputSchema: CompleteTaskSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const result = await client.completeTask(args.cardId, args.taskNumber);
  return { content: [{ type: "text" as const, text: result }] };
});

/* ── move_task ──────────────────────────────────────────────────── */
server.registerTool("move_task", {
  title: "Move Task",
  description: "Moves a task to a connected card. Target card title is case-insensitive. If no connected cards exist, the task is archived.",
  inputSchema: MoveTaskSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const result = await client.moveTask(args.cardId, args.taskNumber, args.targetCardTitle);
  return { content: [{ type: "text" as const, text: result }] };
});

/* ── add_comment ────────────────────────────────────────────────── */
server.registerTool("add_comment", {
  title: "Add Comment",
  description: "Adds a comment to a task. Requires the Comments permission on the card.",
  inputSchema: CommentSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const result = await client.addComment(args.cardId, args.taskNumber, args.text);
  return { content: [{ type: "text" as const, text: result }] };
});

/* ── log_time ──────────────────────────────────────────────────── */
server.registerTool("log_time", {
  title: "Log Time",
  description: "Records a worklog entry on a task. Duration is in seconds (e.g. 1800 = 30 min, 3600 = 1 hour). Requires Flow permission.",
  inputSchema: LogTimeSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const { cardId, ...body } = args;
  const result = await client.logTime(cardId, body);
  return { content: [{ type: "text" as const, text: result }] };
});

/* ── reorder_tasks ──────────────────────────────────────────────── */
server.registerTool("reorder_tasks", {
  title: "Reorder Tasks",
  description: "Reorder tasks in a card. Provide all task numbers in the desired order.",
  inputSchema: ReorderTasksSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const result = await client.reorderTasks(args.cardId, args.taskNumbers);
  return { content: [{ type: "text" as const, text: result }] };
});

/* ── chat_respond ──────────────────────────────────────────────── */
server.registerTool("chat_respond", {
  title: "Respond in Chat",
  description: "Send a response in the card's AI chat. Use this when you receive a chat_message notification from a subscribed card. Your response will appear in the chat UI.",
  inputSchema: {
    ...CardIdArg,
    content: z.string().describe("Your response message"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const result = await client.chatRespond(args.cardId, args.content);
  return { content: [{ type: "text" as const, text: result }] };
});

/* ── chat_history ──────────────────────────────────────────────── */
server.registerTool("chat_history", {
  title: "Read Chat History",
  description: "Read recent chat messages from a card's AI chat. Useful for understanding context before responding to a chat message.",
  inputSchema: {
    ...CardIdArg,
    limit: z.number().optional().describe("Number of messages to retrieve (default 30, max 100)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const result = await client.chatHistory(args.cardId, args.limit);
  return { content: [{ type: "text" as const, text: result }] };
});

/* ── ask_chat ──────────────────────────────────────────────────── */
server.registerTool("ask_chat", {
  title: "Ask in Chat",
  description: [
    "Ask a question in the card's AI chat and wait for the user's answer.",
    "Use this instead of asking in the terminal — the user may only be monitoring the card chat.",
    "Three question types: 'text' (free input), 'options' (clickable choices), 'confirm' (approve/deny).",
    "The user's response will arrive as a channel notification from the chat listener.",
  ].join(" "),
  inputSchema: {
    ...CardIdArg,
    question: z.string().describe("The question to ask the user"),
    type:     z.enum(["text", "options", "confirm"]).describe("Question type: text (free input), options (pick one), confirm (yes/no)"),
    options:  z.array(z.string()).optional().describe("Choices for 'options' type (ignored for other types)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const result = await client.askChat(args.cardId, args.question, args.type, args.options);
  return { content: [{ type: "text" as const, text: result }] };
});

/* ================================================================== */
/*  Workspace-scoped Integration Tools                                 */
/* ================================================================== */

const WorkspaceIdArg = { workspaceId: z.string().describe("Workspace ID") };

/** Helper for integration tools — all route through executeIntegrationTool. */
function registerIntegrationTool(
  name: string,
  title: string,
  description: string,
  extraSchema: Record<string, z.ZodTypeAny>,
  readOnly: boolean,
) {
  server.registerTool(name, {
    title,
    description,
    inputSchema: { ...WorkspaceIdArg, ...extraSchema },
    annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: true },
  }, async (args) => {
    const { workspaceId, ...rest } = args;
    const result = await client.executeIntegrationTool(name, workspaceId, rest);
    return { content: [{ type: "text" as const, text: result }] };
  });
}

/* ── Meta ──────────────────────────────────────────────────────────── */
registerIntegrationTool("list_integrations", "List Integrations",
  "List all connected integrations (GitHub, Slack, Drive, Figma) for a workspace.", {}, true);

/* ── GitHub ─────────────────────────────────────────────────────────── */
registerIntegrationTool("github_list_repos", "GitHub: List Repos",
  "List repositories connected to the workspace.", {}, true);
registerIntegrationTool("github_search_issues", "GitHub: Search Issues",
  "Search issues in a repository.", {
    repo: z.string().describe("Repository full name (e.g. owner/repo)"),
    query: z.string().optional().describe("Search query"),
    state: z.enum(["open", "closed"]).optional().describe("Issue state filter"),
  }, true);
registerIntegrationTool("github_search_prs", "GitHub: Search PRs",
  "Search pull requests in a repository.", {
    repo: z.string().describe("Repository full name"),
    query: z.string().optional().describe("Search query"),
    state: z.enum(["open", "closed"]).optional().describe("PR state filter"),
  }, true);
registerIntegrationTool("github_create_issue", "GitHub: Create Issue",
  "Create a new issue in a repository.", {
    repo: z.string().describe("Repository full name"),
    title: z.string().describe("Issue title"),
    body: z.string().optional().describe("Issue body (markdown)"),
    labels: z.array(z.string()).optional().describe("Label names"),
    assignees: z.array(z.string()).optional().describe("GitHub usernames to assign"),
  }, false);
registerIntegrationTool("github_create_pr", "GitHub: Create PR",
  "Create a pull request.", {
    repo: z.string().describe("Repository full name"),
    title: z.string().describe("PR title"),
    head: z.string().describe("Source branch"),
    base: z.string().describe("Target branch"),
    body: z.string().optional().describe("PR description"),
    draft: z.boolean().optional().describe("Create as draft PR"),
  }, false);
registerIntegrationTool("github_create_repo", "GitHub: Create Repo",
  "Create a new GitHub repository.", {
    name: z.string().describe("Repository name"),
    description: z.string().optional().describe("Repository description"),
    private: z.boolean().optional().describe("Private repo (default: true)"),
    org: z.string().optional().describe("Organization name (omit for personal repo)"),
  }, false);
registerIntegrationTool("github_update_repo", "GitHub: Update Repo",
  "Update repository settings (name, description, visibility).", {
    repo: z.string().describe("Repository full name (e.g. owner/repo)"),
    name: z.string().optional().describe("New repository name"),
    description: z.string().optional().describe("New description"),
    private: z.boolean().optional().describe("Set private/public"),
    homepage: z.string().optional().describe("Homepage URL"),
    archived: z.boolean().optional().describe("Archive/unarchive"),
  }, false);
registerIntegrationTool("github_merge_pr", "GitHub: Merge PR",
  "Merge a pull request.", {
    repo: z.string().describe("Repository full name"),
    pullNumber: zNum("Pull request number"),
    mergeMethod: z.enum(["merge", "squash", "rebase"]).optional().describe("Merge method (default: merge)"),
    commitTitle: z.string().optional().describe("Custom commit title for squash/merge"),
  }, false);
registerIntegrationTool("github_close_pr", "GitHub: Close PR",
  "Close a pull request without merging.", {
    repo: z.string().describe("Repository full name"),
    pullNumber: zNum("Pull request number"),
  }, false);
registerIntegrationTool("github_close_issue", "GitHub: Close Issue",
  "Close a GitHub issue.", {
    repo: z.string().describe("Repository full name"),
    issueNumber: zNum("Issue number"),
  }, false);
registerIntegrationTool("github_get_file", "GitHub: Get File",
  "Get file contents from a repository.", {
    repo: z.string().describe("Repository full name"),
    path: z.string().describe("File path (e.g. src/index.ts)"),
    ref: z.string().optional().describe("Branch or commit SHA"),
  }, true);
registerIntegrationTool("github_create_branch", "GitHub: Create Branch",
  "Create a new branch from an existing ref.", {
    repo: z.string().describe("Repository full name"),
    branch: z.string().describe("New branch name"),
    fromRef: z.string().optional().describe("Source branch (default: main)"),
  }, false);

/* ── Google Drive ───────────────────────────────────────────────────── */
registerIntegrationTool("drive_search_files", "Drive: Search Files",
  "Search files in the connected Google Drive.", {
    query: z.string().optional().describe("Search query (file name)"),
  }, true);
registerIntegrationTool("drive_get_file", "Drive: Get File",
  "Get file metadata and embed URL.", {
    fileId: z.string().describe("Google Drive file ID"),
  }, true);
registerIntegrationTool("drive_create_doc", "Drive: Create Document",
  "Create a new Google Docs document.", {
    title: z.string().describe("Document title"),
    content: z.string().optional().describe("Initial text content"),
  }, false);
registerIntegrationTool("drive_create_sheet", "Drive: Create Spreadsheet",
  "Create a new Google Sheets spreadsheet.", {
    title: z.string().describe("Spreadsheet title"),
  }, false);
registerIntegrationTool("drive_create_folder", "Drive: Create Folder",
  "Create a folder in Google Drive.", {
    name: z.string().describe("Folder name"),
    parentId: z.string().optional().describe("Parent folder ID"),
  }, false);
registerIntegrationTool("drive_delete_file", "Drive: Delete File",
  "Delete a file or folder from Google Drive.", {
    fileId: z.string().describe("Google Drive file or folder ID"),
  }, false);
registerIntegrationTool("drive_update_file", "Drive: Update File",
  "Rename a file or update its description.", {
    fileId: z.string().describe("Google Drive file ID"),
    name: z.string().optional().describe("New file name"),
    description: z.string().optional().describe("New description"),
  }, false);
registerIntegrationTool("drive_move_file", "Drive: Move File",
  "Move a file to a different folder.", {
    fileId: z.string().describe("Google Drive file ID"),
    targetFolderId: z.string().describe("Destination folder ID"),
  }, false);

/* ── Slack ───────────────────────────────────────────────────────────── */
registerIntegrationTool("slack_list_channels", "Slack: List Channels",
  "List available Slack channels.", {}, true);
registerIntegrationTool("slack_send_message", "Slack: Send Message",
  "Send a message to a Slack channel. Omit channel to use the default.", {
    channel: z.string().optional().describe("Channel ID (uses default if omitted)"),
    text: z.string().describe("Message text"),
  }, false);
registerIntegrationTool("slack_send_thread_reply", "Slack: Reply in Thread",
  "Reply to a message thread in Slack.", {
    channel: z.string().describe("Channel ID"),
    threadTs: z.string().describe("Thread timestamp (ts) of the parent message"),
    text: z.string().describe("Reply text"),
  }, false);
registerIntegrationTool("slack_create_channel", "Slack: Create Channel",
  "Create a new Slack channel.", {
    name: z.string().describe("Channel name (lowercase, hyphens allowed)"),
    isPrivate: z.boolean().optional().describe("Create as private channel (default: false)"),
  }, false);
registerIntegrationTool("slack_archive_channel", "Slack: Archive Channel",
  "Archive a Slack channel.", {
    channel: z.string().describe("Channel ID"),
  }, false);
registerIntegrationTool("slack_update_channel", "Slack: Update Channel",
  "Rename a channel or update its topic/purpose.", {
    channel: z.string().describe("Channel ID"),
    name: z.string().optional().describe("New channel name"),
    topic: z.string().optional().describe("New channel topic"),
    purpose: z.string().optional().describe("New channel purpose"),
  }, false);
registerIntegrationTool("slack_get_channel_history", "Slack: Channel History",
  "Read recent messages from a Slack channel.", {
    channel: z.string().describe("Channel ID"),
    limit: zNumOptional("Number of messages (default 20, max 100)"),
  }, true);

/* ── Figma ───────────────────────────────────────────────────────────── */
registerIntegrationTool("figma_get_file", "Figma: Get File",
  "Get Figma file metadata (name, thumbnail, pages).", {
    fileKeyOrUrl: z.string().describe("Figma file key or full URL"),
  }, true);
registerIntegrationTool("figma_get_comments", "Figma: Get Comments",
  "Get comments on a Figma file.", {
    fileKey: z.string().describe("Figma file key"),
  }, true);
registerIntegrationTool("figma_post_comment", "Figma: Post Comment",
  "Post a comment on a Figma file.", {
    fileKey: z.string().describe("Figma file key"),
    message: z.string().describe("Comment text"),
  }, false);

/* ── Google Calendar ─────────────────────────────────────────────────── */
registerIntegrationTool("calendar_list_events", "Calendar: List Events",
  "List upcoming calendar events (defaults to next 7 days).", {
    timeMin: z.string().optional().describe("Start time (ISO, default: now)"),
    timeMax: z.string().optional().describe("End time (ISO, default: +7 days)"),
    maxResults: zNumOptional("Max events to return (default 20)"),
  }, true);
registerIntegrationTool("calendar_get_event", "Calendar: Get Event",
  "Get details of a specific calendar event.", {
    eventId: z.string().describe("Calendar event ID"),
  }, true);
registerIntegrationTool("calendar_create_event", "Calendar: Create Event",
  "Create a new calendar event.", {
    summary: z.string().describe("Event title"),
    start: z.string().describe("Start time (ISO)"),
    end: z.string().describe("End time (ISO)"),
    description: z.string().optional().describe("Event description"),
    attendees: z.array(z.string()).optional().describe("Attendee email addresses"),
    timeZone: z.string().optional().describe("Time zone (default: UTC)"),
  }, false);
registerIntegrationTool("calendar_update_event", "Calendar: Update Event",
  "Update an existing calendar event.", {
    eventId: z.string().describe("Calendar event ID"),
    summary: z.string().optional().describe("New title"),
    start: z.string().optional().describe("New start time (ISO)"),
    end: z.string().optional().describe("New end time (ISO)"),
    description: z.string().optional().describe("New description"),
    timeZone: z.string().optional().describe("Time zone (default: UTC)"),
  }, false);
registerIntegrationTool("calendar_delete_event", "Calendar: Delete Event",
  "Delete a calendar event.", {
    eventId: z.string().describe("Calendar event ID"),
  }, false);

/* ------------------------------------------------------------------ */
/*  Shared subscribe / unsubscribe logic                               */
/* ------------------------------------------------------------------ */

type TaskEntry = { id: string; title: string; taskNumber?: number; type?: string; priority?: string };

/**
 * Core subscription logic — used by both the `subscribe_card` tool and
 * UI-driven assignment via the agentSessions watcher.
 *
 * @param fromUI  If true, the subscription was triggered by the UI (badge drop).
 *                Session doc is updated but status change is skipped (UI already wrote it).
 */
async function performSubscribe(cardId: string, workspaceId: string, boardId: string, nodeId: string, fromUI = false): Promise<string> {
  if (subscriptions.has(cardId)) {
    return `Already subscribed to card ${cardId}.`;
  }

  await ensureFirebaseAuth();
  const db = getDb();

  const nodeRef = doc(db, "workspaces", workspaceId, "boards", boardId, "canvasNodes", nodeId);

  const taskIds = new Set<string>();
  let initialLoad = true;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingNewTaskIds = new Set<string>();
  const SETTLE_DELAY_MS = 2000;

  const unsubscribe = onSnapshot(nodeRef, async (snap) => {
    if (!snap.exists()) {
      process.stderr.write(`[mcp] Snapshot for ${cardId}: document does not exist\n`);
      return;
    }

    const data = snap.data();
    const nodeData = data?.data as { tasks?: TaskEntry[] } | undefined;
    const currentTasks = nodeData?.tasks ?? [];

    if (initialLoad) {
      for (const t of currentTasks) taskIds.add(t.id);
      initialLoad = false;
      process.stderr.write(`[mcp] Subscription baseline set for ${cardId}: ${taskIds.size} tasks\n`);
      return;
    }

    const currentTaskIdSet = new Set(currentTasks.map((t) => t.id));

    for (const id of taskIds) {
      if (!currentTaskIdSet.has(id)) {
        taskIds.delete(id);
        process.stderr.write(`[mcp] Task ${id} left card ${cardId} — removed from baseline\n`);
      }
    }

    const newTasks = currentTasks.filter((t) => !taskIds.has(t.id));

    for (const pid of pendingNewTaskIds) {
      if (!currentTaskIdSet.has(pid)) {
        pendingNewTaskIds.delete(pid);
        process.stderr.write(`[mcp] Task ${pid} left card ${cardId} (drag pass-through)\n`);
      }
    }

    if (newTasks.length === 0) {
      process.stderr.write(`[mcp] Snapshot for ${cardId}: ${currentTasks.length} tasks, no new\n`);
      return;
    }

    for (const t of newTasks) pendingNewTaskIds.add(t.id);

    process.stderr.write(`[mcp] ${newTasks.length} new task(s) detected on ${cardId}, waiting ${SETTLE_DELAY_MS}ms to confirm...\n`);

    if (pendingTimer) clearTimeout(pendingTimer);
    const tasksSnapshot = [...currentTasks];

    pendingTimer = setTimeout(async () => {
      pendingTimer = null;
      const confirmedTasks: TaskEntry[] = [];
      for (const t of tasksSnapshot) {
        if (pendingNewTaskIds.has(t.id)) {
          confirmedTasks.push(t);
          pendingNewTaskIds.delete(t.id);
          taskIds.add(t.id);
        }
      }
      if (confirmedTasks.length === 0) {
        process.stderr.write(`[mcp] All pending tasks left ${cardId} — no notification\n`);
        return;
      }
      process.stderr.write(`[mcp] ${confirmedTasks.length} task(s) confirmed on ${cardId}, notifying...\n`);

      for (const task of confirmedTasks) {
        const msg = [
          `New task on card "${cardId}":`,
          `#${task.taskNumber ?? "?"} — ${task.title}`,
          `Type: ${task.type ?? "task"} | Priority: ${task.priority ?? "medium"}`,
          ``,
          `Use read_card to see full details, then start working on it.`,
        ].join("\n");

        try {
          await server.server.notification({
            method: "notifications/claude/channel",
            params: { content: msg, meta: { cardId, taskNumber: String(task.taskNumber ?? "?") } },
          });
          process.stderr.write(`[mcp] Channel notification sent for #${task.taskNumber ?? "?"}\n`);
        } catch (err) {
          process.stderr.write(`[mcp] Channel notification FAILED for #${task.taskNumber ?? "?"}: ${String(err)}\n`);
        }
      }
    }, SETTLE_DELAY_MS);
  }, (err) => {
    process.stderr.write(`[mcp] Firestore listener error for ${cardId}: ${String(err)}\n`);
    server.server.notification({
      method: "notifications/claude/channel",
      params: { content: `Subscription error for card ${cardId}: ${String(err)}`, meta: { cardId, error: "true" } },
    }).catch((e) => {
      process.stderr.write(`[mcp] Error notification also failed: ${String(e)}\n`);
    });
  });

  // Chat messages listener
  const chatColRef = collection(db, "workspaces", workspaceId, "boards", boardId, "canvasNodes", nodeId, "chatMessages");
  const chatQuery = query(chatColRef, orderBy("timestamp", "asc"), limitToLast(1));
  let lastProcessedChatTs = Date.now();

  const chatUnsubscribe = onSnapshot(chatQuery, (snap) => {
    if (snap.empty) return;
    const latestDoc = snap.docs[snap.docs.length - 1];
    const d = latestDoc.data();
    const role = d.role as string;
    const timestamp = (d.timestamp as number) ?? 0;
    const content = (d.content as string) ?? "";
    const senderName = (d.senderName as string) ?? "User";

    if (role !== "user" || timestamp <= lastProcessedChatTs) return;
    lastProcessedChatTs = timestamp;

    // Parse attachments if present
    const attachments = d.attachments as Array<{ name?: string; mimeType?: string; url?: string; size?: number }> | undefined;
    const attachmentLines: string[] = [];
    const hasImages = attachments && Array.isArray(attachments) && attachments.some((a) => a.mimeType?.startsWith("image/"));
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      attachmentLines.push(`Attachments:`);
      for (const a of attachments) {
        const sizeStr = (a.size ?? 0) < 1024 * 1024 ? `${((a.size ?? 0) / 1024).toFixed(0)} KB` : `${((a.size ?? 0) / (1024 * 1024)).toFixed(1)} MB`;
        attachmentLines.push(`- ${a.name ?? "file"} (${a.mimeType ?? "unknown"}, ${sizeStr}) ${a.url ?? ""}`);
      }
      if (hasImages) {
        attachmentLines.push("");
        attachmentLines.push("IMPORTANT: To view images, download them with curl and read with the Read tool:");
        attachmentLines.push('curl -sL "URL" -o /tmp/chat-image.png && then use Read tool on /tmp/chat-image.png');
      }
    }

    process.stderr.write(`[mcp] Chat message from ${senderName} on ${cardId}: ${content.slice(0, 80)}${attachmentLines.length > 0 ? ` [+${attachments!.length} files]` : ""}...\n`);

    const msg = [
      `<channel source="is-team" cardId="${cardId}" type="chat_message">`,
      `Chat message on card "${cardId}":`,
      `[${senderName}]: ${content}`,
      ...(attachmentLines.length > 0 ? ["", ...attachmentLines] : []),
      ``,
      `Use chat_history for context if needed, then chat_respond to reply.`,
      `</channel>`,
    ].join("\n");

    server.server.notification({
      method: "notifications/claude/channel",
      params: { content: msg, meta: { cardId, type: "chat_message", senderName } },
    }).catch((err) => {
      process.stderr.write(`[mcp] Chat notification FAILED for ${cardId}: ${String(err)}\n`);
    });
  }, (err) => {
    process.stderr.write(`[mcp] Chat listener error for ${cardId}: ${String(err)}\n`);
  });

  // AI presence (per-card, existing system)
  const presenceInterval = await setAiPresence(workspaceId, nodeId);

  subscriptions.set(cardId, { cardId, workspaceId, boardId, nodeId, unsubscribe, chatUnsubscribe, taskIds, presenceInterval });

  // Update agent session status — must await to ensure badge appears on card
  try {
    await ensureFirebaseAuth();
    const rtdb2 = getRtdb();
    const sessionPath = `${AGENT_SESSION_ROOT}/${workspaceId}/${SESSION_ID}`;
    const updateData = fromUI
      ? { status: "subscribed" as const, lastHeartbeat: Date.now() }
      : { status: "subscribed" as const, assignedCard: { cardId, boardId, nodeId }, lastHeartbeat: Date.now() };
    await rtdbUpdate(rtdbRef(rtdb2, sessionPath), updateData);
    process.stderr.write(`[mcp] Agent session updated: subscribed to ${cardId} (path: ${sessionPath})\n`);
  } catch (e) {
    process.stderr.write(`[mcp] Failed to update session status: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  }

  return [
    `Subscribed to card ${cardId}. You will be notified when new tasks appear and chat messages will be forwarded to you.`,
    ``,
    `IMPORTANT: When you need to ask the user a question, get approval, or offer choices, use the ask_chat tool instead of asking in the terminal.`,
    `The user may only be monitoring the card chat — terminal questions will go unseen.`,
    `Use ask_chat with type "text" for open questions, "options" for multiple choice, or "confirm" for yes/no approval.`,
  ].join("\n");
}

/**
 * Core unsubscription logic.
 * @param fromUI  If true, the unsubscription was triggered by the UI (badge click).
 */
async function performUnsubscribe(cardId: string, fromUI = false): Promise<string> {
  const sub = subscriptions.get(cardId);
  if (!sub) return `Not subscribed to card ${cardId}.`;

  sub.unsubscribe();
  if (sub.chatUnsubscribe) sub.chatUnsubscribe();
  if (sub.presenceInterval) clearInterval(sub.presenceInterval);
  await clearAiPresence(sub.workspaceId, sub.nodeId);
  subscriptions.delete(cardId);

  // Update agent session — must await to ensure badge is removed from card
  try {
    if (!fromUI) {
      await ensureFirebaseAuth();
      const rtdb2 = getRtdb();
      const sessionPath = `${AGENT_SESSION_ROOT}/${sub.workspaceId}/${SESSION_ID}`;
      await rtdbUpdate(rtdbRef(rtdb2, sessionPath), { status: "idle", assignedCard: null, lastHeartbeat: Date.now() });
      process.stderr.write(`[mcp] Agent session updated: idle (unsubscribed from ${cardId})\n`);
    }
  } catch (e) {
    process.stderr.write(`[mcp] Failed to update session status: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  }

  return `Unsubscribed from card ${cardId}.`;
}

/* ── create_note ────────────────────────────────────────────────── */
server.registerTool("create_note", {
  title: "Create Note",
  description: "Create a new note on the canvas board. Supports markdown content. Use nearNodeId to place it next to a card and auto-connect with an edge.",
  inputSchema: {
    workspaceId: z.string().describe("Workspace ID"),
    boardId:     z.string().describe("Board ID"),
    title:       z.string().optional().describe("Note title"),
    content:     z.string().optional().describe("Note content (markdown supported: headings, lists, bold, links, checkboxes)"),
    color:       z.number().optional().describe("Color 0-5: 0=Yellow, 1=Mint, 2=Pink, 3=Lavender, 4=Sky, 5=Peach"),
    nearNodeId:  z.string().optional().describe("Place note next to this node and auto-connect with an edge"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const { workspaceId, ...rest } = args;
  const result = await client.executeIntegrationTool("create_note", workspaceId, rest);
  return { content: [{ type: "text" as const, text: result }] };
});

/* ── update_note ────────────────────────────────────────────────── */
server.registerTool("update_note", {
  title: "Update Note",
  description: "Update an existing note's title, content, color, or width (in canvas pixels).",
  inputSchema: {
    workspaceId: z.string().describe("Workspace ID"),
    boardId:     z.string().describe("Board ID"),
    noteId:      z.string().describe("Note ID (e.g. note-1712345678)"),
    title:       z.string().optional().describe("New title"),
    content:     z.string().optional().describe("New content (markdown supported)"),
    color:       z.number().optional().describe("New color 0-5"),
    width:       z.number().optional().describe("New width in pixels (100–1200). Sets style.width."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const { workspaceId, ...rest } = args;
  const result = await client.executeIntegrationTool("update_note", workspaceId, rest);
  return { content: [{ type: "text" as const, text: result }] };
});

/* ── create_edge ────────────────────────────────────────────────── */
server.registerTool("create_edge", {
  title: "Create Edge",
  description: "Connect two canvas nodes (cards or notes) with a directional edge. Optionally specify which side of each node the edge connects to.",
  inputSchema: {
    workspaceId:  z.string().describe("Workspace ID"),
    boardId:      z.string().describe("Board ID"),
    sourceNodeId: z.string().describe("Source node ID"),
    targetNodeId: z.string().describe("Target node ID"),
    sourceHandle: z.enum(["top", "right", "bottom", "left"]).optional().describe("Side of source node to connect from (default: auto)"),
    targetHandle: z.enum(["top", "right", "bottom", "left"]).optional().describe("Side of target node to connect to (default: auto)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const { workspaceId, ...rest } = args;
  const result = await client.executeIntegrationTool("create_edge", workspaceId, rest);
  return { content: [{ type: "text" as const, text: result }] };
});

/* ── move_node ──────────────────────────────────────────────────── */
server.registerTool("move_node", {
  title: "Move Node",
  description: "Move a canvas node (card or note) to a new position. Use read_card to see current node IDs.",
  inputSchema: {
    workspaceId: z.string().describe("Workspace ID"),
    boardId:     z.string().describe("Board ID"),
    nodeId:      z.string().describe("Node ID to move (e.g. col-123 or note-123)"),
    x:           z.number().describe("New X coordinate"),
    y:           z.number().describe("New Y coordinate"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const { workspaceId, ...rest } = args;
  const result = await client.executeIntegrationTool("move_node", workspaceId, rest);
  return { content: [{ type: "text" as const, text: result }] };
});

/* ── delete_edge ────────────────────────────────────────────────── */
server.registerTool("delete_edge", {
  title: "Delete Edge",
  description: "Remove a connection (edge) between two canvas nodes.",
  inputSchema: {
    workspaceId: z.string().describe("Workspace ID"),
    boardId:     z.string().describe("Board ID"),
    edgeId:      z.string().describe("Edge ID to delete"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async (args) => {
  const { workspaceId, ...rest } = args;
  const result = await client.executeIntegrationTool("delete_edge", workspaceId, rest);
  return { content: [{ type: "text" as const, text: result }] };
});

/* ── create_stack ──────────────────────────────────────────────── */
server.registerTool("create_stack", {
  title: "Create Stack",
  description: "Group multiple notes into a stack. Notes are visually collapsed into a single stack node on the canvas. Their edges are removed. Minimum 2 notes required.",
  inputSchema: {
    workspaceId: z.string().describe("Workspace ID"),
    boardId:     z.string().describe("Board ID"),
    noteIds:     z.array(z.string()).describe("Array of note IDs to group into a stack (minimum 2)"),
    title:       z.string().optional().describe("Stack title (auto-generated from first note if omitted)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const { workspaceId, ...rest } = args;
  const result = await client.executeIntegrationTool("create_stack", workspaceId, rest);
  return { content: [{ type: "text" as const, text: result }] };
});

/* ── add_to_stack ──────────────────────────────────────────────── */
server.registerTool("add_to_stack", {
  title: "Add Notes to Stack",
  description: "Add one or more notes to an existing stack. The notes will be hidden from the canvas and grouped under the stack.",
  inputSchema: {
    workspaceId: z.string().describe("Workspace ID"),
    boardId:     z.string().describe("Board ID"),
    stackId:     z.string().describe("Stack node ID (e.g. stack-1712345678)"),
    noteIds:     z.array(z.string()).describe("Note IDs to add to the stack"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const { workspaceId, ...rest } = args;
  const result = await client.executeIntegrationTool("add_to_stack", workspaceId, rest);
  return { content: [{ type: "text" as const, text: result }] };
});

/* ── dissolve_stack ────────────────────────────────────────────── */
server.registerTool("dissolve_stack", {
  title: "Dissolve Stack",
  description: "Dissolve a stack, restoring all notes as independent nodes on the canvas. The stack node is deleted.",
  inputSchema: {
    workspaceId: z.string().describe("Workspace ID"),
    boardId:     z.string().describe("Board ID"),
    stackId:     z.string().describe("Stack node ID to dissolve"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, async (args) => {
  const { workspaceId, ...rest } = args;
  const result = await client.executeIntegrationTool("dissolve_stack", workspaceId, rest);
  return { content: [{ type: "text" as const, text: result }] };
});

/* ── subscribe_card ─────────────────────────────────────────────── */
server.registerTool("subscribe_card", {
  title: "Subscribe to Card",
  description: [
    "Start listening for new tasks on a card in real-time.",
    "When a new task appears, you will receive a channel notification with the task details.",
    "Use list_cards first — it returns workspaceId, boardId, and nodeId for each card.",
    "The subscription persists until you call unsubscribe_card or the session ends.",
  ].join(" "),
  inputSchema: SubscribeCardSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const text = await performSubscribe(args.cardId, args.workspaceId, args.boardId, args.nodeId);
  return { content: [{ type: "text" as const, text }] };
});

/* ── unsubscribe_card ───────────────────────────────────────────── */
server.registerTool("unsubscribe_card", {
  title: "Unsubscribe from Card",
  description: "Stop listening for new tasks on a card. Cancels a previous subscribe_card.",
  inputSchema: UnsubscribeCardSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const text = await performUnsubscribe(args.cardId);
  return { content: [{ type: "text" as const, text }] };
});

/* ================================================================== */
/*  Workspace primitives — Board / Card / Member CRUD (v3 Sprint 1)    */
/* ================================================================== */

/** Helper for workspace-scoped primitive tools (no integration dispatch). */
function registerWorkspaceTool(
  name: string,
  title: string,
  description: string,
  extraSchema: Record<string, z.ZodTypeAny>,
  readOnly: boolean,
  destructive = false,
) {
  server.registerTool(name, {
    title,
    description,
    inputSchema: { ...WorkspaceIdArg, ...extraSchema },
    annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: false },
  }, async (args) => {
    const { workspaceId, ...rest } = args;
    const result = await client.executeWorkspaceTool(name, workspaceId, rest);
    return { content: [{ type: "text" as const, text: result }] };
  });
}

/* ── Board CRUD ─────────────────────────────────────────────────── */
registerWorkspaceTool("list_boards", "List Boards",
  "List every board in a workspace that the caller can access. Owner sees all; members only see public + explicitly allowed boards.",
  {}, true);

registerWorkspaceTool("create_board", "Create Board",
  "Create a new board in the workspace. Returns the new boardId. Visibility defaults to ALL (everyone in the workspace can see).",
  {
    name:       z.string().describe("Board name"),
    icon:       z.string().optional().describe("Icon key (default: kanban)"),
    visibility: z.enum(["all", "selected"]).optional().describe("ALL = open to all members; SELECTED = only allowedMembers"),
  }, false);

registerWorkspaceTool("update_board", "Update Board",
  "Rename a board, change its icon/visibility/allowed-members, or set its budget. Only include fields you want to change.",
  {
    boardId:        z.string().describe("Board ID"),
    name:           z.string().optional().describe("New name"),
    icon:           z.string().optional().describe("New icon key"),
    visibility:     z.enum(["all", "selected"]).optional().describe("Visibility — ALL or SELECTED"),
    allowedMembers: z.array(z.string()).optional().describe("UIDs of members allowed when visibility=SELECTED"),
    budgetAmount:   z.number().nullable().optional().describe("Budget amount, or null to clear"),
    budgetType:     z.enum(["currency", "hours"]).nullable().optional().describe("Budget type, or null to clear"),
  }, false);

registerWorkspaceTool("delete_board", "Delete Board",
  "Permanently delete a board AND every card/note/edge inside it. Owner only. This cannot be undone.",
  {
    boardId: z.string().describe("Board ID"),
  }, false, true);

/* ── Members ────────────────────────────────────────────────────── */
registerWorkspaceTool("list_members", "List Members",
  "List every workspace member with uid, email, displayName, role, jobTitle. Use the uid for assignee/autoAssignee/autoReporter on tasks and cards.",
  {}, true);

/* ── Card (taskColumn) CRUD ────────────────────────────────────── */
registerWorkspaceTool("create_card", "Create Card",
  "Create a new kanban card (column) on a board. The returned cardId/nodeId can be passed to subscribe_card or read_card.",
  {
    boardId:    z.string().describe("Board ID where the card will live"),
    title:      z.string().describe("Card title (e.g. \"Backlog\", \"In Progress\")"),
    icon:       z.string().optional().describe("Icon key"),
    color:      z.number().optional().describe("Color index 0-9"),
    position:   z.object({ x: z.number(), y: z.number() }).optional().describe("Canvas position; auto-randomized if omitted"),
    llmAccess:  z.boolean().optional().describe("Allow AI agents to read this card (default: false)"),
    llmFlow:    z.boolean().optional().describe("Allow AI agents to create/update tasks (default: false)"),
    llmComment: z.boolean().optional().describe("Allow AI agents to comment on tasks (default: false)"),
    llmContext: z.string().optional().describe("Free-form prompt context shown to AI agents on this card"),
  }, false);

registerWorkspaceTool("update_card", "Update Card",
  "Rename a card or change its color/icon/AI access flags. Set llmContext to null to clear it.",
  {
    boardId:    z.string().describe("Board ID"),
    cardId:     z.string().describe("Card ID (e.g. col-1773256154568)"),
    title:      z.string().optional().describe("New title"),
    icon:       z.string().nullable().optional().describe("Icon key, or null to clear"),
    color:      z.number().nullable().optional().describe("Color index, or null to clear"),
    llmAccess:  z.boolean().optional().describe("Toggle AI read access"),
    llmFlow:    z.boolean().optional().describe("Toggle AI create/update access"),
    llmComment: z.boolean().optional().describe("Toggle AI comment access"),
    llmContext: z.string().nullable().optional().describe("AI prompt context, or null to clear"),
  }, false);

registerWorkspaceTool("update_card_settings", "Update Card Settings",
  [
    "Configure card automation rules: auto-assign, auto-reporter, auto-due-date, auto-archive, max-active-tasks,",
    "auto-label, notify-on-enter, stale-task move, AI automation prompt. Pass uid for autoAssignee/autoReporter,",
    "or null to clear. Only include fields you want to change.",
  ].join(" "),
  {
    boardId:              z.string().describe("Board ID"),
    cardId:               z.string().describe("Card ID"),
    autoAssignee:         z.string().nullable().optional().describe("Member UID to auto-assign new tasks to, or null to clear"),
    autoAssigneeOnDrop:   z.boolean().optional().describe("Reassign on drop, not just create"),
    autoReporter:         z.string().nullable().optional().describe("Member UID to auto-set as reporter, or null to clear"),
    autoReporterOnDrop:   z.boolean().optional().describe("Reset reporter on drop"),
    autoDueDays:          z.number().nullable().optional().describe("Days from creation to set as due date, or null"),
    autoDueDaysOnDrop:    z.boolean().optional().describe("Reset due date on drop"),
    maxActiveTasks:       z.number().nullable().optional().describe("Max non-archived tasks before oldest auto-archives"),
    autoArchive:          z.boolean().optional().describe("Auto-archive completed tasks after N days"),
    autoArchiveDays:      z.number().nullable().optional().describe("Days before completed task auto-archives"),
    autoComplete:         z.boolean().optional().describe("Mark tasks as completed when they enter this card"),
    autoLabel:            z.string().nullable().optional().describe("Label string to auto-add on entry, or null"),
    autoLabelColor:       z.string().nullable().optional().describe("Hex color for auto-label, or null"),
    notifyOnEnter:        z.boolean().optional().describe("Notify assignee when their task enters this card"),
    autoMoveStaleDays:    z.number().nullable().optional().describe("Auto-move tasks idle for N days, or null"),
    autoMoveStaleTarget:  z.string().nullable().optional().describe("Target card ID for stale move, or null"),
    aiAutomation:         z.boolean().optional().describe("Enable AI automation on tasks entering this card"),
    aiAutomationPrompt:   z.string().nullable().optional().describe("Prompt evaluated for entering tasks, or null"),
  }, false);

registerWorkspaceTool("delete_card", "Delete Card",
  "Permanently delete a card and every connected edge. Tasks inside the card are removed with it. Cannot be undone.",
  {
    boardId: z.string().describe("Board ID"),
    cardId:  z.string().describe("Card ID to delete"),
  }, false, true);

/* ── Note list + delete ────────────────────────────────────────── */
registerWorkspaceTool("list_notes", "List Notes",
  "List notes on a board. Each entry includes id, title, color, hasEdges. Set orphansOnly=true to return only notes with no incoming/outgoing edges.",
  {
    boardId:     z.string().describe("Board ID"),
    orphansOnly: z.boolean().optional().describe("Return only notes that have no edges (default: false)"),
  }, true);

registerWorkspaceTool("list_edges", "List Edges",
  "List canvas edges on a board. Each entry: id, source, target, sourceHandle (top/right/bottom/left or null), targetHandle, label. Pass nodeId to filter to edges touching a single node.",
  {
    boardId: z.string().describe("Board ID"),
    nodeId:  z.string().optional().describe("Optional — filter to edges where source==nodeId OR target==nodeId"),
  }, true);

registerWorkspaceTool("delete_note", "Delete Note",
  "Permanently delete a note from the canvas along with any edges connected to it.",
  {
    boardId: z.string().describe("Board ID"),
    noteId:  z.string().describe("Note ID (e.g. note-1773256154568)"),
  }, false, true);

registerWorkspaceTool("delete_task", "Delete Task",
  "Permanently delete a single task from a card. To remove without losing history, prefer update_task with archived=true.",
  {
    boardId:    z.string().describe("Board ID containing the card"),
    cardId:     z.string().describe("Card ID containing the task"),
    taskNumber: zNum("Task number to delete"),
  }, false, true);

/* ================================================================== */
/*  Collaboration — Comments / Worklog / Attachments (v3 Sprint 2)     */
/* ================================================================== */

/* ── Comments ──────────────────────────────────────────────────── */
registerWorkspaceTool("list_comments", "List Comments",
  "List comments on a task (newest first). Returns id, type, text, authorUid/Name, createdAt, mentionedUids.",
  {
    boardId:    z.string().describe("Board ID"),
    cardId:     z.string().describe("Card ID"),
    taskNumber: zNum("Task number"),
    limit:      z.number().optional().describe("Max comments to return (default 20, max 100)"),
  }, true);

registerWorkspaceTool("update_comment", "Update Comment",
  "Edit a comment's text. Author or workspace owner only. Activity-log entries cannot be edited.",
  {
    commentId: z.string().describe("Comment ID returned by list_comments or add_comment"),
    text:      z.string().describe("New comment text (max 10000 chars)"),
  }, false);

registerWorkspaceTool("delete_comment", "Delete Comment",
  "Permanently delete a comment. Author or workspace owner only.",
  {
    commentId: z.string().describe("Comment ID"),
  }, false, true);

/* ── Worklog ───────────────────────────────────────────────────── */
registerWorkspaceTool("list_worklogs", "List Worklogs",
  "List worklog entries with flexible filters: by task (boardId+cardId+taskNumber), by user (uid), or by date range (YYYY-MM-DD). Returns up to 20 newest by default.",
  {
    boardId:    z.string().optional().describe("Filter to one task — board ID"),
    cardId:     z.string().optional().describe("Filter to one task — card ID"),
    taskNumber: zNumOptional("Filter to one task — task number"),
    uid:        z.string().optional().describe("Filter by member uid"),
    dateFrom:   z.string().optional().describe("Inclusive start date (YYYY-MM-DD)"),
    dateTo:     z.string().optional().describe("Inclusive end date (YYYY-MM-DD)"),
    limit:      z.number().optional().describe("Max entries (default 20, max 100)"),
  }, true);

registerWorkspaceTool("get_worklog", "Get Worklog",
  "Read a single worklog entry by ID.",
  {
    worklogId: z.string().describe("Worklog ID"),
  }, true);

registerWorkspaceTool("update_worklog", "Update Worklog",
  "Edit a worklog's duration, description, or date. Worklog author or workspace owner only.",
  {
    worklogId:   z.string().describe("Worklog ID"),
    duration:    z.number().optional().describe("Duration in seconds (60–86400, i.e. 1 min – 24 h)"),
    description: z.string().optional().describe("New description (max 2000 chars)"),
    date:        z.string().optional().describe("New date (YYYY-MM-DD)"),
  }, false);

registerWorkspaceTool("delete_worklog", "Delete Worklog",
  "Permanently delete a worklog entry. Author or workspace owner only.",
  {
    worklogId: z.string().describe("Worklog ID"),
  }, false, true);

registerWorkspaceTool("get_active_timer", "Get Active Timer",
  "Read the currently-running timer for a member. Omit uid to read the caller's own timer. Returns active=false if no timer is running.",
  {
    uid: z.string().optional().describe("Member uid (defaults to caller)"),
  }, true);

/* ── Files & Attachments ───────────────────────────────────────── */
registerWorkspaceTool("list_files", "List Workspace Files",
  "List files uploaded to the workspace's file library. Filter by mime category and/or name search. Returns id, name, mimeType, size, url.",
  {
    mimeFilter: z.enum(["image", "document"]).optional().describe("image = only images, document = everything else"),
    search:     z.string().optional().describe("Substring match on file name"),
    cursor:     z.string().optional().describe("Pagination cursor (file ID returned in previous page)"),
    limit:      z.number().optional().describe("Page size (default 20, max 100)"),
  }, true);

registerWorkspaceTool("delete_file", "Delete File",
  "Permanently delete a file from storage AND its Firestore record. Uploader or workspace owner only.",
  {
    fileId: z.string().describe("File ID"),
  }, false, true);

registerWorkspaceTool("add_task_attachment", "Add Task Attachment",
  "Attach an existing workspace file to a task. The file ID must come from list_files.",
  {
    boardId:    z.string().describe("Board ID"),
    cardId:     z.string().describe("Card ID"),
    taskNumber: zNum("Task number"),
    fileId:     z.string().describe("File ID from list_files"),
  }, false);

registerWorkspaceTool("remove_task_attachment", "Remove Task Attachment",
  "Detach a file from a task. The underlying file is NOT deleted (use delete_file for that).",
  {
    boardId:      z.string().describe("Board ID"),
    cardId:       z.string().describe("Card ID"),
    taskNumber:   zNum("Task number"),
    attachmentId: z.string().describe("Attachment ID (== file ID)"),
  }, false);

registerWorkspaceTool("list_task_attachments", "List Task Attachments",
  "List files attached to a task. Returns id, name, mimeType, size, url for each attachment.",
  {
    boardId:    z.string().describe("Board ID"),
    cardId:     z.string().describe("Card ID"),
    taskNumber: zNum("Task number"),
  }, true);

/* ================================================================== */
/*  Team Ops — Members / Invites / Subscribers (v3 Sprint 3)           */
/* ================================================================== */

/* ── Invites ───────────────────────────────────────────────────── */
registerWorkspaceTool("invite_members", "Invite Members",
  [
    "Send workspace invitations by email. Each invite creates a pending Firestore doc, sends an email,",
    "and (if the user already has an account) writes an in-app notification. Provide an array of",
    "{ email, jobTitle?, role? } objects. Only owners can invite as 'owner'. Seat limits are enforced.",
  ].join(" "),
  {
    invites: z.array(z.object({
      email:    z.string().describe("Recipient email"),
      jobTitle: z.string().nullable().optional().describe("Optional job title to attach to the invite"),
      role:     z.enum(["owner", "member"]).optional().describe("Role to grant on accept (default: member)"),
    })).describe("One or more invitations to send"),
  }, false);

registerWorkspaceTool("list_pending_invites", "List Pending Invites",
  "List unaccepted/unrevoked invites for the workspace. Returns token, email, role, jobTitle, invitedBy, expiresAt.",
  {}, true);

registerWorkspaceTool("revoke_invite", "Revoke Invite",
  "Mark a pending invite as revoked so the link can no longer be accepted. Owner only.",
  {
    token: z.string().describe("Invite token (also the doc ID)"),
  }, false, true);

/* ── Member ops ────────────────────────────────────────────────── */
registerWorkspaceTool("update_member_role", "Update Member Role",
  "Promote a member to owner, or demote an owner to member. Last-owner protection prevents demotion if no other owner exists. Owner only.",
  {
    targetUid: z.string().describe("Target member UID"),
    newRole:   z.enum(["owner", "member"]).describe("New role"),
  }, false);

registerWorkspaceTool("remove_member", "Remove Member",
  "Remove a member from the workspace. Last-owner protection enforced. Cannot remove yourself (use leave_workspace). Owner only.",
  {
    targetUid: z.string().describe("Target member UID"),
  }, false, true);

registerWorkspaceTool("update_member_profile", "Update Member Profile",
  "Edit a member's jobTitle (self or owner) or hourlyRate (owner only — sensitive data).",
  {
    targetUid:  z.string().describe("Target UID — must equal caller UID for self-edit, or caller must be owner"),
    jobTitle:   z.string().nullable().optional().describe("New job title, or null to clear"),
    hourlyRate: z.number().nullable().optional().describe("New hourly rate (workspace currency, owner only), or null to clear"),
  }, false);

/* ── Task subscribers ─────────────────────────────────────────── */
registerWorkspaceTool("add_task_subscriber", "Add Task Subscriber",
  "Add a workspace member as a subscriber on a task — they'll receive notifications when the task is updated, commented on, etc.",
  {
    boardId:    z.string().describe("Board ID"),
    cardId:     z.string().describe("Card ID"),
    taskNumber: zNum("Task number"),
    uid:        z.string().describe("Member UID to subscribe"),
  }, false);

registerWorkspaceTool("remove_task_subscriber", "Remove Task Subscriber",
  "Remove a member from a task's subscriber list.",
  {
    boardId:    z.string().describe("Board ID"),
    cardId:     z.string().describe("Card ID"),
    taskNumber: zNum("Task number"),
    uid:        z.string().describe("Member UID to unsubscribe"),
  }, false);

registerWorkspaceTool("list_task_subscribers", "List Task Subscribers",
  "List members currently subscribed to a task. Returns uid + displayName + email for each.",
  {
    boardId:    z.string().describe("Board ID"),
    cardId:     z.string().describe("Card ID"),
    taskNumber: zNum("Task number"),
  }, true);

/* ================================================================== */
/*  Workflow — Sprints / Subtasks / Archive (v3 Sprint 4)              */
/* ================================================================== */

/* ── Sprints ──────────────────────────────────────────────────── */
registerWorkspaceTool("create_sprint", "Create Sprint",
  "Create a sprint on a board with name, startDate (YYYY-MM-DD), endDate, and optional goal. Default status is PLANNING. Max duration 90 days.",
  {
    boardId:   z.string().describe("Board ID"),
    name:      z.string().describe("Sprint name"),
    startDate: z.string().describe("Start date (YYYY-MM-DD)"),
    endDate:   z.string().describe("End date (YYYY-MM-DD)"),
    goal:      z.string().optional().describe("Sprint goal / theme"),
    status:    z.enum(["PLANNING", "ACTIVE", "COMPLETED"]).optional().describe("Initial status (default: PLANNING)"),
  }, false);

registerWorkspaceTool("update_sprint", "Update Sprint",
  "Update sprint name, dates, status (PLANNING → ACTIVE → COMPLETED), or goal. Set goal to null to clear.",
  {
    boardId:   z.string().describe("Board ID"),
    sprintId:  z.string().describe("Sprint ID"),
    name:      z.string().optional().describe("New name"),
    goal:      z.string().nullable().optional().describe("New goal, or null to clear"),
    startDate: z.string().optional().describe("New start (YYYY-MM-DD)"),
    endDate:   z.string().optional().describe("New end (YYYY-MM-DD)"),
    status:    z.enum(["PLANNING", "ACTIVE", "COMPLETED"]).optional().describe("New status"),
  }, false);

registerWorkspaceTool("complete_sprint", "Complete Sprint",
  "Mark a sprint as completed and snapshot its metrics (totalTasks, completedTasks, totalStoryPoints, completedStoryPoints, carriedOverTaskIds).",
  {
    boardId:  z.string().describe("Board ID"),
    sprintId: z.string().describe("Sprint ID"),
  }, false);

registerWorkspaceTool("list_sprints", "List Sprints",
  "List all sprints on a board, newest first. Returns id, name, dates, status, snapshot (if completed).",
  {
    boardId: z.string().describe("Board ID"),
  }, true);

registerWorkspaceTool("get_active_sprint", "Get Active Sprint",
  "Return the currently ACTIVE sprint on a board, or { active: false } if none.",
  {
    boardId: z.string().describe("Board ID"),
  }, true);

/* ── Subtasks ─────────────────────────────────────────────────── */
registerWorkspaceTool("add_subtask", "Link Task as Subtask",
  "Link two tasks in a parent ↔ child relationship. The child's parentTask is set; the parent's subtaskRefs array gains the child. Tasks may live on the same or different cards on the same board.",
  {
    boardId:          z.string().describe("Board ID containing both tasks"),
    parentCardId:     z.string().describe("Card ID of the parent task"),
    parentTaskNumber: zNum("Parent task number"),
    childCardId:      z.string().describe("Card ID of the child (subtask) task"),
    childTaskNumber:  zNum("Child task number"),
  }, false);

registerWorkspaceTool("remove_subtask", "Unlink Subtask",
  "Reverse of add_subtask — removes the child's parentTask field and prunes the parent's subtaskRefs entry.",
  {
    boardId:          z.string().describe("Board ID"),
    parentCardId:     z.string().describe("Card ID of the parent"),
    parentTaskNumber: zNum("Parent task number"),
    childCardId:      z.string().describe("Card ID of the child"),
    childTaskNumber:  zNum("Child task number"),
  }, false);

registerWorkspaceTool("list_subtasks", "List Subtasks",
  "Show a task's parent (parentTask) and children (subtaskRefs). Useful for traversing dependency chains.",
  {
    boardId:    z.string().describe("Board ID"),
    cardId:     z.string().describe("Card ID"),
    taskNumber: zNum("Task number"),
  }, true);

/* ── Archive ──────────────────────────────────────────────────── */
registerWorkspaceTool("list_all_tasks", "List All Tasks (incl. archived)",
  "List every task on a card. Set includeArchived=true to also return archived tasks (default: active only). Returns compact rows.",
  {
    boardId:         z.string().describe("Board ID"),
    cardId:          z.string().describe("Card ID"),
    includeArchived: z.boolean().optional().describe("Include archived tasks (default: false)"),
  }, true);

registerWorkspaceTool("list_archived_tasks", "List Archived Tasks",
  "List ONLY archived tasks on a card.",
  {
    boardId: z.string().describe("Board ID"),
    cardId:  z.string().describe("Card ID"),
  }, true);

registerWorkspaceTool("restore_task", "Restore Task",
  "Set archived=false on a task so it shows in the active list again.",
  {
    boardId:    z.string().describe("Board ID"),
    cardId:     z.string().describe("Card ID"),
    taskNumber: zNum("Task number"),
  }, false);

/* ================================================================== */
/*  Niche tools (v3 Sprint 5)                                          */
/* ================================================================== */

/* ── Notifications ─────────────────────────────────────────────── */
registerWorkspaceTool("list_notifications", "List Notifications",
  "Read the caller's own notifications, newest first. Default returns unread only.",
  {
    limit:       z.number().optional().describe("Max items (default 20, max 100)"),
    includeRead: z.boolean().optional().describe("Include read notifications (default: false)"),
  }, true);

registerWorkspaceTool("mark_notification_read", "Mark Notification Read",
  "Mark a single notification as read. Caller must be the recipient.",
  {
    notificationId: z.string().describe("Notification ID"),
  }, false);

registerWorkspaceTool("delete_notification", "Delete Notification",
  "Permanently delete a notification. Caller must be the recipient.",
  {
    notificationId: z.string().describe("Notification ID"),
  }, false, true);

/* ── Forms (read-only) ─────────────────────────────────────────── */
registerWorkspaceTool("list_forms", "List Forms",
  "List forms in the workspace. Filter by board (boardId) or card (cardNodeId) optionally. Returns form metadata and submission counts.",
  {
    boardId:    z.string().optional().describe("Filter by board ID"),
    cardNodeId: z.string().optional().describe("Filter by card node ID"),
  }, true);

registerWorkspaceTool("get_form", "Get Form",
  "Read full form definition: title, fields, settings, submissionCount.",
  {
    formId: z.string().describe("Form ID"),
  }, true);

registerWorkspaceTool("list_form_submissions", "List Form Submissions",
  "List submissions for a form with pagination cursor.",
  {
    formId: z.string().describe("Form ID"),
    limit:  z.number().optional().describe("Max items (default 20, max 100)"),
    cursor: z.string().optional().describe("Pagination cursor (submission ID from previous page)"),
  }, true);

/* ── Workspace settings ────────────────────────────────────────── */
registerWorkspaceTool("get_workspace_settings", "Get Workspace Settings",
  "Read workspace name, timezone, currency, hoursPerDay, plan, storage usage.",
  {}, true);

registerWorkspaceTool("update_workspace_settings", "Update Workspace Settings",
  "Update workspace metadata (name, timezone, currency, hoursPerDay). Owner only.",
  {
    name:        z.string().optional().describe("New workspace name"),
    timezone:    z.string().optional().describe("IANA timezone (e.g. \"Europe/Istanbul\")"),
    currency:    z.string().optional().describe("ISO currency code (e.g. \"USD\", \"TRY\")"),
    hoursPerDay: z.number().optional().describe("Working hours per day (1–24)"),
  }, false);

/* ── User preferences ──────────────────────────────────────────── */
registerWorkspaceTool("get_user_preferences", "Get User Preferences",
  "Read the caller's own preferences: timezone, emailNotifications, canvasSettings.",
  {}, true);

registerWorkspaceTool("update_user_preferences", "Update User Preferences",
  "Update the caller's own preferences. emailNotifications keys: invite_received, invite_accepted, member_removed, comment_added, mentioned, due_date_reminder, daily_board_digest, daily_planning.",
  {
    timezone:           z.string().optional().describe("IANA timezone string"),
    emailNotifications: z.record(z.string(), z.boolean()).optional().describe("Partial email notification toggle map"),
    canvasSettings:     z.record(z.string(), z.unknown()).optional().describe("Partial canvas settings (gridSize, snapToGrid, edgeAnimation, …)"),
  }, false);

/* ── Canvas batch ops ──────────────────────────────────────────── */
registerWorkspaceTool("batch_move_nodes", "Batch Move Nodes",
  "Move many canvas nodes (cards/notes/stacks) on a board in one call. Pass positions = { nodeId: { x, y }, … }. Max 200 nodes per call.",
  {
    boardId:   z.string().describe("Board ID"),
    positions: z.record(z.string(), z.object({
      x: z.number(),
      y: z.number(),
    })).describe("Map of nodeId → { x, y } new position"),
  }, false);

registerWorkspaceTool("batch_delete_nodes", "Batch Delete Nodes",
  "Delete many canvas nodes in one call (cards/notes/stacks) and any edges connected to them. Max 200 nodes per call. Cannot be undone.",
  {
    boardId: z.string().describe("Board ID"),
    nodeIds: z.array(z.string()).describe("Array of node IDs to delete"),
  }, false, true);

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);

// Register agent session presence after connecting (async, non-blocking)
(async () => {
  try {
    await ensureFirebaseAuth();

    // Fetch workspace IDs from auth endpoint
    const authRes = await fetch(`${BASE_URL}/api/mcp/auth`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    if (authRes.ok) {
      const authData = (await authRes.json()) as { customToken: string; workspaceIds?: string[] };
      let wsIds = authData.workspaceIds ?? [];

      // Fallback: if auth endpoint doesn't return workspaceIds yet,
      // discover them via list_cards exec endpoint (returns JSON with cards[].workspaceId)
      if (wsIds.length === 0) {
        try {
          const execRes = await fetch(`${BASE_URL}/api/mcp/exec`, {
            method: "POST",
            headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ tool: "list_cards" }),
          });
          if (execRes.ok) {
            const json = (await execRes.json()) as { cards?: Array<{ workspaceId?: string }> };
            const ids = new Set<string>();
            for (const c of json.cards ?? []) {
              if (c.workspaceId) ids.add(c.workspaceId);
            }
            wsIds = [...ids];
          }
        } catch {
          process.stderr.write("[mcp] Fallback workspace discovery failed.\n");
        }
      }

      if (wsIds.length > 0) {
        await startAgentSessions(wsIds);
      } else {
        process.stderr.write("[mcp] No workspaces found for agent session presence.\n");
      }
    }
  } catch (e) {
    process.stderr.write(`[mcp] Failed to start agent sessions: ${String(e)}\n`);
  }
})();

// Cleanup subscriptions + AI presence + agent sessions on exit
async function cleanup(): Promise<void> {
  for (const sub of subscriptions.values()) {
    sub.unsubscribe();
    if (sub.chatUnsubscribe) sub.chatUnsubscribe();
    if (sub.presenceInterval) clearInterval(sub.presenceInterval);
    await clearAiPresence(sub.workspaceId, sub.nodeId).catch(() => {});
  }
  for (const unsub of sessionWatchers) unsub();
  for (const interval of sessionHeartbeatIntervals) clearInterval(interval);
  await clearAllAgentSessions();
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(0);
});

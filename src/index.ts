// Redirect to setup wizard if "setup" is the first argument
if (process.argv.includes("setup")) {
  await import("./setup.js");
  // setup.ts handles process.exit — this line is a safety net
  await new Promise(() => {});
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

/** Generate a random 4-char alphanumeric ID (uppercase). */
function generateAgentId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

const AGENT_ID    = generateAgentId();
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

const AI_PRESENCE_ROOT = "aiPresence";

function getAuthUid(): string | null {
  const auth = getAuth(getApp());
  return auth.currentUser?.uid ?? null;
}

const PRESENCE_HEARTBEAT_MS = 30_000; // re-write presence every 30s

async function writePresence(workspaceId: string, nodeId: string): Promise<void> {
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

async function writeAgentSession(workspaceId: string): Promise<void> {
  const uid = getAuthUid();
  if (!uid) return;
  const db = getRtdb();

  // Remove any existing sessions from the same token/uid (one token = one agent)
  const wsRef = rtdbRef(db, `${AGENT_SESSION_ROOT}/${workspaceId}`);
  const snap = await rtdbGet(wsRef);
  if (snap.exists()) {
    const sessions = snap.val() as Record<string, { uid?: string }>;
    for (const [sid, data] of Object.entries(sessions)) {
      if (data.uid === uid && sid !== SESSION_ID) {
        await rtdbRemove(rtdbRef(db, `${AGENT_SESSION_ROOT}/${workspaceId}/${sid}`));
        process.stderr.write(`[mcp] Removed existing session ${sid} for same token\n`);
      }
    }
  }

  const sessionRef = rtdbRef(db, `${AGENT_SESSION_ROOT}/${workspaceId}/${SESSION_ID}`);
  const sessionData = {
    uid,
    agentId: AGENT_ID,
    mode: agentMode,
    status: "idle",
    assignedCard: null,
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
  };
  await rtdbSet(sessionRef, sessionData);
  await onDisconnect(sessionRef).remove();
}

async function updateSessionHeartbeat(workspaceId: string): Promise<void> {
  const db = getRtdb();
  const sessionRef = rtdbRef(db, `${AGENT_SESSION_ROOT}/${workspaceId}/${SESSION_ID}`);
  await rtdbUpdate(sessionRef, { lastHeartbeat: Date.now() });
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

      const newNodeId = val.assignedCard?.nodeId ?? null;

      // UI assigned a card while agent is idle → auto-subscribe
      if (newNodeId && !prevAssignedNodeId && val.status === "idle" && val.assignedCard) {
        prevAssignedNodeId = newNodeId;
        process.stderr.write(`[mcp] UI assigned card ${val.assignedCard.cardId} — auto-subscribing...\n`);
        await performSubscribe(val.assignedCard.cardId, wsId, val.assignedCard.boardId, val.assignedCard.nodeId, true);
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
const zNumOptional = (desc: string) => z.preprocess(toNum, z.number()).optional().describe(desc);
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
  { name: "is.team", version: "1.7.0" },
  {
    capabilities: {
      tools: {},
      logging: {},
      experimental: { "claude/channel": {} },
    },
  },
);

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
    limit: z.preprocess(toNum, z.number()).optional().describe("Number of messages to retrieve (default 30, max 100)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const result = await client.chatHistory(args.cardId, args.limit);
  return { content: [{ type: "text" as const, text: result }] };
});

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

    process.stderr.write(`[mcp] Chat message from ${senderName} on ${cardId}: ${content.slice(0, 80)}...\n`);

    const msg = [
      `<channel source="is-team" cardId="${cardId}" type="chat_message">`,
      `Chat message on card "${cardId}":`,
      `[${senderName}]: ${content}`,
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

  // Update agent session status
  if (!fromUI) {
    // Tool-based subscribe: update session with card info
    updateSessionStatus(workspaceId, "subscribed", { cardId, boardId, nodeId }).catch((e) =>
      process.stderr.write(`[mcp] Failed to update session status: ${String(e)}\n`),
    );
  } else {
    // UI-driven: just set status to subscribed (assignedCard is already set by UI)
    const db2 = getRtdb();
    rtdbUpdate(rtdbRef(db2, `${AGENT_SESSION_ROOT}/${workspaceId}/${SESSION_ID}`), { status: "subscribed", lastHeartbeat: Date.now() }).catch((e) =>
      process.stderr.write(`[mcp] Failed to update session status: ${String(e)}\n`),
    );
  }

  return `Subscribed to card ${cardId}. You will be notified when new tasks appear and chat messages will be forwarded to you.`;
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

  // Update agent session
  if (!fromUI) {
    updateSessionStatus(sub.workspaceId, "idle", null).catch((e) =>
      process.stderr.write(`[mcp] Failed to update session status: ${String(e)}\n`),
    );
  }

  return `Unsubscribed from card ${cardId}.`;
}

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

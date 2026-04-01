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
  set as rtdbSet,
  remove as rtdbRemove,
  onDisconnect,
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

async function setAiPresence(workspaceId: string, nodeId: string): Promise<void> {
  const uid = getAuthUid();
  if (!uid) return;
  const db = getRtdb();
  const presenceRef = rtdbRef(db, `${AI_PRESENCE_ROOT}/${workspaceId}/${nodeId}/${uid}`);
  await rtdbSet(presenceRef, { active: true, subscribedAt: Date.now() });
  await onDisconnect(presenceRef).remove();
  process.stderr.write(`[mcp] AI presence set for ${nodeId} (uid: ${uid})\n`);
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

  const res = await fetch(`${BASE_URL}/api/llm/auth`, {
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
  { name: "is.team", version: "1.6.0" },
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
  const { cardId, workspaceId, boardId, nodeId } = args;

  // Already subscribed?
  if (subscriptions.has(cardId)) {
    return { content: [{ type: "text" as const, text: `Already subscribed to card ${cardId}.` }] };
  }

  // Authenticate Firebase client SDK (uses custom token from API)
  await ensureFirebaseAuth();
  const db = getDb();

  // Read current tasks to establish baseline
  const nodeRef = doc(
    db,
    "workspaces", workspaceId,
    "boards", boardId,
    "canvasNodes", nodeId,
  );

  // Start real-time listener
  const taskIds = new Set<string>();
  let initialLoad = true;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingNewTaskIds = new Set<string>();

  type TaskEntry = { id: string; title: string; taskNumber?: number; type?: string; priority?: string };

  const SETTLE_DELAY_MS = 2000; // wait 2s to confirm task is actually dropped (not just dragged over)

  const unsubscribe = onSnapshot(nodeRef, async (snap) => {
    if (!snap.exists()) {
      process.stderr.write(`[mcp] Snapshot for ${cardId}: document does not exist\n`);
      return;
    }

    const data = snap.data();
    const nodeData = data?.data as { tasks?: TaskEntry[] } | undefined;
    const currentTasks = nodeData?.tasks ?? [];

    if (initialLoad) {
      // Populate baseline — don't notify for existing tasks
      for (const t of currentTasks) {
        taskIds.add(t.id);
      }
      initialLoad = false;
      process.stderr.write(`[mcp] Subscription baseline set for ${cardId}: ${taskIds.size} tasks\n`);
      return;
    }

    // Track which task IDs are currently present
    const currentTaskIdSet = new Set(currentTasks.map((t) => t.id));

    // Remove departed tasks from baseline so they're detected as new if they return
    for (const id of taskIds) {
      if (!currentTaskIdSet.has(id)) {
        taskIds.delete(id);
        process.stderr.write(`[mcp] Task ${id} left card ${cardId} — removed from baseline\n`);
      }
    }

    // Find new tasks (not in baseline and not already pending)
    const newTasks = currentTasks.filter((t) => !taskIds.has(t.id));

    // Remove pending tasks that disappeared (dragged away without dropping)
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

    // Add new tasks to pending set
    for (const t of newTasks) {
      pendingNewTaskIds.add(t.id);
    }

    process.stderr.write(`[mcp] ${newTasks.length} new task(s) detected on ${cardId}, waiting ${SETTLE_DELAY_MS}ms to confirm...\n`);

    // Reset settle timer — we wait for the snapshot to stabilize
    if (pendingTimer) clearTimeout(pendingTimer);

    // Capture current tasks for the settle callback
    const tasksSnapshot = [...currentTasks];

    pendingTimer = setTimeout(async () => {
      pendingTimer = null;

      // Only notify for tasks that are still pending (survived the settle period)
      const confirmedTasks: TaskEntry[] = [];
      for (const t of tasksSnapshot) {
        if (pendingNewTaskIds.has(t.id)) {
          confirmedTasks.push(t);
          pendingNewTaskIds.delete(t.id);
          taskIds.add(t.id); // Add to baseline
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
            params: {
              content: msg,
              meta: { cardId, taskNumber: String(task.taskNumber ?? "?") },
            },
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
      params: {
        content: `Subscription error for card ${cardId}: ${String(err)}`,
        meta: { cardId, error: "true" },
      },
    }).catch((e) => {
      process.stderr.write(`[mcp] Error notification also failed: ${String(e)}\n`);
    });
  });

  // ── Chat messages listener (MCP takes over AI chat) ──────────────────
  const chatColRef = collection(
    db,
    "workspaces", workspaceId,
    "boards", boardId,
    "canvasNodes", nodeId,
    "chatMessages",
  );
  const chatQuery = query(chatColRef, orderBy("timestamp", "asc"), limitToLast(1));
  const subscribeStartTime = Date.now();
  let lastProcessedChatTs = subscribeStartTime;

  const chatUnsubscribe = onSnapshot(chatQuery, (snap) => {
    if (snap.empty) return;

    const latestDoc = snap.docs[snap.docs.length - 1];
    const d = latestDoc.data();
    const role = d.role as string;
    const timestamp = (d.timestamp as number) ?? 0;
    const content = (d.content as string) ?? "";
    const senderName = (d.senderName as string) ?? "User";

    // Only process new user messages that arrived after subscription started
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
      params: {
        content: msg,
        meta: { cardId, type: "chat_message", senderName },
      },
    }).catch((err) => {
      process.stderr.write(`[mcp] Chat notification FAILED for ${cardId}: ${String(err)}\n`);
    });
  }, (err) => {
    process.stderr.write(`[mcp] Chat listener error for ${cardId}: ${String(err)}\n`);
  });

  subscriptions.set(cardId, { cardId, workspaceId, boardId, nodeId, unsubscribe, chatUnsubscribe, taskIds });

  // Set AI presence in Realtime Database (auto-cleans on disconnect)
  await setAiPresence(workspaceId, nodeId);

  return {
    content: [{
      type: "text" as const,
      text: `Subscribed to card ${cardId}. You will be notified when new tasks appear and chat messages will be forwarded to you.`,
    }],
  };
});

/* ── unsubscribe_card ───────────────────────────────────────────── */
server.registerTool("unsubscribe_card", {
  title: "Unsubscribe from Card",
  description: "Stop listening for new tasks on a card. Cancels a previous subscribe_card.",
  inputSchema: UnsubscribeCardSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async (args) => {
  const sub = subscriptions.get(args.cardId);
  if (!sub) {
    return { content: [{ type: "text" as const, text: `Not subscribed to card ${args.cardId}.` }] };
  }

  sub.unsubscribe();
  if (sub.chatUnsubscribe) sub.chatUnsubscribe();
  await clearAiPresence(sub.workspaceId, sub.nodeId);
  subscriptions.delete(args.cardId);

  return { content: [{ type: "text" as const, text: `Unsubscribed from card ${args.cardId}.` }] };
});

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);

// Cleanup subscriptions + AI presence on exit
process.on("SIGINT", async () => {
  for (const sub of subscriptions.values()) {
    sub.unsubscribe();
    if (sub.chatUnsubscribe) sub.chatUnsubscribe();
    await clearAiPresence(sub.workspaceId, sub.nodeId).catch(() => {});
  }
  process.exit(0);
});
process.on("SIGTERM", () => {
  for (const sub of subscriptions.values()) {
    sub.unsubscribe();
    if (sub.chatUnsubscribe) sub.chatUnsubscribe();
  }
  process.exit(0);
});

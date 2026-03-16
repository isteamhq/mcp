import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

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
/*  Tool input schemas                                                 */
/* ------------------------------------------------------------------ */

const CardIdArg = { cardId: z.string().describe("Board card ID (e.g. col-1773256154568)") };

const CreateTaskSchema = {
  ...CardIdArg,
  title:       z.string().describe("Task title (required)"),
  type:        z.enum(["task", "bug", "feature", "story"]).optional().describe("Task type"),
  priority:    z.enum(["low", "medium", "high"]).optional().describe("Priority level"),
  description: z.string().optional().describe("Plain text description"),
  assignee:    z.string().optional().describe("Workspace member UID to assign"),
  assignedBy:  z.string().optional().describe("Reporter UID"),
  parentTask:  z.number().optional().describe("Parent task number in this card"),
  dueDate:     z.string().optional().describe("Due date (ISO, e.g. 2026-04-01)"),
  startDate:   z.string().optional().describe("Start date (ISO)"),
  labels:      z.array(z.string()).optional().describe("Label strings"),
  storyPoints: z.number().optional().describe("Story point estimate"),
  color:       z.string().optional().describe("Task color"),
};

const UpdateTaskSchema = {
  ...CardIdArg,
  taskNumber:  z.number().describe("Task number from the # column"),
  title:       z.string().optional().describe("New title"),
  type:        z.enum(["task", "bug", "feature", "story"]).optional().describe("Task type"),
  priority:    z.enum(["low", "medium", "high"]).optional().describe("Priority level"),
  description: z.string().nullable().optional().describe("Description text, or null to clear"),
  assignee:    z.string().nullable().optional().describe("Member UID, or null to unassign"),
  assignedBy:  z.string().nullable().optional().describe("Reporter UID, or null to clear"),
  parentTask:  z.number().nullable().optional().describe("Parent task number, or null to clear"),
  dueDate:     z.string().nullable().optional().describe("Due date, or null to clear"),
  startDate:   z.string().nullable().optional().describe("Start date, or null to clear"),
  labels:      z.array(z.string()).nullable().optional().describe("Labels, or null to clear"),
  storyPoints: z.number().nullable().optional().describe("Story points, or null to clear"),
  color:       z.string().nullable().optional().describe("Color, or null to clear"),
  archived:    z.boolean().optional().describe("Archive or unarchive the task"),
};

const CompleteTaskSchema = {
  ...CardIdArg,
  taskNumber: z.number().describe("Task number to mark as done"),
};

const MoveTaskSchema = {
  ...CardIdArg,
  taskNumber:      z.number().describe("Task number to move"),
  targetCardTitle: z.string().describe("Target card name (case-insensitive, from Connected Cards)"),
};

const CommentSchema = {
  ...CardIdArg,
  taskNumber: z.number().describe("Task number to comment on"),
  text:       z.string().describe("Comment text"),
};

const ReadCardSchema = {
  ...CardIdArg,
  user: z.string().optional().describe("Display name — personalizes the prompt for this user"),
};

/* ------------------------------------------------------------------ */
/*  McpServer setup                                                    */
/* ------------------------------------------------------------------ */

const server = new McpServer(
  { name: "is.team", version: "1.0.0" },
  { capabilities: { tools: {} } },
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

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);

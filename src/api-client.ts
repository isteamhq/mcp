/**
 * REST API client for the is.team MCP exec endpoint.
 * All tool calls are routed through a single POST /api/mcp/exec endpoint.
 */

export class IsTeamClient {
  private baseUrl: string;
  private token: string;
  /** Badge name (e.g. "MP6JBN") forwarded as a header so the server can stamp
   *  it on chat_respond messages — otherwise every reply lands as "Automation"
   *  in the UI and the user can't tell which agent spoke. */
  private agentName: string | undefined;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    const raw = process.env.IST_AGENT_NAME?.trim();
    this.agentName = raw && /^[A-Z0-9]{1,6}$/.test(raw.toUpperCase()) ? raw.toUpperCase() : undefined;
  }

  async executeTool(tool: string, cardId?: string, args?: Record<string, unknown>): Promise<string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
    if (this.agentName) headers["X-Agent-Name"] = this.agentName;
    const res = await fetch(`${this.baseUrl}/api/mcp/exec`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool, cardId, args: args ?? {} }),
    });
    return res.text();
  }

  async listCards(): Promise<string> {
    return this.executeTool("list_cards");
  }

  async getCard(cardId: string, user?: string): Promise<string> {
    return this.executeTool("read_card", cardId, user ? { user } : {});
  }

  async createTask(cardId: string, body: Record<string, unknown>): Promise<string> {
    return this.executeTool("create_task", cardId, body);
  }

  async updateTask(cardId: string, body: Record<string, unknown>): Promise<string> {
    return this.executeTool("update_task", cardId, body);
  }

  async completeTask(cardId: string, taskNumber: number): Promise<string> {
    return this.executeTool("complete_task", cardId, { taskNumber });
  }

  async moveTask(cardId: string, taskNumber: number, targetCardTitle: string): Promise<string> {
    return this.executeTool("move_task", cardId, { taskNumber, targetCardTitle });
  }

  async addComment(cardId: string, taskNumber: number, text: string): Promise<string> {
    return this.executeTool("add_comment", cardId, { taskNumber, text });
  }

  async reorderTasks(cardId: string, taskNumbers: number[]): Promise<string> {
    return this.executeTool("reorder_tasks", cardId, { taskNumbers });
  }

  async logTime(cardId: string, body: Record<string, unknown>): Promise<string> {
    return this.executeTool("log_time", cardId, body);
  }

  async chatRespond(cardId: string, content: string): Promise<string> {
    return this.executeTool("chat_respond", cardId, { content });
  }

  async chatHistory(cardId: string, limit?: number): Promise<string> {
    return this.executeTool("chat_history", cardId, { limit: limit ?? 30 });
  }

  async askChat(cardId: string, question: string, type: string, options?: string[]): Promise<string> {
    return this.executeTool("ask_chat", cardId, { question, type, ...(options?.length ? { options } : {}) });
  }

  /** Generic dispatcher for the structured "agent_action" UI cards (Drive/Github
   *  offers, share preview, task plan, …). Each tool is just sugar over this. */
  async agentAction(tool: string, cardId: string, content: string, payload: Record<string, unknown>): Promise<string> {
    return this.executeTool(tool, cardId, { content, payload });
  }

  /* ── Workspace-scoped tools (integrations, board/card/member CRUD…) ─ */

  /** Generic workspace-scoped tool call — used by every tool that takes a
   *  workspaceId rather than a cardId (integrations + Sprint 1+ primitives). */
  async executeWorkspaceTool(tool: string, workspaceId: string, args?: Record<string, unknown>): Promise<string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
    if (this.agentName) headers["X-Agent-Name"] = this.agentName;
    const res = await fetch(`${this.baseUrl}/api/mcp/exec`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tool, workspaceId, args: args ?? {} }),
    });
    return res.text();
  }

  /** @deprecated use executeWorkspaceTool — kept for back-compat. */
  async executeIntegrationTool(tool: string, workspaceId: string, args?: Record<string, unknown>): Promise<string> {
    return this.executeWorkspaceTool(tool, workspaceId, args);
  }

  async listIntegrations(workspaceId: string): Promise<string> {
    return this.executeWorkspaceTool("list_integrations", workspaceId);
  }
}

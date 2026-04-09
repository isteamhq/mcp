/**
 * REST API client for the is.team MCP exec endpoint.
 * All tool calls are routed through a single POST /api/mcp/exec endpoint.
 */

export class IsTeamClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  async executeTool(tool: string, cardId?: string, args?: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/mcp/exec`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
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

  /* ── Workspace-scoped integration tools ────────────────────────── */

  async executeIntegrationTool(tool: string, workspaceId: string, args?: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/mcp/exec`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tool, workspaceId, args: args ?? {} }),
    });
    return res.text();
  }

  async listIntegrations(workspaceId: string): Promise<string> {
    return this.executeIntegrationTool("list_integrations", workspaceId);
  }
}

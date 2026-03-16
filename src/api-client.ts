/**
 * REST API client for the is.team LLM endpoints.
 * Used by the local MCP server to proxy tool calls.
 */

export class IsTeamClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  async listCards(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/llm/cards`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    return res.text();
  }

  async getCard(cardId: string, user?: string): Promise<string> {
    const qs = user ? `?user=${encodeURIComponent(user)}` : "";
    const res = await fetch(`${this.baseUrl}/llm/${cardId}.md${qs}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    return res.text();
  }

  async createTask(cardId: string, body: Record<string, unknown>): Promise<string> {
    return this.post(`${cardId}/create-task`, body);
  }

  async updateTask(cardId: string, body: Record<string, unknown>): Promise<string> {
    return this.post(`${cardId}/update-task`, body);
  }

  async completeTask(cardId: string, taskNumber: number): Promise<string> {
    return this.post(`${cardId}/complete-task`, { taskNumber });
  }

  async moveTask(cardId: string, taskNumber: number, targetCardTitle: string): Promise<string> {
    return this.post(`${cardId}/move-task`, { taskNumber, targetCardTitle });
  }

  async addComment(cardId: string, taskNumber: number, text: string): Promise<string> {
    return this.post(`${cardId}/comment`, { taskNumber, text });
  }

  private async post(path: string, body: Record<string, unknown>): Promise<string> {
    const res = await fetch(`${this.baseUrl}/llm/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return res.text();
  }
}

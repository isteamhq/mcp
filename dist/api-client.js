/**
 * REST API client for the is.team LLM endpoints.
 * Used by the local MCP server to proxy tool calls.
 */
export class IsTeamClient {
    baseUrl;
    token;
    constructor(baseUrl, token) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.token = token;
    }
    async listCards() {
        const res = await fetch(`${this.baseUrl}/llm/cards`, {
            headers: { Authorization: `Bearer ${this.token}` },
        });
        return res.text();
    }
    async getCard(cardId, user) {
        const qs = user ? `?user=${encodeURIComponent(user)}` : "";
        const res = await fetch(`${this.baseUrl}/llm/${cardId}.md${qs}`, {
            headers: { Authorization: `Bearer ${this.token}` },
        });
        return res.text();
    }
    async createTask(cardId, body) {
        return this.post(`${cardId}/create-task`, body);
    }
    async updateTask(cardId, body) {
        return this.post(`${cardId}/update-task`, body);
    }
    async completeTask(cardId, taskNumber) {
        return this.post(`${cardId}/complete-task`, { taskNumber });
    }
    async moveTask(cardId, taskNumber, targetCardTitle) {
        return this.post(`${cardId}/move-task`, { taskNumber, targetCardTitle });
    }
    async addComment(cardId, taskNumber, text) {
        return this.post(`${cardId}/comment`, { taskNumber, text });
    }
    async post(path, body) {
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
//# sourceMappingURL=api-client.js.map
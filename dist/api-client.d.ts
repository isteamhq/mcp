/**
 * REST API client for the is.team LLM endpoints.
 * Used by the local MCP server to proxy tool calls.
 */
export declare class IsTeamClient {
    private baseUrl;
    private token;
    constructor(baseUrl: string, token: string);
    listCards(): Promise<string>;
    getCard(cardId: string, user?: string): Promise<string>;
    createTask(cardId: string, body: Record<string, unknown>): Promise<string>;
    updateTask(cardId: string, body: Record<string, unknown>): Promise<string>;
    completeTask(cardId: string, taskNumber: number): Promise<string>;
    moveTask(cardId: string, taskNumber: number, targetCardTitle: string): Promise<string>;
    addComment(cardId: string, taskNumber: number, text: string): Promise<string>;
    private post;
}
//# sourceMappingURL=api-client.d.ts.map
# @isteamhq/mcp

MCP server for [is.team](https://is.team) — connect AI agents to your project boards.

## Setup

### Claude Code / Claude Desktop

Add to your MCP config (`.mcp.json` or Claude Desktop settings):

```json
{
  "mcpServers": {
    "is-team": {
      "command": "npx",
      "args": ["-y", "@isteamhq/mcp"],
      "env": {
        "IST_API_TOKEN": "ist_your_token_here"
      }
    }
  }
}
```

### Get your API token

1. Go to [is.team](https://is.team) and open **Account Settings**
2. Navigate to the **API** tab
3. Generate a new token
4. Copy the `ist_xxx` token into the config above

## Tools

| Tool | Description |
|------|-------------|
| `list_cards` | List all cards with LLM access enabled |
| `read_card` | Read card content — tasks, details, connected cards |
| `create_task` | Create a new task in a card |
| `update_task` | Update task properties |
| `complete_task` | Mark a task as done |
| `move_task` | Move a task to a connected card |
| `add_comment` | Add a comment to a task |
| `log_time` | Record a worklog entry on a task |
| `reorder_tasks` | Reorder tasks within a card |
| `subscribe_card` | Get real-time notifications when new tasks appear |
| `unsubscribe_card` | Stop listening to a card |

## Real-time notifications

Use `subscribe_card` to watch a card for new tasks. When a task is created or moved into the card, you'll receive an automatic notification — no polling needed.

```
"Subscribe to card col-xxx and work on any new tasks that appear."
```

The AI agent will receive instant notifications and can start working immediately.

## Enable LLM access on a card

Before an AI agent can interact with a card:

1. Click the **AI Integration** button on the card header
2. Enable **LLM Access**
3. Enable **Flow Actions** (for create/update/move/complete)
4. Enable **Comments** (for adding comments)

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `IST_API_TOKEN` | Yes | Your is.team API token (`ist_xxx`) |
| `IST_BASE_URL` | No | API base URL (default: `https://is.team`) |

## License

MIT

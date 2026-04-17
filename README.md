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

## Background daemon mode (v2.0+)

Run Claude as a persistent background daemon that auto-executes any task assigned to a chosen card. The daemon survives terminal closure, restarts itself on crashes, and relays Claude's output back to the card chat so you can monitor progress entirely from is.team.

### Setup

```bash
npx @isteam/mcp@latest setup --token ist_xxx
```

When asked `Run in background as a daemon?`, answer `y`. The wizard will:
1. List your cards — pick the one the daemon should watch
2. Ask for a permission mode (`acceptEdits` recommended)
3. Ask for a working directory (defaults to current)
4. Install a launchd agent (macOS) or systemd user unit (Linux)
5. Start the daemon

Now assign a task to the chosen card and Claude will start working automatically — no terminal needed.

### Managing the daemon

```bash
npx @isteam/mcp daemon status        # show current state + config summary
npx @isteam/mcp daemon logs --follow # tail the live log
npx @isteam/mcp daemon start|stop|restart
npx @isteam/mcp daemon uninstall     # remove the service
```

### How it works

- macOS: `~/Library/LaunchAgents/team.is.mcp-daemon.plist`
- Linux: `~/.config/systemd/user/isteam-mcp-daemon.service`
- Config: `~/.isteam/daemon.json` (0600 — contains your API token)
- Logs:   `~/.isteam/daemon.log` + `~/.isteam/daemon-error.log`

Each task spawns a one-shot `claude --print` subprocess with the repo's MCP config loaded. Claude reads the task, executes it, posts a summary back to the card chat, and moves the task to the next pipeline card.

### Platform support

| Platform | Status |
|---|---|
| macOS (launchd) | ✅ supported |
| Linux (systemd) | ✅ supported |
| Windows | ⚠️ not yet — use WSL2 or foreground mode |

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

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

**v3.0** ships **80 tools** total — 14 task/card primitives, 8 canvas, 22 workspace + collab, 21 workflow + niche, 1 meta, plus 34 integration tools (GitHub, Drive, Slack, Figma, Calendar). The full surface is grouped below.

### Card & task essentials
| Tool | Description |
|------|-------------|
| `list_cards` | List cards with LLM access enabled |
| `read_card` | Read card content — tasks, details, connected cards |
| `create_task` / `update_task` / `complete_task` / `move_task` / `delete_task` | Task lifecycle |
| `reorder_tasks` / `restore_task` | Re-order tasks; un-archive a task |
| `add_comment` / `update_comment` / `delete_comment` / `list_comments` | Comment CRUD |
| `log_time` / `list_worklogs` / `get_worklog` / `update_worklog` / `delete_worklog` / `get_active_timer` | Worklog & timer |
| `add_task_attachment` / `remove_task_attachment` / `list_task_attachments` | File attachments |
| `add_task_subscriber` / `remove_task_subscriber` / `list_task_subscribers` | Watchers |
| `add_subtask` / `remove_subtask` / `list_subtasks` | Subtask hierarchy |
| `list_all_tasks` / `list_archived_tasks` | Cross-section task listing |

### Boards & cards (canvas columns)
| Tool | Description |
|------|-------------|
| `list_boards` / `create_board` / `update_board` / `delete_board` | Board CRUD |
| `create_card` / `update_card` / `update_card_settings` / `delete_card` | Card CRUD + automation rules (autoAssignee, autoLabel, aiAutomationPrompt, …) |

### Notes / canvas
| Tool | Description |
|------|-------------|
| `create_note` / `update_note` / `delete_note` | Note CRUD |
| `create_edge` / `delete_edge` | Edge CRUD |
| `create_stack` / `add_to_stack` / `dissolve_stack` | Note stacks |
| `move_node` / `batch_move_nodes` / `batch_delete_nodes` | Single + bulk canvas ops |

### Workspace / team
| Tool | Description |
|------|-------------|
| `list_members` / `update_member_role` / `remove_member` / `update_member_profile` | Member ops |
| `invite_members` / `list_pending_invites` / `revoke_invite` | Invitations |
| `get_workspace_settings` / `update_workspace_settings` | Workspace metadata |
| `get_user_preferences` / `update_user_preferences` | Caller's prefs (timezone, email, canvas) |
| `list_files` / `delete_file` | Workspace file library |

### Sprints (agile flow)
| Tool | Description |
|------|-------------|
| `create_sprint` / `update_sprint` / `complete_sprint` | Sprint lifecycle (with snapshot) |
| `list_sprints` / `get_active_sprint` | Read sprints |

### Forms (read-only)
| Tool | Description |
|------|-------------|
| `list_forms` / `get_form` / `list_form_submissions` | Inspect forms + submissions |

### Notifications
| Tool | Description |
|------|-------------|
| `list_notifications` / `mark_notification_read` / `delete_notification` | Caller's notification feed |

### Real-time + chat
| Tool | Description |
|------|-------------|
| `subscribe_card` / `unsubscribe_card` | Real-time card watcher |
| `chat_respond` / `chat_history` / `ask_chat` | Card AI chat |

### Integrations (34 tools)
GitHub (12), Google Drive (8), Slack (7), Figma (3), Google Calendar (5). See `list_integrations`.

## Real-time notifications

Use `subscribe_card` to watch a card for new tasks. When a task is created or moved into the card, you'll receive an automatic notification — no polling needed.

```
"Subscribe to card col-xxx and work on any new tasks that appear."
```

The AI agent will receive instant notifications and can start working immediately.

## Background daemon mode (v2.0+)

Run Claude as a persistent background daemon that auto-executes any task assigned to a chosen card. The daemon survives terminal closure, restarts itself on crashes, and relays Claude's output back to the card chat so you can monitor progress entirely from is.team.

### Agent name (v2.1+)

Every setup run now asks for a **6-character agent name** (letters + digits). The name appears on the agent's badge in the is.team dashboard, so when you run multiple agents — one per project, one per machine, one foreground and one in background — you can tell them apart at a glance. Use different names for each terminal/project. Examples: `HOME01`, `MACM01`, `DEV001`, `LAPTP1`, `PROD01`.

The name is stored in the project's `.mcp.json` under the `IST_AGENT_NAME` env var (and in `~/.isteam/daemon.json` when running in daemon mode). If you ever need to change it, re-run setup or edit the file by hand.

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
| `IST_AGENT_NAME` | No | 6-char agent badge (A-Z, 0-9). Set by setup wizard. Falls back to a random 6-char id if missing or malformed. |
| `IST_BASE_URL` | No | API base URL (default: `https://is.team`) |

## License

MIT

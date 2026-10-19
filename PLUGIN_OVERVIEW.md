See all of your assigned Jira work in one place, across projects and epics, without clicking through Jira's boards one at a time.

## What you get

- A **Jira** page in BB's sidebar with a colorful kanban board. Your exact Jira statuses are grouped into four equal columns, **Queue**, **Blocked**, **Active**, and **Review**, and every card shows its project, status, story points, priority, epic, and age.
- An **Active sprint** view: your tickets in the running sprint, finished ones included, with dates, days left, the goal, and a progress bar.
- An **Epics** view: pick an epic to see its tickets in the same four columns.
- A compact multi-select project filter, search, sorting, and keyboard shortcuts.
- A slide-in details panel with the rendered description and full comment timeline.
- **Start working** hands a ticket to an agent. **Chat about this ticket** opens BB's composer so you can ask a question first; nothing is sent until you write your message.

## How it works

Refresh is manual. By default it uses the Atlassian MCP connection BB already has: a hidden, short-lived agent fetches every issue and comment page for your JQL and updates the board in place. It never starts OAuth or opens a browser; if Atlassian MCP is not signed in, refresh fails in place and the last good board stays visible. Alternatively, add a Jira API token in settings for a direct REST refresh without an agent. Tokens stay server-side.

Start working and Chat create threads in a BB project you choose in settings, or in a **Jira** project the plugin creates on first use. The agent receives the cached ticket and comments as hidden context. Jira stays read-only: the plugin never edits, transitions, or comments on issues, and agents are told not to unless you ask.

## Configuration

In **Settings → Plugins → Jira Board**, set your Jira site URL, the board's JQL, the sprint view's JQL, the story points field (found automatically by default), which status words count as Queue, Blocked, or Review, optional pinned project colors, the project for ticket threads, and an optional email and API token. Changes apply to an open board immediately.

## Requirements

BB 0.45 or newer, Jira Cloud, and either a signed-in Atlassian MCP server for BB agents or a Jira API token. Start working, Chat, and MCP refresh use your BB agent provider.

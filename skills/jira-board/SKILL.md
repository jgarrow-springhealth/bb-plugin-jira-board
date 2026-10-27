---
name: jira-board
summary: Refresh or inspect the Jira Board plugin cache using direct Jira access or Atlassian MCP.
description: Use when the user asks an agent to refresh the Jira Board plugin, inspect whether it is configured, or import Jira issues through their existing Atlassian MCP OAuth connection.
---

# Jira Board plugin

The dedicated BB page is registered as **Jira** in the sidebar. It shows open Jira issues assigned to the current Atlassian user.

## Inspect the current state

```bash
bb jira-board status --json
```

The result includes the configured Jira site URL (may be empty), JQL, phase rules, optional cached snapshot, and whether direct API-token refresh is configured.

## Refresh decision

1. If `configured` is true, run `bb jira-board refresh --json`; it uses the API token.
2. Otherwise, use the existing Atlassian MCP OAuth connection and the `jira_board_import` agent tool. Do not ask the user for a Jira API token when Atlassian MCP is available.

## Atlassian MCP refresh

1. Read `siteUrl`, `jql`, and `sprintJql` from `bb jira-board status --json`.
2. Call Atlassian's `searchJiraIssuesUsingJql` tool with:
   - `cloudId`: the configured `siteUrl` when it is set; otherwise the cloud ID of the user's accessible Atlassian site (if there are several and no `siteUrl`, stop and ask which site to use)
   - `jql`: the plugin's JQL
   - `maxResults`: 100
   - `responseContentFormat`: `markdown`
   - `searchResultMode`: `all`
   - fields: `summary`, `status`, `issuetype`, `priority`, `project`, `parent`, `updated`, `duedate`, `labels`, `assignee`, `description`, `comment`, plus the story points custom field
   - Story points live in a custom field whose id varies by site (often named "Story Points" or "Story point estimate"). Use the plugin's `storyPointsField` setting when it is set; otherwise look the field up by name before searching.
3. Follow `nextPageToken` until `isLast` is true or no token remains. Never import only the first page.
4. Include every comment on every issue. Compare Jira's comment `total` with the returned comment count; when they differ, use the available issue/comment MCP tools to fetch the remaining pages before importing. Convert Atlassian Document Format comment bodies to plain text.
5. Normalize every issue to this shape:

```json
{
  "key": "ABC-123",
  "summary": "Issue summary",
  "status": "In Progress",
  "statusCategory": "indeterminate",
  "type": "Task",
  "priority": "Medium",
  "project": "ABC",
  "projectName": "Example Project",
  "parentKey": null,
  "parentSummary": null,
  "dueDate": null,
  "updatedAt": "2026-10-15T10:23:18.128-0400",
  "labels": [],
  "assignee": "Alex Rivera",
  "description": null,
  "url": "https://your-site.atlassian.net/browse/ABC-123",
  "storyPoints": 3,
  "sprint": null,
  "comments": [
    {
      "id": "10001",
      "author": "Comment author",
      "body": "Plain-text comment body",
      "createdAt": "2026-10-15T11:00:00.000-0400",
      "updatedAt": "2026-10-15T11:00:00.000-0400"
    }
  ]
}
```

Use the status category's `key`, not its display name. Preserve exact Jira status names. Use `null` for absent parent, due date, assignee, description, or story points. Prefer the MCP result's `webUrl`; otherwise build the browse URL from the site URL and the key.

6. Run the plugin's `sprintJql` the same way (every page, every comment), also requesting the Sprint custom field (schema type `com.pyxis.greenhopper.jira:gh-sprint`, usually named "Sprint"). Set each issue's `sprint` to its **active** sprint as `{"id": "42", "name": "Team 24", "goal": null, "startDate": "...", "endDate": "..."}`, or `null` when it is only in future sprints. Pass these as `sprintIssues` with `sprints: "available"`. If the site has no Sprint field, skip the query and pass `sprints: "unavailable"`; if `sprintJql` is empty, pass `sprints: "disabled"`.
7. After every issue and comment page has succeeded, call `jira_board_import` once with the complete normalized `issues` and `sprintIssues` arrays. The plugin records the server completion time.
8. Report the imported issue and comment counts. The page updates through realtime automatically.

If an MCP page or normalization fails, do not call `jira_board_import`; the plugin intentionally preserves its last successful snapshot.

## CLI commands

```bash
bb jira-board status [--json]
bb jira-board refresh [--json]
bb jira-board import /absolute/path/to/snapshot.json [--json]
bb jira-board export
```

`export` prints the cache, including comments, in the format `import` accepts. The file import is a recovery path. Prefer `jira_board_import` for agent-mediated MCP refreshes.

## Operating constraints

- Refresh is manual; no background schedule runs.
- Never start Atlassian OAuth, call `auth-start`, open an authorization URL, request URL elicitation, or navigate a browser during refresh. If the existing Atlassian session is unavailable, stop and report the error.
- Refresh never changes Jira or opens Jira or OAuth pages. The page opens issues in Jira only after an explicit user click.
- With an API token and the `allowEditing` setting on (`editable: true` in `bb jira-board status --json`), the page can change Jira on an explicit user action: dragging a card to another column runs a workflow transition, and the details panel changes status, priority, story points, sprint, and the single-select fields named in `extraFields` (default `Capitalized`). Each change updates that issue in the cache in place. Agents should not change Jira through the plugin; they change Jira only when the user explicitly asks, with their own tools.
- The details drawer can start a **work** thread (agent plans and begins the ticket) or a **chat** thread (opened from the user's own first message) in the project chosen in the plugin's settings, or a **Jira** project it creates on first use. Both receive the cached ticket details and comments as agent-only context and do not update Jira unless the user explicitly asks.
- A failed refresh preserves and continues showing the last cached snapshot and comments.

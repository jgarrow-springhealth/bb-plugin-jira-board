import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { jqlFilter, parseKeywords, parseProjectColors, parseTransitions } from "./server";

const normalizedIssue = {
  key: "ACME-1",
  summary: "Ship the focused Jira board",
  status: "In Progress",
  statusCategory: "indeterminate",
  type: "Task",
  priority: "High",
  project: "ACME",
  projectName: "Acme Platform",
  parentKey: "ACME-EPIC",
  parentSummary: "Developer experience",
  dueDate: null,
  updatedAt: "2026-10-15T10:00:00.000-0400",
  labels: ["frontend"],
  assignee: "Alex Rivera",
  description: "Build the board.",
  url: "https://example.atlassian.net/browse/ACME-1",
  storyPoints: null as number | null,
  sprint: null as null | { id: string; name: string; goal: string | null; startDate: string | null; endDate: string | null },
};

const jiraCommentsResponse = {
  comments: [
    {
      id: "10001",
      author: { displayName: "Mina" },
      body: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "This is ready for review." }],
          },
        ],
      },
      created: "2026-10-15T11:00:00.000-0400",
      updated: "2026-10-15T11:00:00.000-0400",
    },
  ],
  maxResults: 100,
  total: 1,
};

const jiraFieldsResponse = [
  { id: "summary", name: "Summary" },
  { id: "customfield_10016", name: "Story point estimate" },
  { id: "customfield_10099", name: "Story points goal" },
];
const fieldsReply = () =>
  new Response(JSON.stringify(jiraFieldsResponse), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const jiraResponse = {
  issues: [
    {
      key: "ACME-1",
      fields: {
        summary: "Ship the focused Jira board",
        status: {
          name: "In Progress",
          statusCategory: { key: "indeterminate" },
        },
        issuetype: { name: "Task" },
        priority: { name: "High" },
        project: { key: "ACME", name: "Acme Platform" },
        parent: {
          key: "ACME-EPIC",
          fields: { summary: "Developer experience" },
        },
        updated: "2026-10-15T10:00:00.000-0400",
        duedate: null,
        labels: ["frontend"],
        assignee: { displayName: "Alex Rivera" },
        customfield_10016: 5,
        description: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Build the board." }],
            },
          ],
        },
      },
    },
  ],
  isLast: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Jira Board backend", () => {
  it("reports an unconfigured empty board without failing plugin load", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jira-board" });
    await plugin(bb);

    const state = await harness.behavior.callRpc("board_get", null);

    expect(state).toMatchObject({ configured: false, snapshot: null });
    await harness.lifecycle.dispose();
  });

  it("asks Stack Control for the ticket's stacks, and works without it", async () => {
    const reply = {
      stacks: [
        {
          namespace: "ns-1",
          name: "cfpl-2743",
          status: "ready",
          health: "4 of 4 required healthy",
          expiresAt: null,
          path: "/plugins/stack-control/stacks/ns-1",
          why: "for CFPL-2743",
        },
      ],
      launchPath: "/plugins/stack-control/stacks/~launch/CFPL-2743",
    };
    const callRpc = vi.fn(async (request: { pluginId: string }) => {
      if (request.pluginId === "stack-control") return reply;
      throw new Error("not installed");
    });
    const withStackControl = createFakePluginHost({ pluginId: "jira-board", sdk: { plugins: { callRpc } } as never });
    await plugin(withStackControl.bb);
    await expect(withStackControl.harness.behavior.callRpc("issue_stacks_get", { key: "CFPL-2743" })).resolves.toEqual({ available: true, ...reply });
    expect(callRpc).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "stack-control", method: "stacks_for", input: { jiraKey: "CFPL-2743" } }));
    await withStackControl.harness.lifecycle.dispose();

    const alone = createFakePluginHost({
      pluginId: "jira-board",
      sdk: { plugins: { callRpc: async () => Promise.reject(new Error("not installed")) } } as never,
    });
    await plugin(alone.bb);
    await expect(alone.harness.behavior.callRpc("issue_stacks_get", { key: "CFPL-2743" })).resolves.toEqual({ available: false, stacks: [], launchPath: null });
    await alone.harness.lifecycle.dispose();
  });

  it("refreshes Jira, normalizes issues, caches them, and publishes realtime", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fieldsReply())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(jiraResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(jiraCommentsResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { bb, harness } = createFakePluginHost({
      pluginId: "jira-board",
      settings: {
        jiraSiteUrl: "https://example.atlassian.net",
        jiraEmail: "alex@example.com",
        jiraApiToken: "secret-token",
      },
    });
    await plugin(bb);

    const state = await harness.behavior.callRpc("board_refresh", null);

    expect(state.configured).toBe(true);
    expect(state.snapshot?.source).toBe("jira");
    expect(state.snapshot?.issues).toHaveLength(1);
    expect(state.snapshot?.issues[0]).toMatchObject({
      key: "ACME-1",
      statusCategory: "indeterminate",
      parentSummary: "Developer experience",
      description: "Build the board.",
      assignee: "Alex Rivera",
      url: "https://example.atlassian.net/browse/ACME-1",
      storyPoints: 5,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0].toString()).toContain("/rest/api/3/field");
    const searchBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { fields: string[] };
    expect(searchBody.fields).toContain("customfield_10016");
    expect(searchBody.fields).not.toContain("customfield_10099");
    expect(fetchMock.mock.calls[2]?.[0].toString()).toContain(
      "/rest/api/3/issue/ACME-1/comment",
    );
    const comments = await harness.behavior.callRpc("issue_comments_get", {
      key: "ACME-1",
    });
    expect(comments.comments).toEqual([
      expect.objectContaining({
        id: "10001",
        author: "Mina",
        body: "This is ready for review.",
      }),
    ]);
    expect(harness.realtimeSignals).toContainEqual(
      expect.objectContaining({ channel: "jira-issues-changed" }),
    );

    const cached = await harness.behavior.callRpc("board_get", null);
    expect(cached.snapshot?.issues[0]?.key).toBe("ACME-1");
    await harness.lifecycle.dispose();
  });

  it("imports a complete normalized snapshot through the agent tool", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jira-board" });
    await plugin(bb);

    const tool = harness.registrations.agentTools.find(
      (candidate) => candidate.name === "jira_board_import",
    );
    expect(tool).toBeDefined();
    const parsed = tool!.parse({ issues: [{ ...normalizedIssue, comments: [] }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);

    await tool!.execute(parsed.value, {
      threadId: "thread-1",
      projectId: "project-1",
      signal: new AbortController().signal,
    });

    const state = await harness.behavior.callRpc("board_get", null);
    expect(state.configured).toBe(false);
    expect(state.snapshot?.source).toBe("mcp");
    expect(state.snapshot?.issues).toEqual([normalizedIssue]);
    expect(harness.realtimeSignals).toContainEqual(
      expect.objectContaining({ channel: "jira-issues-changed" }),
    );
    await harness.lifecycle.dispose();
  });

  it("runs an MCP refresh in a hidden worker and cleans it up", async () => {
    let importSnapshot: (() => Promise<void>) | undefined;
    const { bb, harness } = createFakePluginHost({
      pluginId: "jira-board",
      sdk: {
        projects: {
          list: () => [{ id: "personal-project", kind: "personal" }],
        },
        threads: {
          spawn: () => ({ id: "jira-refresh-worker" }),
          wait: async (args) => {
            if (args.status === "error") {
              return await new Promise((_, reject) => {
                args.signal?.addEventListener("abort", () => reject(args.signal?.reason));
              });
            }
            await importSnapshot?.();
            importSnapshot = undefined;
            return { matched: true };
          },
          output: () => ({ output: "Updated Jira Board." }),
          archive: () => ({}),
          stop: () => ({ ok: true }),
        },
      },
    });
    await plugin(bb);

    const tool = harness.registrations.agentTools.find(
      (candidate) => candidate.name === "jira_board_import",
    )!;
    importSnapshot = async () => {
      const parsed = tool.parse({ issues: [{ ...normalizedIssue, comments: [] }] });
      if (!parsed.ok) throw new Error(parsed.error);
      await tool.execute(parsed.value, {
        threadId: "jira-refresh-worker",
        projectId: "personal-project",
        signal: new AbortController().signal,
      });
    };

    const state = await harness.behavior.callRpc("board_refresh", null);

    expect(state.snapshot?.source).toBe("mcp");
    expect(state.snapshot?.issues).toEqual([normalizedIssue]);
    expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      projectId: "personal-project",
      visibility: "hidden",
      title: "Refresh Jira Board",
      pluginMetadata: { task: "jira-board-refresh" },
      prompt: expect.stringContaining("Never start OAuth"),
    });
    expect(harness.sdk.callsTo("threads.archive")).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.stop")).toHaveLength(1);
    await harness.lifecycle.dispose();
  });

  it("creates the Jira project and starts a visible issue thread", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "jira-board",
      sdk: {
        projects: {
          list: () => [],
          create: () => ({ id: "jira-project", name: "Jira" }),
        },
        system: {
          config: () => ({
            dataDir: "/tmp/bb",
            primaryHostId: "host-1",
          }),
        },
        files: {
          mkdir: () => ({ ok: true }),
          write: () => ({ outcome: "written", sha256: "sha", sizeBytes: 1 }),
        },
        threads: {
          spawn: () => ({ id: "jira-thread" }),
        },
      },
    });
    await plugin(bb);
    const tool = harness.registrations.agentTools.find(
      (candidate) => candidate.name === "jira_board_import",
    )!;
    const parsed = tool.parse({
      issues: [
        {
          ...normalizedIssue,
          comments: [
            {
              id: "comment-1",
              author: "Mina",
              body: "This is ready for review.",
              createdAt: "2026-10-15T11:00:00.000Z",
              updatedAt: "2026-10-15T11:00:00.000Z",
            },
          ],
        },
      ],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    await tool.execute(parsed.value, {
      threadId: "import-thread",
      projectId: "personal-project",
      signal: new AbortController().signal,
    });

    const result = await harness.behavior.callRpc("thread_start", { key: "ACME-1" });

    expect(result).toEqual({ threadId: "jira-thread", projectId: "jira-project" });
    expect(harness.sdk.callsTo("projects.create")[0]?.[0]).toMatchObject({
      name: "Jira",
      source: { type: "local_path", hostId: "host-1", path: "/tmp/bb/jira-project" },
    });
    expect(harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      projectId: "jira-project",
      environment: { type: "project-default" },
      title: "ACME-1: Ship the focused Jira board",
      input: [
        { type: "text", text: "Start working on ACME-1: Ship the focused Jira board" },
        {
          type: "text",
          visibility: "agent-only",
          text: expect.stringContaining("This is ready for review."),
        },
      ],
      pluginMetadata: {
        jiraIssueKey: "ACME-1",
        jiraIssueUrl: "https://example.atlassian.net/browse/ACME-1",
      },
    });
    const workInput = harness.sdk.callsTo("threads.spawn")[0]?.[0] as { input: Array<{ text: string }> };
    expect(workInput.input[1]!.text).toContain("start working on this ticket");

    const chat = await harness.behavior.callRpc("thread_chat", {
      key: "ACME-1",
      request: {
        projectId: "jira-project",
        providerId: "codex",
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "auto",
        executionInputSources: {},
        environment: { type: "project-default" },
        input: [{ type: "text", text: "Why is this blocked?", mentions: [] }],
      },
    });
    expect(chat).toEqual({ threadId: "jira-thread", projectId: "jira-project" });
    const chatSpawn = harness.sdk.callsTo("threads.spawn")[1]?.[0] as {
      providerId: string;
      title: string;
      input: Array<{ text: string; visibility?: string }>;
    };
    expect(chatSpawn).toMatchObject({ providerId: "codex", title: "ACME-1: Ship the focused Jira board" });
    expect(chatSpawn.input[0]).toMatchObject({ text: "Why is this blocked?" });
    expect(chatSpawn.input[1]).toMatchObject({ visibility: "agent-only" });
    expect(chatSpawn.input[1]!.text).toContain("Do not start implementing");
    expect(chatSpawn.input).toHaveLength(2);
    await harness.lifecycle.dispose();
  });

  it("preserves the cached snapshot when a later refresh fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fieldsReply())
      .mockResolvedValueOnce(new Response(JSON.stringify(jiraResponse), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(jiraCommentsResponse), { status: 200 }),
      )
      .mockResolvedValueOnce(fieldsReply())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errorMessages: ["Jira is unavailable"] }), {
          status: 503,
          statusText: "Unavailable",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { bb, harness } = createFakePluginHost({
      pluginId: "jira-board",
      settings: {
        jiraSiteUrl: "https://example.atlassian.net",
        jiraEmail: "alex@example.com",
        jiraApiToken: "secret-token",
      },
    });
    await plugin(bb);
    await harness.behavior.callRpc("board_refresh", null);

    await expect(harness.behavior.callRpc("board_refresh", null)).rejects.toThrow(
      "Jira is unavailable",
    );
    const state = await harness.behavior.callRpc("board_get", null);
    expect(state.snapshot?.issues[0]?.key).toBe("ACME-1");
    await harness.lifecycle.dispose();
  });

  it("exposes configurable phase rules and project colors to the page", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "jira-board",
      settings: {
        reviewStatuses: "Peer check, UAT",
        queueStatuses: "icebox",
        blockedStatuses: "Blocked, On hold",
        projectColors: "acme=#123456, OPS: #abc",
      },
    });
    await plugin(bb);
    const state = await harness.behavior.callRpc("board_get", null);
    expect(state.phaseRules).toEqual({
      queue: ["icebox"],
      blocked: ["blocked", "on hold"],
      review: ["peer check", "uat"],
    });
    expect(state.projectColors).toEqual({ ACME: "#123456", OPS: "#abc" });
    expect(state.siteUrl).toBe("");
    expect(state.configured).toBe(false);
    await harness.lifecycle.dispose();
  });

  it("validates keyword and color settings", () => {
    expect(parseKeywords(" Review ,, QA\napproval ")).toEqual(["review", "qa", "approval"]);
    expect(parseProjectColors("")).toEqual({});
    expect(() => parseProjectColors("ACME=blue")).toThrow(/KEY=#hex/);
  });

  it("round-trips the cache, including comments, through export and import", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jira-board" });
    await plugin(bb);
    const tool = harness.registrations.agentTools.find((candidate) => candidate.name === "jira_board_import")!;
    const comment = {
      id: "c1",
      author: "Mina",
      body: "Looks good.",
      createdAt: "2026-10-15T11:00:00.000Z",
      updatedAt: "2026-10-15T11:00:00.000Z",
    };
    const parsed = tool.parse({ issues: [{ ...normalizedIssue, comments: [comment] }] });
    if (!parsed.ok) throw new Error(parsed.error);
    await tool.execute(parsed.value, { threadId: "t", projectId: "p", signal: new AbortController().signal });
    const before = await harness.behavior.callRpc("board_get", null);

    const exported = await harness.behavior.runCli(["export"]);
    expect(exported.exitCode).toBe(0);
    const backup = JSON.parse(exported.stdout ?? "");
    expect(backup.issues[0].comments).toEqual([comment]);

    const dir = await mkdtemp(join(tmpdir(), "jira-board-"));
    const demo = join(dir, "demo.json");
    await writeFile(demo, JSON.stringify({ issues: [{ ...normalizedIssue, key: "OPS-9", project: "OPS" }] }));
    expect((await harness.behavior.runCli(["import", demo])).exitCode).toBe(0);
    expect((await harness.behavior.callRpc("issue_comments_get", { key: "OPS-9" })).comments).toEqual([]);

    const restore = join(dir, "backup.json");
    await writeFile(restore, exported.stdout ?? "");
    expect((await harness.behavior.runCli(["import", restore])).exitCode).toBe(0);
    const after = await harness.behavior.callRpc("board_get", null);
    expect(after.snapshot).toEqual(before.snapshot);
    expect((await harness.behavior.callRpc("issue_comments_get", { key: "ACME-1" })).comments).toEqual([comment]);
    await harness.lifecycle.dispose();
  });

  it("starts ticket threads in the configured project without creating one", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "jira-board",
      settings: { threadProject: "proj-configured" },
      sdk: { threads: { spawn: () => ({ id: "work-thread" }) } },
    });
    await plugin(bb);
    const tool = harness.registrations.agentTools.find((candidate) => candidate.name === "jira_board_import")!;
    const parsed = tool.parse({ issues: [{ ...normalizedIssue, comments: [] }] });
    if (!parsed.ok) throw new Error(parsed.error);
    await tool.execute(parsed.value, { threadId: "t", projectId: "p", signal: new AbortController().signal });

    expect(await harness.behavior.callRpc("jira_project_ensure", null)).toEqual({ projectId: "proj-configured" });
    const result = await harness.behavior.callRpc("thread_start", { key: "ACME-1" });
    expect(result).toEqual({ threadId: "work-thread", projectId: "proj-configured" });
    expect(harness.sdk.callsTo("projects.create")).toHaveLength(0);
    await harness.lifecycle.dispose();
  });

  it("uses a configured story points field id even when its name differs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fieldsReply())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            issues: [{ ...jiraResponse.issues[0], fields: { ...jiraResponse.issues[0]!.fields, customfield_10016: undefined, customfield_20000: 0.5 } }],
            isLast: true,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(jiraCommentsResponse), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { bb, harness } = createFakePluginHost({
      pluginId: "jira-board",
      settings: {
        jiraSiteUrl: "https://example.atlassian.net",
        jiraEmail: "alex@example.com",
        jiraApiToken: "secret-token",
        storyPointsField: "customfield_20000",
      },
    });
    await plugin(bb);
    const state = await harness.behavior.callRpc("board_refresh", null);
    expect(state.snapshot?.issues[0]?.storyPoints).toBe(0.5);
    const searchBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { fields: string[] };
    expect(searchBody.fields).toContain("customfield_20000");
    expect(searchBody.fields).not.toContain("customfield_10016");
    await harness.lifecycle.dispose();
  });

  it("reads caches written before story points existed", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "jira-board" });
    await plugin(bb);
    const { storyPoints: _omit, sprint: _sprint, ...legacyIssue } = normalizedIssue;
    await bb.storage.kv.set("jira-board.snapshot.v1", {
      issues: [legacyIssue],
      refreshedAt: "2026-10-15T10:00:00.000Z",
      source: "mcp",
    });
    const state = await harness.behavior.callRpc("board_get", null);
    expect(state.snapshot?.issues[0]).toMatchObject({ key: "ACME-1", storyPoints: null, sprint: null });
    expect(state.snapshot).toMatchObject({ sprintIssues: [], sprints: "unknown" });
    await harness.lifecycle.dispose();
  });

  it("names the real network failure instead of \"fetch failed\"", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo ENOTFOUND nowhere.atlassian.net"), { code: "ENOTFOUND" }),
        }),
      ),
    );
    const { bb, harness } = createFakePluginHost({
      pluginId: "jira-board",
      settings: {
        jiraSiteUrl: "https://nowhere.atlassian.net",
        jiraEmail: "alex@example.com",
        jiraApiToken: "secret-token",
      },
    });
    await plugin(bb);
    await expect(harness.behavior.callRpc("board_refresh", null)).rejects.toThrow(
      "Could not reach Jira at https://nowhere.atlassian.net (ENOTFOUND: getaddrinfo ENOTFOUND nowhere.atlassian.net).",
    );
    await harness.lifecycle.dispose();
  });

  it("loads the active sprint, including finished issues, with one comment fetch per issue", async () => {
    const sprintField = { id: "customfield_10020", name: "Sprint", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } };
    const activeSprint = {
      id: 42,
      name: "Platform 24",
      state: "active",
      goal: "Ship checkout",
      startDate: "2026-10-06T09:00:00.000Z",
      endDate: "2026-10-20T17:00:00.000Z",
    };
    const closedSprint = { id: 41, name: "Platform 23", state: "closed" };
    const withSprint = (issue: (typeof jiraResponse.issues)[number], key: string, status: string, category: string) => ({
      ...issue,
      key,
      fields: {
        ...issue.fields,
        status: { name: status, statusCategory: { key: category } },
        customfield_10020: [closedSprint, activeSprint],
      },
    });
    const responses: Record<string, unknown> = {
      field: [...jiraFieldsResponse, sprintField],
      board: { issues: [withSprint(jiraResponse.issues[0]!, "ACME-1", "In Progress", "indeterminate")], isLast: true },
      sprint: {
        issues: [
          withSprint(jiraResponse.issues[0]!, "ACME-1", "In Progress", "indeterminate"),
          withSprint(jiraResponse.issues[0]!, "ACME-5", "Done", "done"),
        ],
        isLast: true,
      },
    };
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/rest/api/3/field")) return new Response(JSON.stringify(responses.field), { status: 200 });
      if (href.endsWith("/search/jql")) {
        const { jql } = JSON.parse(String(init?.body)) as { jql: string };
        return new Response(JSON.stringify(jql.includes("openSprints") ? responses.sprint : responses.board), { status: 200 });
      }
      return new Response(JSON.stringify(jiraCommentsResponse), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { bb, harness } = createFakePluginHost({
      pluginId: "jira-board",
      settings: {
        jiraSiteUrl: "https://example.atlassian.net",
        jiraEmail: "alex@example.com",
        jiraApiToken: "secret-token",
      },
    });
    await plugin(bb);
    const state = await harness.behavior.callRpc("board_refresh", null);

    expect(state.snapshot?.sprints).toBe("available");
    expect(state.snapshot?.issues.map((issue) => issue.key)).toEqual(["ACME-1"]);
    expect(state.snapshot?.sprintIssues.map((issue) => [issue.key, issue.statusCategory])).toEqual([
      ["ACME-1", "indeterminate"],
      ["ACME-5", "done"],
    ]);
    expect(state.snapshot?.sprintIssues[1]?.sprint).toEqual({
      id: "42",
      name: "Platform 24",
      goal: "Ship checkout",
      startDate: "2026-10-06T09:00:00.000Z",
      endDate: "2026-10-20T17:00:00.000Z",
    });
    const commentCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/comment"));
    expect(commentCalls.map(([url]) => String(url).match(/issue\/([^/]+)\/comment/)?.[1])).toEqual(["ACME-1", "ACME-5"]);
    expect((await harness.behavior.callRpc("issue_comments_get", { key: "ACME-5" })).cached).toBe(true);
    expect(await harness.behavior.callRpc("thread_start", { key: "ACME-5" }).catch((error: Error) => error.message)).not.toMatch(
      /not in the current board snapshot/,
    );
    await harness.lifecycle.dispose();
  });

  it("skips the sprint query when the Sprint JQL is empty", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fieldsReply())
      .mockResolvedValueOnce(new Response(JSON.stringify(jiraResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(jiraCommentsResponse), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { bb, harness } = createFakePluginHost({
      pluginId: "jira-board",
      settings: {
        jiraSiteUrl: "https://example.atlassian.net",
        jiraEmail: "alex@example.com",
        jiraApiToken: "secret-token",
        sprintJql: "",
      },
    });
    await plugin(bb);
    const state = await harness.behavior.callRpc("board_refresh", null);
    expect(state.snapshot).toMatchObject({ sprints: "disabled", sprintIssues: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await harness.lifecycle.dispose();
  });
});

describe("Jira Board editing", () => {
  const tokenSettings = {
    jiraSiteUrl: "https://example.atlassian.net",
    jiraEmail: "alex@example.com",
    jiraApiToken: "secret-token",
  };
  const sprintField = { id: "customfield_10020", name: "Sprint", schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" } };
  const capitalizedField = { id: "customfield_12158", name: "Capitalized", schema: { type: "option" } };
  const capitalizedOptions = [
    { id: "13958", value: "Yes" },
    { id: "13959", value: "No" },
    { id: "13960", value: "Retired", disabled: true },
  ];
  const json = (body: unknown, status = 200) =>
    new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  type Call = { method: string; url: string; body: unknown };

  /** A small Jira: one issue whose status, points, and sprint change as the plugin writes. */
  function fakeJira(options: { boardMatches?: () => boolean; pointsOnScreen?: boolean } = {}) {
    const calls: Call[] = [];
    const issue = {
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      points: 5 as number | null,
      sprints: [{ id: 42, name: "Platform 24", state: "active" }] as Array<{ id: number; name: string; state: string; boardId?: number }>,
      capitalized: null as null | { id: string; value: string },
    };
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url: href, body });
      const path = new URL(href).pathname;
      if (path === "/rest/api/3/field") return json([...jiraFieldsResponse, sprintField, capitalizedField]);
      if (path === "/rest/api/3/issue/ACME-1/transitions") {
        if (method === "POST") {
          if (body.transition.id === "61" && issue.capitalized === null) {
            return json({ errorMessages: [], errors: { customfield_12158: "Capitalized is required." } }, 400);
          }
          if (body.transition.id === "31") issue.status = { name: "In Review", statusCategory: { key: "indeterminate" } };
          if (body.transition.id === "41") issue.status = { name: "Done", statusCategory: { key: "done" } };
          return json(null, 204);
        }
        return json({
          transitions: [
            { id: "31", name: "Ready for review", to: { name: "In Review", statusCategory: { key: "indeterminate" } } },
            {
              id: "41",
              name: "Done",
              to: { name: "Done", statusCategory: { key: "done" } },
              fields: { resolution: { required: true, hasDefaultValue: false, name: "Resolution" } },
            },
            { id: "51", name: "Hidden", isAvailable: false, to: { name: "Nope", statusCategory: { key: "new" } } },
          ],
        });
      }
      if (path === "/rest/api/3/issue/ACME-1/editmeta") {
        return json({
          fields: {
            ...(options.pointsOnScreen === false ? {} : { customfield_10016: {} }),
            customfield_12158: { name: "Capitalized", required: false, allowedValues: capitalizedOptions },
            customfield_10020: {},
            priority: { allowedValues: [{ id: "1", name: "Highest" }, { id: "2", name: "High" }] },
          },
        });
      }
      if (path === "/rest/api/3/issue/ACME-1" && method === "PUT") {
        if ("customfield_10016" in body.fields) issue.points = body.fields.customfield_10016;
        if ("customfield_12158" in body.fields) {
          const chosen = body.fields.customfield_12158;
          issue.capitalized = chosen === null ? null : (capitalizedOptions.find((option) => option.id === chosen.id) ?? null);
        }
        return json(null, 204);
      }
      if (path === "/rest/api/3/issue/ACME-1") {
        const base = jiraResponse.issues[0]!;
        return json({
          id: "10001",
          key: "ACME-1",
          fields: {
            ...base.fields,
            status: issue.status,
            customfield_10016: issue.points,
            customfield_10020: issue.sprints,
            customfield_12158: issue.capitalized,
          },
        });
      }
      if (path === "/rest/api/3/search/jql") {
        const matches = body.jql.includes("openSprints")
          ? issue.sprints.some((sprint) => sprint.state === "active" || sprint.state === "future")
          : (options.boardMatches?.() ?? issue.status.statusCategory.key !== "done");
        return json({ issues: matches ? [{ id: "10001", key: "ACME-1" }] : [], isLast: true });
      }
      if (path === "/rest/agile/1.0/board") return json({ values: [{ id: 7, type: "scrum", name: "ACME board" }] });
      if (path === "/rest/agile/1.0/issue/ACME-1/estimation") {
        if (method === "PUT") {
          issue.points = body.value === "" ? null : Number(body.value);
          return json({ fieldId: "customfield_10016", value: issue.points });
        }
        return json({ fieldId: "customfield_10016", value: issue.points });
      }
      if (path === "/rest/agile/1.0/board/9") return json({ id: 9, name: "Shared team board" });
      if (path === "/rest/agile/1.0/board/9/sprint") {
        return json({ values: [{ id: 90, name: "Team 12", state: "active", originBoardId: 9 }] });
      }
      if (path === "/rest/agile/1.0/board/7/sprint") {
        return json({
          values: [
            { id: 43, name: "Platform 25", state: "future", startDate: "2026-10-21T00:00:00.000Z" },
            { id: 42, name: "Platform 24", state: "active", startDate: "2026-10-07T00:00:00.000Z" },
          ],
        });
      }
      if (path === "/rest/agile/1.0/sprint/43/issue") {
        issue.sprints = [{ id: 43, name: "Platform 25", state: "future" }];
        return json(null, 204);
      }
      if (path === "/rest/agile/1.0/backlog/issue") {
        issue.sprints = [];
        return json(null, 204);
      }
      if (path.endsWith("/comment")) return json(jiraCommentsResponse);
      return json({ errorMessages: [`Unexpected ${method} ${path}`] }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { calls, issue };
  }

  async function seededPlugin(settings: Record<string, unknown> = tokenSettings) {
    const { bb, harness } = createFakePluginHost({ pluginId: "jira-board", settings });
    await plugin(bb);
    await bb.storage.kv.set("jira-board.snapshot.v1", {
      issues: [normalizedIssue, { ...normalizedIssue, key: "ACME-2" }],
      sprintIssues: [{ ...normalizedIssue, sprint: { id: "42", name: "Platform 24", goal: null, startDate: null, endDate: null } }],
      sprints: "available",
      refreshedAt: "2026-10-15T10:00:00.000Z",
      source: "jira",
    });
    return { bb, harness };
  }

  it("is editable only with an API token and editing allowed", async () => {
    const withToken = await seededPlugin();
    expect((await withToken.harness.behavior.callRpc("board_get", null)).editable).toBe(true);
    await withToken.harness.lifecycle.dispose();

    const off = await seededPlugin({ ...tokenSettings, allowEditing: false });
    expect((await off.harness.behavior.callRpc("board_get", null)).editable).toBe(false);
    await expect(off.harness.behavior.callRpc("issue_transition", { key: "ACME-1", transitionId: "31" })).rejects.toThrow(
      /turned off/,
    );
    await off.harness.lifecycle.dispose();

    const mcp = await seededPlugin({});
    expect((await mcp.harness.behavior.callRpc("board_get", null)).editable).toBe(false);
    await expect(mcp.harness.behavior.callRpc("issue_update", { key: "ACME-1", storyPoints: 3 })).rejects.toThrow(/API token/);
    await mcp.harness.lifecycle.dispose();
  });

  it("rejects malformed keys and ids before calling Jira", async () => {
    const { calls } = fakeJira();
    const { harness } = await seededPlugin();
    await expect(harness.behavior.callRpc("issue_transition", { key: "../ACME-1", transitionId: "31" })).rejects.toThrow();
    await expect(harness.behavior.callRpc("issue_update", { key: "ACME-1", sprintId: "42/../1" })).rejects.toThrow();
    await expect(harness.behavior.callRpc("issue_update", { key: "ACME-1" })).rejects.toThrow();
    expect(calls).toHaveLength(0);
    await harness.lifecycle.dispose();
  });

  it("transitions an issue and patches it into the cached board", async () => {
    const { calls } = fakeJira();
    const { harness } = await seededPlugin();

    const { transitions } = await harness.behavior.callRpc("issue_transitions_get", { key: "ACME-1" });
    expect(transitions).toEqual([
      { id: "31", name: "Ready for review", toStatus: "In Review", toStatusCategory: "indeterminate", requiredFields: [] },
      { id: "41", name: "Done", toStatus: "Done", toStatusCategory: "done", requiredFields: ["Resolution"] },
    ]);

    const state = await harness.behavior.callRpc("issue_transition", { key: "ACME-1", transitionId: "31" });

    expect(calls).toContainEqual(
      expect.objectContaining({ method: "POST", url: expect.stringContaining("/issue/ACME-1/transitions"), body: { transition: { id: "31" } } }),
    );
    const search = calls.find((call) => call.url.endsWith("/search/jql"));
    expect(search?.body).toMatchObject({
      jql: 'key = "ACME-1" AND (assignee = currentUser() AND statusCategory != Done)',
      reconcileIssues: [10001],
    });
    expect(state.snapshot?.issues.map((issue) => [issue.key, issue.status])).toEqual([
      ["ACME-1", "In Review"],
      ["ACME-2", "In Progress"],
    ]);
    expect(state.snapshot?.sprintIssues[0]).toMatchObject({ status: "In Review", sprint: { id: "42" } });
    expect(state.snapshot?.refreshedAt).toBe("2026-10-15T10:00:00.000Z");
    expect(harness.realtimeSignals).toContainEqual(expect.objectContaining({ channel: "jira-issues-changed" }));
    await harness.lifecycle.dispose();
  });

  it("drops an issue from the board when it no longer matches the board JQL", async () => {
    fakeJira({ boardMatches: () => false });
    const { harness } = await seededPlugin();
    const state = await harness.behavior.callRpc("issue_transition", { key: "ACME-1", transitionId: "31" });
    expect(state.snapshot?.issues.map((issue) => issue.key)).toEqual(["ACME-2"]);
    expect(state.snapshot?.sprintIssues.map((issue) => issue.key)).toEqual(["ACME-1"]);
    await harness.lifecycle.dispose();
  });

  it("lists what the details panel can change", async () => {
    fakeJira();
    const { harness } = await seededPlugin();
    const options = await harness.behavior.callRpc("issue_edit_options_get", { key: "ACME-1" });
    expect(options).toEqual({
      transitions: expect.arrayContaining([expect.objectContaining({ id: "31" })]),
      fields: [
        {
          id: "customfield_12158",
          name: "Capitalized",
          required: false,
          value: null,
          options: [
            { id: "13958", name: "Yes" },
            { id: "13959", name: "No" },
          ],
        },
      ],
      storyPoints: { editable: true },
      priority: { editable: true, options: [{ id: "1", name: "Highest" }, { id: "2", name: "High" }] },
      sprint: {
        editable: true,
        currentId: "42",
        options: [
          { id: "42", name: "Platform 24", state: "active", board: "ACME board" },
          { id: "43", name: "Platform 25", state: "future", board: "ACME board" },
        ],
      },
    });
    await harness.lifecycle.dispose();
  });

  it("updates story points through the field on the issue's edit screen", async () => {
    const { calls } = fakeJira();
    const { harness } = await seededPlugin();
    const state = await harness.behavior.callRpc("issue_update", { key: "ACME-1", storyPoints: 8, priorityId: "1" });
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      fields: { customfield_10016: 8, priority: { id: "1" } },
    });
    expect(state.snapshot?.issues[0]).toMatchObject({ key: "ACME-1", storyPoints: 8 });

    await harness.behavior.callRpc("issue_update", { key: "ACME-1", storyPoints: null });
    expect(calls.filter((call) => call.method === "PUT").at(-1)?.body).toEqual({ fields: { customfield_10016: null } });
    await harness.lifecycle.dispose();
  });

  it("edits extra single-select fields and names them in workflow errors", async () => {
    const { calls } = fakeJira();
    const { harness } = await seededPlugin();

    await expect(harness.behavior.callRpc("issue_transition", { key: "ACME-1", transitionId: "61" })).rejects.toThrow(
      "Capitalized: Capitalized is required.",
    );

    await harness.behavior.callRpc("issue_update", { key: "ACME-1", fields: { customfield_12158: "13958" } });
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ fields: { customfield_12158: { id: "13958" } } });
    const options = await harness.behavior.callRpc("issue_edit_options_get", { key: "ACME-1" });
    expect(options.fields[0]?.value).toBe("13958");

    await harness.behavior.callRpc("issue_update", { key: "ACME-1", fields: { customfield_12158: null } });
    expect(calls.filter((call) => call.method === "PUT").at(-1)?.body).toEqual({ fields: { customfield_12158: null } });

    await expect(
      harness.behavior.callRpc("issue_update", { key: "ACME-1", fields: { customfield_10016: "1" } }),
    ).rejects.toThrow(/isn't in the Extra fields/);
    await harness.lifecycle.dispose();
  });

  it("hides extra fields when the setting is cleared", async () => {
    fakeJira();
    const { harness } = await seededPlugin({ ...tokenSettings, extraFields: "" });
    expect((await harness.behavior.callRpc("issue_edit_options_get", { key: "ACME-1" })).fields).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("estimates through the board when story points aren't on the edit screen", async () => {
    const { calls } = fakeJira({ pointsOnScreen: false });
    const { harness } = await seededPlugin();
    expect((await harness.behavior.callRpc("issue_edit_options_get", { key: "ACME-1" })).storyPoints).toEqual({ editable: true });

    const state = await harness.behavior.callRpc("issue_update", { key: "ACME-1", storyPoints: 3 });
    expect(calls.some((call) => call.method === "PUT" && call.url.includes("/rest/api/3/issue/"))).toBe(false);
    expect(calls).toContainEqual(
      expect.objectContaining({
        method: "PUT",
        url: expect.stringContaining("/rest/agile/1.0/issue/ACME-1/estimation?boardId=7"),
        body: { value: "3" },
      }),
    );
    expect(state.snapshot?.issues[0]).toMatchObject({ key: "ACME-1", storyPoints: 3 });

    await harness.behavior.callRpc("issue_update", { key: "ACME-1", storyPoints: null });
    expect(calls.filter((call) => call.method === "PUT").at(-1)?.body).toEqual({ value: "" });
    await harness.lifecycle.dispose();
  });

  it("includes the board that owns the issue's sprint when it belongs to another project", async () => {
    const { calls, issue } = fakeJira({ pointsOnScreen: false });
    issue.sprints = [{ id: 90, name: "Team 12", state: "active", boardId: 9 }];
    const { harness } = await seededPlugin();
    const options = await harness.behavior.callRpc("issue_edit_options_get", { key: "ACME-1" });
    expect(options.sprint.currentId).toBe("90");
    expect(options.sprint.options).toContainEqual({ id: "90", name: "Team 12", state: "active", board: "Shared team board" });
    const estimations = calls.filter((call) => call.url.includes("/estimation"));
    expect(estimations[0]?.url).toContain("boardId=9");
    await harness.lifecycle.dispose();
  });

  it("moves an issue between sprints and to the backlog", async () => {
    const { calls } = fakeJira();
    const { harness } = await seededPlugin();

    let state = await harness.behavior.callRpc("issue_update", { key: "ACME-1", sprintId: "43" });
    expect(calls).toContainEqual(
      expect.objectContaining({ method: "POST", url: expect.stringContaining("/rest/agile/1.0/sprint/43/issue"), body: { issues: ["ACME-1"] } }),
    );
    // Still in an open (future) sprint, so it stays in the sprint list without an active sprint.
    expect(state.snapshot?.sprintIssues.find((issue) => issue.key === "ACME-1")?.sprint).toBeNull();

    state = await harness.behavior.callRpc("issue_update", { key: "ACME-1", sprintId: null });
    expect(calls).toContainEqual(
      expect.objectContaining({ method: "POST", url: expect.stringContaining("/rest/agile/1.0/backlog/issue") }),
    );
    expect(state.snapshot?.sprintIssues.map((issue) => issue.key)).toEqual([]);
    expect(state.snapshot?.issues.map((issue) => issue.key)).toEqual(["ACME-1", "ACME-2"]);
    await harness.lifecycle.dispose();
  });

  it("surfaces Jira's own error and leaves the cache alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) =>
        String(url).endsWith("/rest/api/3/field")
          ? json(jiraFieldsResponse)
          : json({ errorMessages: [], errors: { resolution: "Resolution is required." } }, 400),
      ),
    );
    const { harness } = await seededPlugin();
    await expect(harness.behavior.callRpc("issue_transition", { key: "ACME-1", transitionId: "41" })).rejects.toThrow(
      "resolution: Resolution is required.",
    );
    expect((await harness.behavior.callRpc("board_get", null)).snapshot?.issues[0]?.status).toBe("In Progress");
    await harness.lifecycle.dispose();
  });

  it("parses transitions and strips ORDER BY from JQL", () => {
    expect(parseTransitions({ transitions: [{ id: 5, name: "Go", to: { name: "Doing" } }] })).toEqual([
      { id: "5", name: "Go", toStatus: "Doing", toStatusCategory: "undefined", requiredFields: [] },
    ]);
    expect(jqlFilter("assignee = currentUser() ORDER BY updated DESC")).toBe("assignee = currentUser()");
    expect(jqlFilter("order by created")).toBe("");
  });
});

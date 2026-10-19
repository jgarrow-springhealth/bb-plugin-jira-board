/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const issue = {
  key: "ACME-1",
  summary: "[Phase 3][FE] Ship the focused Jira board",
  status: "In Progress",
  statusCategory: "indeterminate",
  type: "Task",
  priority: "High",
  project: "ACME",
  projectName: "Acme Platform",
  parentKey: "ACME-EPIC",
  parentSummary: "Developer experience",
  dueDate: null,
  updatedAt: "2026-10-15T10:00:00.000Z",
  labels: ["frontend"],
  assignee: "Alex Rivera",
  description: "Build the board.",
  url: "https://example.atlassian.net/browse/ACME-1",
};

const boardState = (issues: Array<typeof issue>) => ({
  configured: true,
  siteUrl: "https://example.atlassian.net",
  jql: "assignee = currentUser()",
  snapshot: {
    issues,
    refreshedAt: "2026-10-15T10:00:00.000Z",
    source: "mcp" as const,
  },
});

const otherIssues = [
  {
    ...issue,
    key: "ACME-2",
    summary: "Queue the provider cleanup",
    status: "Backlog",
    statusCategory: "new",
    parentKey: "ACME-EPIC",
    parentSummary: "Developer experience",
  },
  {
    ...issue,
    key: "OPS-9",
    summary: "Tidy the GraphQL schema",
    status: "New",
    statusCategory: "new",
    project: "OPS",
    projectName: "Operations",
    parentKey: "OPS-1",
    parentSummary: "Signal to noise",
  },
];

beforeEach(() => window.localStorage.clear());

describe("Jira Board page", () => {
  it("filters by any combination of projects from a compact picker", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: { board_get: () => boardState([issue, ...otherIssues]) },
    });

    expect(await slot.findByText("Tidy the GraphQL schema")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Filter projects" }));
    const projects = await screen.findByRole("group", { name: "Projects" });
    fireEvent.click(within(projects).getByRole("checkbox", { name: /OPS/ }));
    expect(slot.queryByText("Tidy the GraphQL schema")).toBeNull();
    expect(slot.getByText("Queue the provider cleanup")).toBeTruthy();
    expect(window.localStorage.getItem("jira-board.hidden-projects.v1")).toBe('["OPS"]');
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(await slot.findByText("No issues match this view")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(await slot.findByText("Tidy the GraphQL schema")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("leaves modifier shortcuts like Shift+Cmd+J to BB", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        board_get: () => boardState([issue]),
        issue_comments_get: () => ({ cached: true, comments: [] }),
      },
    });

    await slot.findByText("Ship the focused Jira board");
    for (const chord of [
      { key: "j", metaKey: true, shiftKey: true },
      { key: "J", metaKey: true, shiftKey: true },
      { key: "j", ctrlKey: true },
      { key: "J", shiftKey: true },
    ]) {
      fireEvent.keyDown(window, chord);
    }
    expect(slot.queryByRole("complementary", { name: "ACME-1 details" })).toBeNull();

    fireEvent.keyDown(window, { key: "j" });
    expect(await slot.findByRole("complementary", { name: "ACME-1 details" })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("drills into an epic to show its tickets", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: { board_get: () => boardState([issue, ...otherIssues]) },
    });

    fireEvent.click(await slot.findByRole("button", { name: "Epics" }));
    const epics = slot.getByRole("navigation", { name: "Epics" });
    fireEvent.click(within(epics).getByText("Signal to noise"));
    const detail = slot.getByRole("region", { name: "Epic Signal to noise" });
    expect(within(detail).getByText("Tidy the GraphQL schema")).toBeTruthy();
    expect(within(detail).queryByText("Queue the provider cleanup")).toBeNull();
    fireEvent.click(within(detail).getByRole("button", { name: "Open epic in Jira" }));
    expect(slot.navigateCalls).toContainEqual(
      expect.objectContaining({ url: "https://example.atlassian.net/browse/OPS-1" }),
    );
    slot.lifecycle.unmount();
  });

  it("refreshes through Atlassian MCP without navigating away", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        board_get: () => ({
          configured: false,
          siteUrl: "https://example.atlassian.net",
          jql: "assignee = currentUser()",
          snapshot: null,
        }),
        board_refresh: () => ({
          configured: false,
          siteUrl: "https://example.atlassian.net",
          jql: "assignee = currentUser()",
          snapshot: {
            issues: [issue],
            refreshedAt: "2026-10-15T10:00:00.000Z",
            source: "mcp" as const,
          },
        }),
      },
    });

    expect(await slot.findByText("Refresh through Atlassian MCP")).toBeTruthy();
    expect(slot.getByText(/without leaving this board/)).toBeTruthy();
    slot.getByRole("button", { name: "Refresh Jira" }).click();
    expect(await slot.findByText("Queue")).toBeTruthy();
    expect(slot.rpcCalls).toContainEqual({ method: "board_refresh", input: null });
    expect(slot.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });

  it("renders Focus board phases and opens the read-only inspector", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        board_get: () => ({
          configured: true,
          siteUrl: "https://example.atlassian.net",
          jql: "assignee = currentUser()",
          snapshot: {
            issues: [issue],
            refreshedAt: "2026-10-15T10:00:00.000Z",
            source: "jira" as const,
          },
        }),
        issue_comments_get: () => ({
          cached: true,
          comments: [
            {
              id: "comment-1",
              author: "Mina",
              body: "This is ready for review.",
              createdAt: "2026-10-15T11:00:00.000Z",
              updatedAt: "2026-10-15T11:00:00.000Z",
            },
          ],
        }),
        thread_start: () => ({ threadId: "jira-thread", projectId: "jira-project" }),
      },
    });

    expect(await slot.findByText("Queue")).toBeTruthy();
    expect(slot.getByText("Active")).toBeTruthy();
    expect(slot.getByText("Blocked")).toBeTruthy();
    expect(slot.getByText("Review")).toBeTruthy();
    const card = slot.getByText("Ship the focused Jira board");
    card.click();
    expect(await slot.findByText("Build the board.")).toBeTruthy();
    expect(await slot.findByText("This is ready for review.")).toBeTruthy();
    expect(slot.getByText("Mina")).toBeTruthy();
    slot.getByRole("button", { name: "Start working on this ticket" }).click();
    await slot.findByText("Starting work");
    expect(slot.rpcCalls).toContainEqual({
      method: "thread_start",
      input: { key: "ACME-1" },
    });
    expect(slot.navigateCalls).toContainEqual({ method: "toThread", threadId: "jira-thread" });
    slot.lifecycle.unmount();
  });

  it("starts a chat from the user's own first message", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        board_get: () => boardState([issue]),
        issue_comments_get: () => ({ cached: true, comments: [] }),
        jira_project_ensure: () => ({ projectId: "jira-project" }),
        thread_chat: () => ({ threadId: "chat-thread", projectId: "jira-project" }),
      },
    });

    fireEvent.click(await slot.findByText("Ship the focused Jira board"));
    fireEvent.click(await slot.findByRole("button", { name: "Chat about this ticket" }));
    expect(await screen.findByText("Chat about ACME-1")).toBeTruthy();
    const composer = await screen.findByTestId("bb-new-thread-composer");
    expect(composer.getAttribute("data-default-project-id")).toBe("jira-project");
    expect(slot.rpcCalls.some((call) => call.method === "thread_start")).toBe(false);
    fireEvent.change(screen.getByTestId("bb-new-thread-composer-input"), {
      target: { value: "Why is this still open?" },
    });
    fireEvent.click(screen.getByTestId("bb-new-thread-composer-submit"));
    await vi.waitFor(() =>
      expect(slot.navigateCalls).toContainEqual({ method: "toThread", threadId: "chat-thread" }),
    );
    const chatCall = slot.rpcCalls.find((call) => call.method === "thread_chat");
    expect(chatCall?.input).toMatchObject({
      key: "ACME-1",
      request: {
        projectId: "jira-project",
        input: [{ type: "text", text: "Why is this still open?" }],
      },
    });
    slot.lifecycle.unmount();
  });

  it("shows story points on cards and in the details drawer", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        board_get: () => boardState([{ ...issue, storyPoints: 3 }, { ...otherIssues[0]!, storyPoints: null }]),
        issue_comments_get: () => ({ cached: true, comments: [] }),
      },
    });
    expect(await slot.findByLabelText("3 story points")).toBeTruthy();
    expect(slot.queryAllByLabelText(/story point/)).toHaveLength(1);

    fireEvent.click(slot.getByText("Ship the focused Jira board"));
    const drawer = await slot.findByRole("complementary", { name: "ACME-1 details" });
    expect(within(drawer).getByText("Story points").nextElementSibling?.textContent).toBe("3");

    fireEvent.click(slot.getByText("Queue the provider cleanup"));
    const other = await slot.findByRole("complementary", { name: "ACME-2 details" });
    expect(within(other).getByText("Not estimated")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("puts blocked tickets in their own equal-width column and counts them", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: { board_get: () => boardState([issue, { ...otherIssues[0]!, status: "Blocked", statusCategory: "indeterminate" }]) },
    });
    const blocked = await slot.findByRole("region", { name: "Blocked, 1 issues" });
    expect(within(blocked).getByText("Queue the provider cleanup")).toBeTruthy();
    expect(within(slot.getByRole("region", { name: "Active, 1 issues" })).getByText("Ship the focused Jira board")).toBeTruthy();
    expect(slot.getByText("1 blocked")).toBeTruthy();
    const grid = blocked.parentElement!;
    expect([...grid.children].map((column) => column.getAttribute("aria-label")?.split(",")[0])).toEqual([
      "Queue",
      "Blocked",
      "Active",
      "Review",
    ]);
    expect(grid.style.gridTemplateColumns).toBe("repeat(4, minmax(230px, 1fr))");
    slot.lifecycle.unmount();
  });

  it("shows the active sprint with a Done column and progress", async () => {
    const sprint = {
      id: "42",
      name: "Platform 24",
      goal: "Ship checkout",
      startDate: "2026-10-06T09:00:00.000Z",
      endDate: "2099-10-20T17:00:00.000Z",
    };
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        board_get: () => ({
          ...boardState([issue]),
          snapshot: {
            ...boardState([issue]).snapshot,
            sprints: "available" as const,
            sprintIssues: [
              { ...issue, storyPoints: 3, sprint },
              { ...issue, key: "ACME-5", summary: "Finished sprint work", status: "Done", statusCategory: "done", storyPoints: 5, sprint },
              { ...issue, key: "ACME-6", summary: "Future sprint work", sprint: null },
            ],
          },
        }),
        issue_comments_get: () => ({ cached: true, comments: [] }),
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Active sprint" }));
    const header = slot.getByRole("banner", { name: "Sprint Platform 24" });
    expect(within(header).getByText(/Ship checkout/)).toBeTruthy();
    expect(header.textContent).toContain("5 of 8 points done");
    expect(header.textContent).toContain("1 of 2 issues");
    const done = slot.getByRole("region", { name: "Done, 1 issues" });
    expect([...done.parentElement!.children].map((column) => column.getAttribute("aria-label")?.split(",")[0])).toEqual([
      "Queue",
      "Blocked",
      "Active",
      "Review",
      "Done",
    ]);
    expect(within(done).getByText("Finished sprint work")).toBeTruthy();
    expect(slot.queryByText("Future sprint work")).toBeNull();

    fireEvent.click(within(done).getByText("Finished sprint work"));
    const drawer = await slot.findByRole("complementary", { name: "ACME-5 details" });
    expect(within(drawer).getByText("Sprint").nextElementSibling?.textContent).toBe("Platform 24");
    slot.lifecycle.unmount();
  });

  it("explains when sprints are unavailable on the site", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        board_get: () => ({
          ...boardState([issue]),
          snapshot: { ...boardState([issue]).snapshot, sprints: "unavailable" as const, sprintIssues: [] },
        }),
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Active sprint" }));
    expect(slot.getByText("Sprints aren't available")).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("uses configured phase rules and pinned project colors", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        board_get: () => ({
          ...boardState([{ ...issue, status: "Peer Check" }]),
          phaseRules: { queue: ["backlog"], blocked: ["blocked"], review: ["peer check"] },
          projectColors: { ACME: "#123456" },
        }),
      },
    });
    const review = await slot.findByRole("region", { name: "Review, 1 issues" });
    expect(within(review).getByText("Ship the focused Jira board")).toBeTruthy();
    const card = within(review).getByRole("button", { pressed: false });
    expect(card.innerHTML).toContain("rgb(18, 52, 86)");
    slot.lifecycle.unmount();
  });
});

describe("board helpers", () => {
  it("gives every visible project its own color", async () => {
    const { assignProjectColors, phaseFor } = await import("./board-model");
    const colors = assignProjectColors(["AAA", "BBB", "CCC", "DDD", "EEE"], { BBB: "#000000" });
    expect(colors.BBB).toBe("#000000");
    expect(new Set(Object.values(colors)).size).toBe(5);
    expect(phaseFor({ status: "Ready for QA", statusCategory: "indeterminate" })).toBe("review");
    expect(phaseFor({ status: "Doing", statusCategory: "indeterminate" })).toBe("active");
    expect(phaseFor({ status: "Icebox", statusCategory: "new" })).toBe("queue");
    expect(phaseFor({ status: "Blocked", statusCategory: "indeterminate" })).toBe("blocked");
    expect(phaseFor({ status: "Blocked in review", statusCategory: "indeterminate" })).toBe("blocked");
    expect(
      phaseFor({ status: "On Hold", statusCategory: "new" }, { queue: [], blocked: ["on hold"], review: [] }),
    ).toBe("blocked");
  });
});

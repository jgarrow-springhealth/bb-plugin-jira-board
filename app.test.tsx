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

describe("Editing Jira from the board", () => {
  const editableState = (issues: Array<typeof issue>) => ({ ...boardState(issues), editable: true });
  const dataTransfer = () => ({ setData: vi.fn(), getData: vi.fn(), effectAllowed: "", dropEffect: "" });
  const column = (slot: { getByRole: typeof screen.getByRole }, label: string) =>
    slot.getByRole("region", { name: new RegExp(`^${label}, `) });
  const toActive = { id: "21", name: "Start", toStatus: "In Progress", toStatusCategory: "indeterminate", requiredFields: [] };
  const toReview = { id: "31", name: "Ready for review", toStatus: "In Review", toStatusCategory: "indeterminate", requiredFields: [] };
  const toQa = { id: "32", name: "Send to QA", toStatus: "QA", toStatusCategory: "indeterminate", requiredFields: [] };

  async function drag(slot: { getByRole: typeof screen.getByRole; findByText: typeof screen.findByText }, title: string, target: string) {
    const card = (await slot.findByText(title)).closest("button")!;
    const transfer = dataTransfer();
    fireEvent.dragStart(card, { dataTransfer: transfer });
    const destination = column(slot, target);
    await vi.waitFor(() => expect(destination.getAttribute("data-drop-target")).toBe("allowed"));
    fireEvent.dragOver(destination, { dataTransfer: transfer });
    fireEvent.drop(destination, { dataTransfer: transfer });
    fireEvent.dragEnd(card, { dataTransfer: transfer });
    return card;
  }

  it("drags a ticket to another column to transition it in Jira", async () => {
    const queued = otherIssues[0]!;
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        board_get: () => editableState([issue, queued]),
        issue_transitions_get: () => ({ transitions: [toActive, toReview] }),
        issue_transition: () => editableState([issue, { ...queued, status: "In Progress", statusCategory: "indeterminate" }]),
      },
    });

    const card = await drag(slot, "Queue the provider cleanup", "Active");
    expect(card.getAttribute("draggable")).toBe("true");
    await vi.waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({ method: "issue_transition", input: { key: "ACME-2", transitionId: "21" } }),
    );
    await vi.waitFor(() => expect(within(column(slot, "Active")).getByText("Queue the provider cleanup")).toBeTruthy());
    expect(within(column(slot, "Queue")).queryByText("Queue the provider cleanup")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("dims columns the workflow can't reach and asks which status when several fit", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        board_get: () => editableState([issue]),
        issue_transitions_get: () => ({ transitions: [toReview, toQa] }),
        issue_transition: () => editableState([{ ...issue, status: "QA" }]),
      },
    });

    const card = (await slot.findByText("Ship the focused Jira board")).closest("button")!;
    const transfer = dataTransfer();
    fireEvent.dragStart(card, { dataTransfer: transfer });
    await vi.waitFor(() => expect(column(slot, "Queue").getAttribute("data-drop-target")).toBeNull());
    expect(column(slot, "Review").getAttribute("data-drop-target")).toBe("allowed");
    fireEvent.drop(column(slot, "Review"), { dataTransfer: transfer });
    fireEvent.dragEnd(card);

    fireEvent.click(await screen.findByRole("button", { name: /^QA/ }));
    await vi.waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({ method: "issue_transition", input: { key: "ACME-1", transitionId: "32" } }),
    );
    slot.lifecycle.unmount();
  });

  it("puts the card back when Jira refuses the move", async () => {
    const queued = otherIssues[0]!;
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        board_get: () => editableState([queued]),
        issue_transitions_get: () => ({ transitions: [toActive] }),
        issue_transition: () => {
          throw new Error("You don't have permission to transition this issue.");
        },
      },
    });
    await drag(slot, "Queue the provider cleanup", "Active");
    await vi.waitFor(() => expect(slot.rpcCalls.some((call) => call.method === "issue_transition")).toBe(true));
    await vi.waitFor(() => expect(within(column(slot, "Queue")).getByText("Queue the provider cleanup")).toBeTruthy());
    slot.lifecycle.unmount();
  });

  it("changes status, story points, and sprint from the details panel", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        board_get: () => editableState([{ ...issue, storyPoints: 3 }]),
        issue_comments_get: () => ({ cached: true, comments: [] }),
        issue_edit_options_get: () => ({
          transitions: [toReview],
          storyPoints: { editable: true },
          priority: { editable: true, options: [{ id: "1", name: "Highest" }, { id: "2", name: "High" }] },
          sprint: {
            editable: true,
            currentId: null,
            options: [{ id: "42", name: "Platform 24", state: "active" }],
          },
        }),
        issue_update: () => editableState([{ ...issue, storyPoints: 8 }]),
        issue_transition: () => editableState([{ ...issue, status: "In Review" }]),
      },
    });

    fireEvent.click(await slot.findByText("Ship the focused Jira board"));
    const drawer = await slot.findByRole("complementary", { name: "ACME-1 details" });

    const pointsButton = await within(drawer).findByRole("button", { name: "Change story points" });
    await vi.waitFor(() => expect((pointsButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(pointsButton);
    fireEvent.click(await screen.findByRole("button", { name: "8" }));
    await vi.waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({ method: "issue_update", input: { key: "ACME-1", storyPoints: 8 } }),
    );

    const sprintButton = within(drawer).getByRole("button", { name: "Change sprint" });
    await vi.waitFor(() => expect((sprintButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(sprintButton);
    fireEvent.click(await screen.findByRole("button", { name: /Platform 24/ }));
    await vi.waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({ method: "issue_update", input: { key: "ACME-1", sprintId: "42" } }),
    );

    const statusButton = within(drawer).getByRole("button", { name: "Change status" });
    await vi.waitFor(() => expect((statusButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(statusButton);
    fireEvent.click(await screen.findByRole("button", { name: /In Review/ }));
    await vi.waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({ method: "issue_transition", input: { key: "ACME-1", transitionId: "31" } }),
    );
    slot.lifecycle.unmount();
  });

  it("stays read-only without an API token and says how to enable editing", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        board_get: () => ({ ...boardState([issue]), configured: false, editable: false }),
        issue_comments_get: () => ({ cached: true, comments: [] }),
      },
    });
    const card = (await slot.findByText("Ship the focused Jira board")).closest("button")!;
    expect(card.getAttribute("draggable")).toBe("false");
    fireEvent.click(card);
    const drawer = await slot.findByRole("complementary", { name: "ACME-1 details" });
    expect(within(drawer).getByText(/add a Jira API token/)).toBeTruthy();
    expect(within(drawer).queryByRole("button", { name: "Change status" })).toBeNull();
    expect(slot.rpcCalls.some((call) => call.method === "issue_edit_options_get")).toBe(false);
    slot.lifecycle.unmount();
  });

  it("asks for a required extra field when Jira refuses a move, then retries", async () => {
    const capitalized = {
      id: "customfield_12158",
      name: "Capitalized",
      required: false,
      value: null as string | null,
      options: [
        { id: "13958", name: "Yes" },
        { id: "13959", name: "No" },
      ],
    };
    let attempts = 0;
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        board_get: () => editableState([issue]),
        issue_comments_get: () => ({ cached: true, comments: [] }),
        issue_transitions_get: () => ({ transitions: [toReview] }),
        issue_edit_options_get: () => ({
          transitions: [toReview],
          fields: [capitalized],
          storyPoints: { editable: true },
          priority: { editable: false, options: [] },
          sprint: { editable: false, currentId: null, options: [] },
        }),
        issue_update: () => {
          capitalized.value = "13958";
          return editableState([issue]);
        },
        issue_transition: () => {
          attempts += 1;
          if (capitalized.value === null) throw new Error("Capitalized: Capitalized is required.");
          return editableState([{ ...issue, status: "In Review" }]);
        },
      },
    });

    // Dragging to Review is refused, so the plugin asks for Capitalized.
    await drag(slot, "Ship the focused Jira board", "Review");
    const prompt = await screen.findByRole("group", { name: "Capitalized options" });
    expect(screen.getByText("Set Capitalized first")).toBeTruthy();
    fireEvent.click(within(prompt).getByRole("button", { name: "Yes" }));

    await vi.waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "issue_update",
        input: { key: "ACME-1", fields: { customfield_12158: "13958" } },
      }),
    );
    await vi.waitFor(() => expect(attempts).toBe(2));

    // The details panel shows the field and its value.
    fireEvent.click(slot.getByText("Ship the focused Jira board"));
    const drawer = await slot.findByRole("complementary", { name: "ACME-1 details" });
    const field = await within(drawer).findByRole("button", { name: "Change Capitalized" });
    await vi.waitFor(() => expect(field.textContent).toContain("Yes"));
    slot.lifecycle.unmount();
  });
});

#!/usr/bin/env node
// Writes a fictional Jira Board snapshot for screenshots and demos.
//
//   node scripts/demo-snapshot.mjs > /tmp/jira-board-demo.json
//   bb jira-board export > /tmp/jira-board-backup.json   # keep your real cache
//   bb jira-board import /tmp/jira-board-demo.json
//   ...capture...
//   bb jira-board import /tmp/jira-board-backup.json     # restore it
//
// Every name, key, and URL below is invented.

const site = "https://example.atlassian.net";
const now = Date.now();
const ago = (days, hours = 0) => new Date(now - (days * 24 + hours) * 3_600_000).toISOString();

const projects = {
  WEB: "Web App",
  API: "Platform API",
  MOB: "Mobile",
  OPS: "Operations",
  DOC: "Developer Docs",
};

const epics = {
  "WEB-100": "Checkout redesign",
  "API-40": "Public API v2",
  "MOB-12": "Offline mode",
  "OPS-7": "Observability baseline",
};

// Day-relative so the sprint is always mid-flight when the demo is imported.
const sprint = {
  id: "318",
  name: "Platform Sprint 24",
  goal: "Saved payment methods in checkout",
  startDate: ago(8),
  endDate: ago(-6),
};

let id = 1000;
const comment = (author, body, days) => ({
  id: String((id += 1)),
  author,
  body,
  createdAt: ago(days),
  updatedAt: ago(days),
});

function issue(key, summary, status, statusCategory, options = {}) {
  const project = key.split("-")[0];
  return {
    key,
    summary,
    status,
    statusCategory,
    type: options.type ?? "Task",
    priority: options.priority ?? "Medium",
    project,
    projectName: projects[project],
    parentKey: options.epic ?? null,
    parentSummary: options.epic ? epics[options.epic] : null,
    dueDate: options.due ?? null,
    updatedAt: ago(options.days ?? 1, options.hours ?? 0),
    labels: options.labels ?? [],
    assignee: "Alex Rivera",
    description: options.description ?? null,
    url: `${site}/browse/${key}`,
    storyPoints: options.points ?? null,
    sprint: options.sprint ?? null,
    comments: options.comments ?? [],
  };
}

const issues = [
  issue("WEB-142", "[FE] Show saved payment methods on the review step", "In Review", "indeterminate", { points: 5,
    epic: "WEB-100",
    priority: "High",
    days: 0,
    hours: 3,
    labels: ["frontend", "checkout"],
    description: [
      "Returning customers should see their saved cards on the review step instead of re-entering details.",
      "",
      "## Acceptance criteria",
      "",
      "* Saved cards are listed with brand, last four digits, and expiry.",
      "* The default card is preselected; expired cards are disabled with a hint.",
      "* Choosing **Use a new card** reveals the existing card form.",
      "",
      "## Notes",
      "",
      "* Design: Checkout v3, frame *Review step*.",
      "* Depends on API-57 for the `GET /payment-methods` response shape.",
    ].join("\n"),
    comments: [
      comment("Priya Shah", "Design sign-off is done. Expired cards should use the muted style from the address picker.", 4),
      comment("Sam Okafor", "API-57 is merged, so the response now includes `isDefault` and `expiresAt`.", 2),
      comment("Alex Rivera", "PR is up. Screenshots for light and dark mode are in the description.", 0),
    ],
  }),
  issue("WEB-138", "Address autocomplete drops the unit number", "In Progress", "indeterminate", { points: 3,
    epic: "WEB-100",
    priority: "Highest",
    type: "Bug",
    days: 0,
    hours: 6,
    labels: ["checkout"],
    description: "When a suggestion includes an apartment or unit, the unit is lost after selection.\n\n## Steps to reproduce\n\n* Type `200 Main St Apt 4`\n* Pick the first suggestion\n* The address line shows `200 Main St`",
    comments: [comment("Jordan Lee", "Seeing this in about 3% of orders since Tuesday.", 1)],
  }),
  issue("WEB-151", "Remember the last-used shipping speed", "Backlog", "new", { points: 1, epic: "WEB-100", priority: "Low", days: 9 }),
  issue("WEB-149", "[A11y] Announce cart total changes to screen readers", "To Do", "new", { points: 2,
    epic: "WEB-100",
    priority: "High",
    days: 3,
    labels: ["accessibility"],
  }),
  issue("API-57", "Return default and expiry fields for payment methods", "Ready for QA", "indeterminate", { points: 3,
    epic: "API-40",
    priority: "High",
    type: "Story",
    days: 1,
  }),
  issue("API-61", "Rate limit headers on every v2 response", "In Progress", "indeterminate", { points: 5,
    epic: "API-40",
    priority: "Medium",
    days: 2,
  }),
  issue("API-63", "Deprecation notices for v1 endpoints", "Backlog", "new", { points: 2, epic: "API-40", priority: "Medium", days: 14 }),
  issue("API-66", "Webhook retries stop after a single 500 response", "Blocked", "indeterminate", { points: 8,
    epic: "API-40",
    priority: "Highest",
    type: "Bug",
    days: 5,
    description: "Retries should back off and try five times. Blocked on the queue migration in OPS-21.",
  }),
  issue("MOB-31", "Queue edits made while offline", "In Progress", "indeterminate", { points: 8,
    epic: "MOB-12",
    priority: "High",
    type: "Story",
    days: 1,
  }),
  issue("MOB-34", "Conflict banner when a synced item changed elsewhere", "Draft", "new", { points: 3, epic: "MOB-12", days: 6 }),
  issue("MOB-36", "Cache the last 50 viewed orders", "New", "new", { epic: "MOB-12", priority: "Low", days: 11 }),
  issue("OPS-19", "Dashboards for p95 latency by route", "Code Review", "indeterminate", { points: 3,
    epic: "OPS-7",
    priority: "Medium",
    days: 2,
  }),
  issue("OPS-21", "Move background jobs to the new queue cluster", "To Do", "new", { points: 5,
    epic: "OPS-7",
    priority: "Highest",
    days: 4,
  }),
  issue("OPS-24", "Alert when error budget burn exceeds 5% per hour", "Backlog", "new", { epic: "OPS-7", days: 20 }),
  issue("OPS-26", "Rotate staging database credentials", "Blocked", "indeterminate", {
    points: 2,
    epic: "OPS-7",
    priority: "High",
    days: 2,
    description: "Waiting on the security team to approve the new secrets manager policy.",
  }),
  issue("DOC-8", "Quickstart for the v2 SDK", "New", "new", { points: 2, priority: "Medium", type: "Story", days: 7 }),
  issue("DOC-9", "Fix broken anchors in the webhooks guide", "To Do", "new", { priority: "Low", days: 16 }),
  issue("WEB-120", "Flaky end-to-end test: guest checkout", "Backlog", "new", { points: 1,
    priority: "Medium",
    type: "Bug",
    days: 32,
  }),
];

// The active sprint: the open board issues that are in it, plus finished work.
const inSprint = new Set(["WEB-142", "WEB-138", "WEB-149", "API-57", "API-61", "API-66", "OPS-19"]);
const sprintIssues = [
  ...issues.filter((item) => inSprint.has(item.key)).map((item) => ({ ...item, sprint })),
  issue("WEB-131", "Card brand icons on the payment step", "Done", "done", {
    epic: "WEB-100",
    points: 2,
    days: 3,
    sprint,
  }),
  issue("API-52", "Payment methods endpoint returns last four digits", "Done", "done", {
    epic: "API-40",
    points: 5,
    days: 5,
    sprint,
  }),
  issue("WEB-135", "Fix focus order in the address form", "Done", "done", {
    epic: "WEB-100",
    priority: "Low",
    type: "Bug",
    points: 1,
    days: 6,
    sprint,
  }),
];
for (const item of issues) if (inSprint.has(item.key)) item.sprint = sprint;

process.stdout.write(
  `${JSON.stringify(
    { issues, sprintIssues, sprints: "available", refreshedAt: new Date(now - 4 * 60_000).toISOString(), source: "mcp" },
    null,
    2,
  )}\n`,
);

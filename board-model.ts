import type { JiraIssue } from "./server";

export type Phase = "queue" | "active" | "blocked" | "review" | "done";
export type PhaseRules = { queue: string[]; blocked: string[]; review: string[] };

export const PROJECT_PALETTE = [
  "#3b6fe0",
  "#c27c0e",
  "#d6336c",
  "#2f9e44",
  "#e8590c",
  "#8d5524",
  "#9c36b5",
  "#5c940d",
  "#1864ab",
  "#a61e4d",
];

/** Mirrors the plugin settings' defaults for pages rendered before settings arrive. */
export const DEFAULT_PHASE_RULES: PhaseRules = {
  queue: ["backlog", "draft", "new", "to do"],
  blocked: ["blocked"],
  review: ["review", "qa", "approval"],
};

export function hashKey(key: string): number {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

/**
 * Pinned colors first; every other project gets a palette slot from a hash of
 * its key, probing past slots other visible projects already took so two
 * projects on screen never share a color while the palette lasts.
 */
export function assignProjectColors(projects: string[], pinned: Record<string, string>): Record<string, string> {
  const colors: Record<string, string> = {};
  const taken = new Set<string>();
  for (const project of projects) {
    const color = pinned[project.toUpperCase()];
    if (color !== undefined) {
      colors[project] = color;
      taken.add(color);
    }
  }
  for (const project of [...projects].sort()) {
    if (colors[project] !== undefined) continue;
    const start = hashKey(project) % PROJECT_PALETTE.length;
    let color = PROJECT_PALETTE[start]!;
    for (let offset = 0; offset < PROJECT_PALETTE.length; offset += 1) {
      const candidate = PROJECT_PALETTE[(start + offset) % PROJECT_PALETTE.length]!;
      if (!taken.has(candidate)) {
        color = candidate;
        break;
      }
    }
    colors[project] = color;
    taken.add(color);
  }
  return colors;
}

export function phaseFor(issue: Pick<JiraIssue, "status" | "statusCategory">, rules: PhaseRules = DEFAULT_PHASE_RULES): Phase {
  const status = issue.status.toLowerCase();
  // Only the Active sprint view holds finished work; the board's JQL excludes it.
  if (issue.statusCategory === "done") return "done";
  if ((rules.blocked ?? DEFAULT_PHASE_RULES.blocked).some((keyword) => status.includes(keyword))) return "blocked";
  if (rules.review.some((keyword) => status.includes(keyword))) return "review";
  if (
    issue.statusCategory === "new" ||
    issue.statusCategory === "undefined" ||
    rules.queue.some((keyword) => status.includes(keyword))
  ) {
    return "queue";
  }
  return "active";
}

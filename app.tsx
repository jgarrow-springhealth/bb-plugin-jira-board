import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  Markdown,
  UrlLink,
  definePluginApp,
  experimental_NewThreadComposer as NewThreadComposer,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type {
  BoardState,
  EditOptions,
  ExtraField,
  IssueStacks,
  IssueUpdate,
  JiraComment,
  JiraIssue,
  JiraSprint,
  JiraTransition,
  SprintSupport,
  rpcContract,
} from "./server";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { Icon } from "./components/ui/icon";
import { Input } from "./components/ui/input";
import { cn } from "./lib/utils";
import { usePortalScopeProps } from "./lib/portal-scope";
import {
  DEFAULT_PHASE_RULES,
  PROJECT_PALETTE,
  assignProjectColors,
  hashKey,
  phaseFor,
  type Phase,
  type PhaseRules,
} from "./board-model";

type ViewMode = "board" | "sprint" | "epics";
type SortMode = "priority" | "updated" | "stale";

const PHASES: Array<{ id: Phase; label: string; hint: string }> = [
  { id: "queue", label: "Queue", hint: "Not started" },
  { id: "blocked", label: "Blocked", hint: "Needs unblocking" },
  { id: "active", label: "Active", hint: "In motion" },
  { id: "review", label: "Review", hint: "Waiting on others" },
];
const SPRINT_PHASES: Array<{ id: Phase; label: string; hint: string }> = [
  ...PHASES,
  { id: "done", label: "Done", hint: "Finished this sprint" },
];
const VIEWS: Array<{ id: ViewMode; label: string }> = [
  { id: "board", label: "Board" },
  { id: "sprint", label: "Active sprint" },
  { id: "epics", label: "Epics" },
];
const PHASE_COLORS: Record<Phase, string> = {
  queue: "#64748b",
  active: "#0d9488",
  blocked: "var(--destructive)",
  review: "#7c5cd6",
  done: "#2f9e44",
};
const PRIORITY_RANK: Record<string, number> = {
  Highest: 0,
  High: 1,
  Medium: 2,
  Low: 3,
  Lowest: 4,
  None: 5,
};
const PRIORITY_STYLE: Record<string, { icon: string; color: string }> = {
  Highest: { icon: "ChevronsUp", color: "#d43c4f" },
  High: { icon: "ChevronUp", color: "#e8590c" },
  Medium: { icon: "jira-board.equal", color: "#c08a00" },
  Low: { icon: "ChevronDown", color: "#3b82c4" },
  Lowest: { icon: "ChevronsDown", color: "#3b82c4" },
};
const HIDDEN_PROJECTS_KEY = "jira-board.hidden-projects.v1";
const NO_EPIC = "__no_epic__";

function tint(color: string, percent: number, base = "transparent"): string {
  return `color-mix(in oklch, ${color} ${percent}%, ${base})`;
}

type BoardContextValue = {
  rules: PhaseRules;
  phaseOf: (issue: JiraIssue) => Phase;
  colorOf: (project: string) => string;
};

const BoardContext = createContext<BoardContextValue>({
  rules: DEFAULT_PHASE_RULES,
  phaseOf: (issue) => phaseFor(issue),
  colorOf: (project) => PROJECT_PALETTE[hashKey(project) % PROJECT_PALETTE.length]!,
});

function useBoard() {
  return useContext(BoardContext);
}

// ---- Editing context -------------------------------------------------------

type IssuePatch = Partial<Pick<JiraIssue, "status" | "statusCategory" | "storyPoints" | "priority" | "sprint">>;
type DragState = { issue: JiraIssue; phase: Phase; reachable: Set<Phase> | null };

type EditingValue = {
  /** The page may change Jira. */
  editable: boolean;
  /** Editing is off only because no API token is set. */
  needsToken: boolean;
  saving: ReadonlySet<string>;
  drag: DragState | null;
  startDrag: (issue: JiraIssue) => void;
  endDrag: () => void;
  dropOn: (phase: Phase) => void;
  transition: (issue: JiraIssue, transition: JiraTransition) => Promise<boolean>;
  update: (issue: JiraIssue, update: Omit<IssueUpdate, "key">, optimistic: IssuePatch, success: string) => Promise<boolean>;
};

const EditingContext = createContext<EditingValue>({
  editable: false,
  needsToken: false,
  saving: new Set(),
  drag: null,
  startDrag: () => {},
  endDrag: () => {},
  dropOn: () => {},
  transition: async () => false,
  update: async () => false,
});

function useEditing() {
  return useContext(EditingContext);
}

function transitionPhase(transition: JiraTransition, rules: PhaseRules): Phase {
  return phaseFor({ status: transition.toStatus, statusCategory: transition.toStatusCategory }, rules);
}

/** One transition per target status, skipping the current one; transitions Jira can complete come first. */
function distinctTargets(transitions: JiraTransition[], currentStatus: string): JiraTransition[] {
  const seen = new Set<string>();
  return [...transitions]
    .sort((a, b) => a.requiredFields.length - b.requiredFields.length)
    .filter((transition) => {
      if (transition.toStatus === currentStatus || seen.has(transition.toStatus)) return false;
      seen.add(transition.toStatus);
      return true;
    })
    .sort((a, b) => transitions.indexOf(a) - transitions.indexOf(b));
}

/** Jira's browse URL for a key, from the configured site or any cached issue's origin. */
function browseUrl(siteUrl: string, sample: JiraIssue | undefined, key: string): string | null {
  const base = siteUrl.trim() || (sample === undefined ? "" : new URL(sample.url).origin);
  return base === "" ? null : `${base.replace(/\/$/, "")}/browse/${key}`;
}

function splitSummary(summary: string) {
  const prefix = summary.match(/^(?:\[[^\]]+\]\s*)+/)?.[0] ?? "";
  const labels = Array.from(prefix.matchAll(/\[([^\]]+)\]/g), (match) => match[1]!);
  return {
    title: summary.slice(prefix.length).trim().replace(/^[-–]\s*/, "") || summary,
    labels,
  };
}

function daysSince(value: string): number {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
}

function ageLabel(value: string): string {
  const days = daysSince(value);
  if (days === 0) return "today";
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y+`;
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}

function readHiddenProjects(): Set<string> {
  try {
    const raw = window.localStorage.getItem(HIDDEN_PROJECTS_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function writeHiddenProjects(hidden: Set<string>) {
  try {
    window.localStorage.setItem(HIDDEN_PROJECTS_KEY, JSON.stringify([...hidden]));
  } catch {
    // Filters still work for this session when storage is unavailable.
  }
}

// ---- Small visual atoms ------------------------------------------------

// Lucide artwork for glyphs BB's built-in icon set does not ship.
const GLYPHS = {
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </>
  ),
  equal: (
    <>
      <path d="M5 9h14" />
      <path d="M5 15h14" />
    </>
  ),
  columns: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
      <path d="M15 3v18" />
    </>
  ),
  play: <path d="M6 3.5v17l14-8.5z" />,
  pencil: (
    <>
      <path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z" />
      <path d="m15 5 4 4" />
    </>
  ),
  chat: (
    <>
      <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
      <path d="M8 12h.01" />
      <path d="M12 12h.01" />
      <path d="M16 12h.01" />
    </>
  ),
} as const;

function Glyph({ name, className }: { name: keyof typeof GLYPHS; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      {GLYPHS[name]}
    </svg>
  );
}

function ProjectChip({ project }: { project: string }) {
  const color = useBoard().colorOf(project);
  return (
    <span
      className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-[11px] font-semibold tracking-[0.01em]"
      style={{ backgroundColor: tint(color, 14), color: tint(color, 66, "var(--foreground)") }}
    >
      <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      {project}
    </span>
  );
}

function StatusChip({ issue }: { issue: JiraIssue }) {
  const color = PHASE_COLORS[useBoard().phaseOf(issue)];
  return (
    <span
      className="inline-flex h-5 max-w-full shrink-0 items-center truncate rounded-md px-1.5 text-[11px] font-medium"
      style={{ backgroundColor: tint(color, 13), color: tint(color, 66, "var(--foreground)") }}
    >
      {issue.status}
    </span>
  );
}

function formatPoints(points: number): string {
  return Number.isInteger(points) ? String(points) : String(Math.round(points * 10) / 10);
}

function pointsLabel(points: number): string {
  return `${formatPoints(points)} story ${points === 1 ? "point" : "points"}`;
}

function StoryPoints({ points }: { points: number | null | undefined }) {
  if (points === null || points === undefined) return null;
  return (
    <span
      title={pointsLabel(points)}
      aria-label={pointsLabel(points)}
      className="inline-grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-muted px-1.5 text-[11px] font-semibold tabular-nums text-muted-foreground"
    >
      {formatPoints(points)}
    </span>
  );
}

function PriorityIcon({ priority }: { priority: string }) {
  const style = PRIORITY_STYLE[priority];
  if (style === undefined) return null;
  return (
    <span title={`${priority} priority`} aria-label={`${priority} priority`} className="inline-flex shrink-0" style={{ color: style.color }}>
      {style.icon === "jira-board.equal" ? <Glyph name="equal" className="size-4" /> : <Icon name={style.icon} className="size-4" />}
    </span>
  );
}

function PhaseDot({ phase, className }: { phase: Phase; className?: string }) {
  return <span className={cn("size-2 shrink-0 rounded-full", className)} style={{ backgroundColor: PHASE_COLORS[phase] }} />;
}

// ---- Cards and columns ----------------------------------------------------

function IssueCard({
  issue,
  selected,
  showEpic = true,
  onSelect,
}: {
  issue: JiraIssue;
  selected: boolean;
  showEpic?: boolean;
  onSelect: () => void;
}) {
  const summary = splitSummary(issue.summary);
  const color = useBoard().colorOf(issue.project);
  const { editable, saving, drag, startDrag, endDrag } = useEditing();
  const busy = saving.has(issue.key);
  const dragging = drag?.issue.key === issue.key;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-busy={busy || undefined}
      data-issue-key={issue.key}
      draggable={editable && !busy}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", issue.key);
        startDrag(issue);
      }}
      onDragEnd={endDrag}
      className={cn(
        "group relative flex w-full min-w-0 shrink-0 flex-col gap-2 overflow-hidden rounded-[10px] border bg-card py-2.5 pl-3.5 pr-3 text-left shadow-[0_1px_2px_rgb(16_24_40/0.06)] transition-[border-color,box-shadow,opacity] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-transparent" : "border-border hover:shadow-[0_4px_12px_rgb(16_24_40/0.08)]",
        editable && !busy && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-40",
        busy && "opacity-70",
      )}
      style={selected ? { boxShadow: `0 0 0 2px ${color}` } : undefined}
    >
      <span aria-hidden className="absolute inset-y-2.5 left-0 w-[3px] rounded-r-[3px]" style={{ backgroundColor: color }} />
      <span className="flex min-w-0 items-center gap-2">
        <ProjectChip project={issue.project} />
        <span className="truncate font-mono text-xs text-muted-foreground">{issue.key}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {busy ? (
            <span role="status" aria-label={`Saving ${issue.key}`} className="inline-flex text-muted-foreground">
              <Glyph name="refresh" className="size-3.5 animate-spin" />
            </span>
          ) : null}
          <StoryPoints points={issue.storyPoints} />
          <PriorityIcon priority={issue.priority} />
        </span>
      </span>
      <span
        className="block overflow-hidden text-[13.5px] font-medium leading-[1.35] text-foreground"
        style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 }}
      >
        {summary.title}
      </span>
      <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <StatusChip issue={issue} />
        {showEpic && issue.parentSummary ? (
          <span className="min-w-0 truncate" title={issue.parentSummary}>{issue.parentSummary}</span>
        ) : null}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums" title={`Updated ${shortDate(issue.updatedAt)}`}>
          {ageLabel(issue.updatedAt)}
        </span>
      </span>
    </button>
  );
}

function PhaseColumn({
  phase,
  issues,
  selectedKey,
  showEpic,
  compact,
  onSelect,
}: {
  phase: Phase;
  issues: JiraIssue[];
  selectedKey: string | null;
  showEpic: boolean;
  compact?: boolean;
  onSelect: (issue: JiraIssue) => void;
}) {
  const definition = SPRINT_PHASES.find((candidate) => candidate.id === phase)!;
  const color = PHASE_COLORS[phase];
  const { drag, dropOn } = useEditing();
  const [over, setOver] = useState(false);
  const isSource = drag?.phase === phase;
  const canDrop = drag !== null && !isSource && (drag.reachable === null || drag.reachable.has(phase));
  useEffect(() => {
    if (drag === null) setOver(false);
  }, [drag]);
  return (
    <section
      aria-label={`${definition.label}, ${issues.length} issues`}
      data-drop-target={canDrop ? (over ? "over" : "allowed") : undefined}
      onDragOver={(event) => {
        if (!canDrop) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        if (canDrop) dropOn(phase);
      }}
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[14px] transition-[opacity,box-shadow] duration-150",
        drag !== null && !isSource && !canDrop && "opacity-45",
      )}
      style={{
        backgroundColor: tint(
          color,
          over ? 22 : phase === "queue" ? 10 : phase === "blocked" ? 7 : 9,
          "var(--background)",
        ),
        ...(canDrop ? { boxShadow: `inset 0 0 0 ${over ? 2 : 1.5}px ${tint(color, over ? 80 : 40)}` } : {}),
      }}
    >
      <header className="flex shrink-0 items-center gap-2 px-3.5 pb-2.5 pt-3">
        <PhaseDot phase={phase} />
        <h2 className="text-[13.5px] font-semibold text-foreground">{definition.label}</h2>
        <span
          className="inline-grid h-5 min-w-[22px] place-items-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums"
          style={{ backgroundColor: tint(color, 16), color: tint(color, 85, "var(--foreground)") }}
        >
          {issues.length}
        </span>
        {compact ? null : (
          <span className="ml-auto truncate text-xs text-muted-foreground">{definition.hint}</span>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2.5 pb-3 pt-0.5">
        {issues.length === 0 ? (
          <p className="px-1.5 py-2 text-xs text-muted-foreground">{canDrop ? "Drop to move here." : "Nothing here."}</p>
        ) : (
          issues.map((issue) => (
            <IssueCard
              key={issue.key}
              issue={issue}
              showEpic={showEpic}
              selected={issue.key === selectedKey}
              onSelect={() => onSelect(issue)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function PhaseBoard({
  issues,
  selectedKey,
  showEpic = true,
  compact = false,
  phases = PHASES,
  onSelect,
}: {
  issues: JiraIssue[];
  selectedKey: string | null;
  showEpic?: boolean;
  compact?: boolean;
  phases?: typeof PHASES;
  onSelect: (issue: JiraIssue) => void;
}) {
  const { phaseOf } = useBoard();
  return (
    <div
      className={cn("grid h-full min-h-0", compact ? "gap-2.5" : phases.length > 4 ? "min-w-[1000px] gap-3" : "min-w-[960px] gap-3.5")}
      style={{
        gridTemplateColumns: compact
          ? `repeat(${phases.length}, minmax(0, 1fr))`
          : `repeat(${phases.length}, minmax(${phases.length > 4 ? 190 : 230}px, 1fr))`,
      }}
    >
      {phases.map(({ id }) => (
        <PhaseColumn
          key={id}
          phase={id}
          compact={compact || phases.length > 4}
          showEpic={showEpic}
          issues={issues.filter((issue) => phaseOf(issue) === id)}
          selectedKey={selectedKey}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

// ---- Epics ----------------------------------------------------------------

type EpicGroup = {
  id: string;
  key: string | null;
  summary: string;
  project: string;
  issues: JiraIssue[];
};

function epicGroups(issues: JiraIssue[]): EpicGroup[] {
  const groups = new Map<string, EpicGroup>();
  for (const issue of issues) {
    const id = issue.parentKey ?? (issue.parentSummary?.trim() || NO_EPIC);
    let group = groups.get(id);
    if (group === undefined) {
      group = {
        id,
        key: issue.parentKey,
        summary: issue.parentSummary?.trim() || "Not in an epic",
        project: issue.parentKey?.split("-")[0] ?? issue.project,
        issues: [],
      };
      groups.set(id, group);
    }
    group.issues.push(issue);
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(a.id === NO_EPIC) - Number(b.id === NO_EPIC) ||
      b.issues.length - a.issues.length ||
      a.summary.localeCompare(b.summary),
  );
}

function PhaseBar({ issues }: { issues: JiraIssue[] }) {
  const { phaseOf } = useBoard();
  const counts = PHASES.map(({ id }) => [id, issues.filter((issue) => phaseOf(issue) === id).length] as const);
  return (
    <span className="flex h-1.5 gap-0.5 overflow-hidden rounded-full" aria-hidden>
      {[...counts].reverse().map(([phase, count]) =>
        count > 0 ? (
          <span
            key={phase}
            className="rounded-full"
            style={{ flex: count, backgroundColor: PHASE_COLORS[phase], opacity: phase === "queue" ? 0.5 : 1 }}
          />
        ) : null,
      )}
    </span>
  );
}

function EpicsView({
  issues,
  siteUrl,
  epicId,
  setEpicId,
  selectedKey,
  onSelect,
}: {
  issues: JiraIssue[];
  siteUrl: string;
  epicId: string | null;
  setEpicId: (id: string) => void;
  selectedKey: string | null;
  onSelect: (issue: JiraIssue) => void;
}) {
  const navigate = useBbNavigate();
  const { phaseOf, colorOf } = useBoard();
  const groups = useMemo(() => epicGroups(issues), [issues]);
  const current = groups.find((group) => group.id === epicId) ?? groups[0]!;
  const counts = Object.fromEntries(
    PHASES.map(({ id }) => [id, current.issues.filter((issue) => phaseOf(issue) === id).length]),
  ) as Record<Phase, number>;
  const epicUrl = current.key === null ? null : browseUrl(siteUrl, current.issues[0], current.key);

  return (
    <div className="grid h-full min-h-0 gap-3.5 max-[1000px]:grid-rows-[200px_minmax(0,1fr)] min-[1001px]:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
      <nav
        aria-label="Epics"
        className="min-h-0 overflow-y-auto rounded-[14px] border border-border bg-card p-1.5"
      >
        <ul className="flex flex-col gap-0.5">
          {groups.map((group) => {
            const active = group.id === current.id;
            const color = group.key === null ? PHASE_COLORS.queue : colorOf(group.project);
            return (
              <li key={group.id}>
                <button
                  type="button"
                  aria-current={active ? "true" : undefined}
                  onClick={() => setEpicId(group.id)}
                  className={cn(
                    "flex w-full flex-col gap-1.5 rounded-[10px] px-2.5 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    !active && "hover:bg-state-hover",
                  )}
                  style={active ? { backgroundColor: tint(color, 10, "var(--card)"), boxShadow: `inset 3px 0 0 ${color}` } : undefined}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {group.key === null ? (
                      <span className="font-mono text-xs text-muted-foreground">No epic</span>
                    ) : (
                      <>
                        <ProjectChip project={group.project} />
                        <span className="truncate font-mono text-xs text-muted-foreground">{group.key}</span>
                      </>
                    )}
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">{group.issues.length}</span>
                  </span>
                  <span className="text-[13px] font-medium leading-[1.35] text-foreground">{group.summary}</span>
                  <PhaseBar issues={group.issues} />
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <section aria-label={`Epic ${current.summary}`} className="flex min-h-0 min-w-0 flex-col gap-3">
        <header className="flex items-start gap-4 rounded-[14px] border border-border bg-card px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {current.key === null ? (
                <span className="font-mono text-xs text-muted-foreground">No epic</span>
              ) : (
                <>
                  <ProjectChip project={current.project} />
                  <span className="font-mono text-xs text-muted-foreground">{current.key}</span>
                </>
              )}
            </div>
            <h2 className="mb-1.5 mt-1 text-base font-semibold tracking-[-0.01em] text-foreground">{current.summary}</h2>
            <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><PhaseDot phase="queue" />{counts.queue} queued</span>
              <span className="inline-flex items-center gap-1.5"><PhaseDot phase="blocked" />{counts.blocked} blocked</span>
              <span className="inline-flex items-center gap-1.5"><PhaseDot phase="active" />{counts.active} active</span>
              <span className="inline-flex items-center gap-1.5"><PhaseDot phase="review" />{counts.review} in review</span>
            </div>
          </div>
          {epicUrl !== null ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => void navigate.openUrl(epicUrl)}
            >
              <Icon name="ExternalLink" className="size-3.5" />
              Open epic in Jira
            </Button>
          ) : null}
        </header>
        <div className="min-h-0 flex-1">
          <PhaseBoard issues={current.issues} selectedKey={selectedKey} showEpic={false} compact onSelect={onSelect} />
        </div>
      </section>
    </div>
  );
}

// ---- Active sprint ---------------------------------------------------------

type SprintGroup = { sprint: JiraSprint; issues: JiraIssue[] };

function sprintGroups(issues: JiraIssue[]): SprintGroup[] {
  const groups = new Map<string, SprintGroup>();
  for (const issue of issues) {
    if (issue.sprint === null || issue.sprint === undefined) continue;
    const group = groups.get(issue.sprint.id) ?? { sprint: issue.sprint, issues: [] };
    group.issues.push(issue);
    groups.set(issue.sprint.id, group);
  }
  return [...groups.values()].sort((a, b) => b.issues.length - a.issues.length || a.sprint.name.localeCompare(b.sprint.name));
}

function sprintDates(sprint: JiraSprint): string | null {
  if (sprint.startDate === null || sprint.endDate === null) return null;
  const end = new Date(sprint.endDate);
  if (!Number.isFinite(end.getTime())) return null;
  const range = `${shortDate(sprint.startDate)} – ${shortDate(sprint.endDate)}`;
  const days = Math.ceil((end.getTime() - Date.now()) / 86_400_000);
  const remaining = days < 0 ? "ended" : days === 0 ? "ends today" : `${days} ${days === 1 ? "day" : "days"} left`;
  return `${range} · ${remaining}`;
}

function SprintEmpty({ support, hasIssues }: { support: SprintSupport; hasIssues: boolean }) {
  const copy =
    support === "unavailable"
      ? ["Sprints aren't available", "This Jira site has no Sprint field, so there's no active sprint to show."]
      : support === "disabled"
        ? ["Active sprint is turned off", "Add a Sprint JQL under Settings → Plugins → Jira Board to bring it back."]
        : support === "unknown"
          ? ["Refresh to load your sprint", "Your cached board predates the Active sprint view."]
          : hasIssues
            ? ["No issues match this view", "Clear search or pick more projects to see more of the sprint."]
            : ["Nothing in an active sprint", "None of your tickets are in a sprint that's currently running."];
  return (
    <CenteredState>
      <Icon name="CalendarClock" className="mx-auto size-6 text-muted-foreground" />
      <h2 className="mt-3 text-sm font-semibold">{copy[0]}</h2>
      <p className="mt-1 text-xs text-muted-foreground">{copy[1]}</p>
    </CenteredState>
  );
}

function SprintView({
  issues,
  allSprintIssues,
  support,
  sprintId,
  setSprintId,
  selectedKey,
  onSelect,
}: {
  issues: JiraIssue[];
  allSprintIssues: JiraIssue[];
  support: SprintSupport;
  sprintId: string | null;
  setSprintId: (id: string) => void;
  selectedKey: string | null;
  onSelect: (issue: JiraIssue) => void;
}) {
  const { phaseOf } = useBoard();
  const groups = useMemo(() => sprintGroups(issues), [issues]);
  if (support !== "available" || groups.length === 0) {
    return <SprintEmpty support={support} hasIssues={sprintGroups(allSprintIssues).length > 0} />;
  }
  const current = groups.find((group) => group.sprint.id === sprintId) ?? groups[0]!;
  const done = current.issues.filter((issue) => phaseOf(issue) === "done");
  const points = (list: JiraIssue[]) => list.reduce((total, issue) => total + (issue.storyPoints ?? 0), 0);
  const totalPoints = points(current.issues);
  const usePoints = totalPoints > 0;
  const weight = (issue: JiraIssue) => (usePoints ? (issue.storyPoints ?? 0) : 1);
  const dates = sprintDates(current.sprint);
  // Goals are often pasted lists ("- A - B"); show them as one readable line.
  const goal = current.sprint.goal
    ?.split(/\s*(?:^|\n|\s)-\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" · ");
  const progress = SPRINT_PHASES.map(({ id, label }) => ({
    id,
    label,
    value: current.issues.filter((issue) => phaseOf(issue) === id).reduce((total, issue) => total + weight(issue), 0),
  }));
  const whole = progress.reduce((total, part) => total + part.value, 0);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {groups.length > 1 ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Active sprints">
          {groups.map((group) => (
            <button
              key={group.sprint.id}
              type="button"
              aria-pressed={group.sprint.id === current.sprint.id}
              onClick={() => setSprintId(group.sprint.id)}
              className={cn(
                "h-7 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                group.sprint.id === current.sprint.id
                  ? "border-transparent bg-foreground text-background"
                  : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {group.sprint.name}
              <span className="ml-1.5 tabular-nums opacity-70">{group.issues.length}</span>
            </button>
          ))}
        </div>
      ) : null}
      <header
        aria-label={`Sprint ${current.sprint.name}`}
        className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-[14px] border border-border bg-card px-4 py-3.5"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">{current.sprint.name}</h2>
            {dates ? <span className="text-xs tabular-nums text-muted-foreground">{dates}</span> : null}
          </div>
          {goal ? (
            <p
              className="mt-1 overflow-hidden text-xs leading-[1.45] text-muted-foreground"
              style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 }}
              title={current.sprint.goal ?? undefined}
            >
              <span className="font-medium text-foreground/80">Goal:</span> {goal}
            </p>
          ) : null}
        </div>
        <div className="flex min-w-[260px] flex-1 flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
            <span>
              <span className="text-[15px] font-semibold tabular-nums text-foreground">
                {usePoints ? formatPoints(points(done)) : done.length}
              </span>
              {" of "}
              {usePoints ? `${formatPoints(totalPoints)} points done` : `${current.issues.length} issues done`}
            </span>
            <span className="tabular-nums">
              {done.length} of {current.issues.length} issues
            </span>
          </div>
          <div
            className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={progress
              .filter((part) => part.value > 0)
              .map((part) => `${part.label} ${formatPoints(part.value)}`)
              .join(", ")}
          >
            {whole > 0
              ? [...progress].reverse().map((part) =>
                  part.value > 0 ? (
                    <span
                      key={part.id}
                      className="h-full first:rounded-l-full last:rounded-r-full"
                      style={{ flex: part.value, backgroundColor: PHASE_COLORS[part.id], opacity: part.id === "queue" ? 0.5 : 1 }}
                    />
                  ) : null,
                )
              : null}
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-x-auto">
        <PhaseBoard issues={current.issues} selectedKey={selectedKey} phases={SPRINT_PHASES} onSelect={onSelect} />
      </div>
    </div>
  );
}

// ---- Toolbar --------------------------------------------------------------

function ProjectPicker({
  issues,
  hidden,
  setHidden,
}: {
  issues: JiraIssue[];
  hidden: Set<string>;
  setHidden: (hidden: Set<string>) => void;
}) {
  const projects = useMemo(() => {
    const byKey = new Map<string, { name: string; count: number }>();
    for (const issue of issues) {
      const entry = byKey.get(issue.project) ?? { name: issue.projectName, count: 0 };
      entry.count += 1;
      byKey.set(issue.project, entry);
    }
    return [...byKey.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  }, [issues]);
  const { colorOf } = useBoard();
  const selected = projects.filter(([key]) => !hidden.has(key)).map(([key]) => key);
  const toggle = (key: string) => {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setHidden(next);
  };

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 gap-2 px-2.5" aria-label="Filter projects">
          {selected.length === projects.length ? (
            <span>All projects</span>
          ) : selected.length === 0 ? (
            <span className="text-muted-foreground">No projects</span>
          ) : (
            <span className="flex items-center gap-1">
              {selected.slice(0, 3).map((key) => <ProjectChip key={key} project={key} />)}
              {selected.length > 3 ? (
                <span className="text-[11px] font-semibold text-muted-foreground">+{selected.length - 3}</span>
              ) : null}
            </span>
          )}
          <Icon name="ChevronDown" className="size-3.5 text-muted-foreground" />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align="start"
          className="z-50 w-72 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between px-2 pb-1.5 pt-1 text-xs text-muted-foreground">
            <span>Projects</span>
            <span className="flex gap-1">
              <button type="button" className="rounded px-1 py-0.5 text-foreground hover:bg-state-hover" onClick={() => setHidden(new Set())}>
                Select all
              </button>
              <button
                type="button"
                className="rounded px-1 py-0.5 text-foreground hover:bg-state-hover"
                onClick={() => setHidden(new Set(projects.map(([key]) => key)))}
              >
                Clear
              </button>
            </span>
          </div>
          <div role="group" aria-label="Projects">
            {projects.map(([key, { name, count }]) => {
              const checked = !hidden.has(key);
              const color = colorOf(key);
              return (
                <button
                  key={key}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => toggle(key)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    className="grid size-4 shrink-0 place-items-center rounded border-[1.5px] text-white"
                    style={checked ? { backgroundColor: color, borderColor: color } : { borderColor: "color-mix(in oklch, var(--foreground) 30%, transparent)" }}
                  >
                    {checked ? <Icon name="Check" className="size-3" /> : null}
                  </span>
                  <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">{key}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{name}</span>
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SortMenu({ sort, setSort }: { sort: SortMode; setSort: (sort: SortMode) => void }) {
  const options: Array<[SortMode, string]> = [
    ["priority", "Priority"],
    ["updated", "Recently updated"],
    ["stale", "Stalest first"],
  ];
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-8 px-2.5 text-muted-foreground">
          <Icon name="ArrowUpDown" className="size-3.5" />
          {options.find(([value]) => value === sort)?.[1]}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align="start"
          className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {options.map(([value, label]) => (
            <Popover.Close asChild key={value}>
              <button
                type="button"
                onClick={() => setSort(value)}
                className={cn(
                  "block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-state-hover",
                  sort === value && "bg-state-active",
                )}
              >
                {label}
              </button>
            </Popover.Close>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---- Issue drawer ---------------------------------------------------------

function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-7 grid-cols-[84px_minmax(0,1fr)] items-center gap-3 text-[13px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 flex min-w-0 items-center gap-1.5 text-foreground">{children}</dd>
    </div>
  );
}

function stackTimeLeft(expiresAt: string | null, now = Date.now()) {
  if (!expiresAt) return null;
  const hours = (Date.parse(expiresAt) - now) / 3_600_000;
  if (!Number.isFinite(hours)) return null;
  if (hours <= 0) return "expired";
  return hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min left` : `${Math.round(hours)} h left`;
}

const STACK_TONE_TEXT: Record<string, string> = {
  good: "text-success",
  warn: "text-warning-text",
  bad: "text-destructive",
  info: "text-[var(--color-timeline-accent,var(--primary))]",
  neutral: "text-muted-foreground",
};
const STACK_TONE_RANK = ["bad", "warn", "info", "good", "neutral"];

/**
 * One line among the ticket's fields: the ticket's test stack and the one thing to know about it first
 * (failed, a service down, expiring, behind its PR, scenarios verified, or ready to test), or a link to launch
 * one. From the Stack Control plugin; hidden without it.
 */
function TicketStackRow({ stacks }: { stacks: IssueStacks | null }) {
  if (!stacks?.available) return null;
  if (stacks.stacks.length === 0) {
    return (
      <PropertyRow label="Test stack">
        {stacks.launchPath ? (
          <UrlLink href={stacks.launchPath} className="font-medium text-foreground underline underline-offset-2">
            Launch one
          </UrlLink>
        ) : (
          <span className="text-muted-foreground">None</span>
        )}
      </PropertyRow>
    );
  }
  const ranked = [...stacks.stacks].sort(
    (a, b) => STACK_TONE_RANK.indexOf(a.headline?.tone ?? a.tone ?? "good") - STACK_TONE_RANK.indexOf(b.headline?.tone ?? b.tone ?? "good"),
  );
  const top = ranked[0]!;
  const tone = top.headline?.tone ?? top.tone ?? "good";
  const left = stackTimeLeft(top.expiresAt);
  return (
    <PropertyRow label="Test stack">
      <span className={cn("shrink-0 font-medium", STACK_TONE_TEXT[tone])} title={top.headline?.detail}>
        {top.headline?.text ?? top.healthShort ?? top.status}
      </span>
      <span className="text-muted-foreground">·</span>
      <UrlLink href={top.path} className="min-w-0 truncate font-mono text-[12.5px] text-foreground underline-offset-2 hover:underline" title={`Open ${top.name} in Stacks`}>
        {top.name}
      </UrlLink>
      {left ? <span className="shrink-0 text-xs text-muted-foreground">{left}</span> : null}
      {stacks.stacks.length > 1 ? <span className="shrink-0 text-xs text-muted-foreground">+{stacks.stacks.length - 1} more</span> : null}
    </PropertyRow>
  );
}

function SectionLabel({ id, children, count }: { id: string; children: ReactNode; count?: number }) {
  return (
    <h3 id={id} className="mb-2 flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
      {children}
      {count === undefined ? null : <span className="font-normal tabular-nums">{count}</span>}
    </h3>
  );
}

function ChatDialog({
  issue,
  open,
  onOpenChange,
}: {
  issue: JiraIssue;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);

  useEffect(() => {
    if (!open || projectId !== null) return;
    let active = true;
    setProjectError(null);
    void rpc.call("jira_project_ensure").then(
      (result) => {
        if (active) {
          setProjectId(result.projectId);
          setFocusRequest((value) => value + 1);
        }
      },
      (cause) => {
        if (active) setProjectError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [open, projectId, rpc]);

  useEffect(() => {
    if (open && projectId !== null) setFocusRequest((value) => value + 1);
  }, [open, projectId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Glyph name="chat" className="size-4 text-muted-foreground" />
            Chat about {issue.key}
          </DialogTitle>
          <DialogDescription>
            Ask a question or talk it through. The agent gets the ticket and its comments as context, and won't
            start working or change Jira unless you ask.
          </DialogDescription>
        </DialogHeader>
        {projectError !== null ? (
          <p role="alert" className="text-sm text-destructive">{projectError}</p>
        ) : projectId === null ? (
          <div className="h-32 animate-pulse rounded-lg bg-muted/70" aria-label="Preparing the chat" />
        ) : (
          <NewThreadComposer
            defaultProjectId={projectId}
            draftKey={`jira-board.chat.${issue.key}`}
            placeholder={`What do you want to discuss about ${issue.key}?`}
            layout="document"
            focusRequest={focusRequest}
            onSubmit={async (request) => {
              try {
                const result = await rpc.call("thread_chat", { key: issue.key, request });
                onOpenChange(false);
                navigate.toThread(result.threadId);
              } catch (cause) {
                toast.error(cause instanceof Error ? cause.message : String(cause));
                throw cause;
              }
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---- Field editors ------------------------------------------------------------

type Choice = { id: string; text: string; leading?: ReactNode; hint?: string; selected?: boolean };

/** A property value that opens a short list of choices when Jira allows changing it. */
function ChoiceMenu({
  label,
  value,
  choices,
  busy,
  emptyText,
  onSelect,
}: {
  label: string;
  value: ReactNode;
  /** null while the choices load. */
  choices: Choice[] | null;
  busy: boolean;
  emptyText: string;
  onSelect: (id: string) => void;
}) {
  const loading = choices === null;
  const portalScope = usePortalScopeProps();
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`Change ${label}`}
          disabled={loading || busy}
          className="-mx-1.5 inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-[13px] transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
        >
          {value}
          {busy || loading ? (
            <Glyph name="refresh" className={cn("size-3 shrink-0 text-muted-foreground", busy && "animate-spin", loading && "opacity-40")} />
          ) : (
            <Icon name="ChevronDown" className="size-3 shrink-0 text-muted-foreground" />
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...portalScope}
          sideOffset={4}
          align="start"
          aria-label={`${label} choices`}
          className="z-50 max-h-80 min-w-56 max-w-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {choices === null || choices.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{emptyText}</p>
          ) : (
            choices.map((choice) => (
              <Popover.Close asChild key={choice.id}>
                <button
                  type="button"
                  aria-current={choice.selected ? "true" : undefined}
                  onClick={() => {
                    if (!choice.selected) onSelect(choice.id);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none",
                    choice.selected && "bg-state-active",
                  )}
                >
                  {choice.leading}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{choice.text}</span>
                    {choice.hint ? <span className="block truncate text-[11px] text-muted-foreground">{choice.hint}</span> : null}
                  </span>
                  {choice.selected ? <Icon name="Check" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                </button>
              </Popover.Close>
            ))
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const POINT_PRESETS = [1, 2, 3, 5, 8, 13];

function StoryPointsEditor({
  issue,
  busy,
  onSave,
}: {
  issue: JiraIssue;
  busy: boolean;
  onSave: (points: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  const current = issue.storyPoints ?? null;
  const portalScope = usePortalScopeProps();

  useEffect(() => {
    if (open) {
      setDraft(current === null ? "" : formatPoints(current));
      setInvalid(false);
    }
  }, [open, current]);

  const save = (points: number | null) => {
    setOpen(false);
    if (points !== current) onSave(points);
  };
  const submit = () => {
    const text = draft.trim();
    if (text === "") return save(null);
    const points = Number(text);
    if (!Number.isFinite(points) || points < 0 || points > 1000) {
      setInvalid(true);
      return;
    }
    save(points);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Change story points"
          disabled={busy}
          className="-mx-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[13px] transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
        >
          {current === null ? <span className="text-muted-foreground">Not estimated</span> : formatPoints(current)}
          {busy ? (
            <Glyph name="refresh" className="size-3 animate-spin text-muted-foreground" />
          ) : (
            <Glyph name="pencil" className="size-3 text-muted-foreground opacity-60" />
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          {...portalScope}
          sideOffset={4}
          align="start"
          aria-label="Story points"
          className="z-50 w-64 rounded-lg border border-border bg-popover p-2.5 text-popover-foreground shadow-md"
        >
          <div className="flex flex-wrap gap-1" role="group" aria-label="Common estimates">
            {POINT_PRESETS.map((points) => (
              <button
                key={points}
                type="button"
                aria-pressed={points === current}
                onClick={() => save(points)}
                className={cn(
                  "grid h-7 min-w-8 place-items-center rounded-md border px-2 text-xs font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  points === current
                    ? "border-transparent bg-foreground text-background"
                    : "border-border hover:bg-state-hover",
                )}
              >
                {points}
              </button>
            ))}
          </div>
          <form
            className="mt-2.5 flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              max={1000}
              step="any"
              value={draft}
              autoFocus
              aria-label="Story points value"
              aria-invalid={invalid || undefined}
              placeholder="Points"
              onChange={(event) => {
                setDraft(event.target.value);
                setInvalid(false);
              }}
              className="h-7 flex-1 text-[13px]"
            />
            <Button type="submit" size="sm" className="h-7 px-2.5">
              Save
            </Button>
          </form>
          {invalid ? <p className="mt-1.5 text-[11px] text-destructive">Enter a number from 0 to 1000.</p> : null}
          {current !== null ? (
            <button
              type="button"
              onClick={() => save(null)}
              className="mt-2 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Clear estimate
            </button>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The drawer's edit options, reloaded after each change to the issue. */
function useEditOptions(issue: JiraIssue, enabled: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const [loaded, setLoaded] = useState<{ key: string; options: EditOptions } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setError(null);
    void rpc.call("issue_edit_options_get", { key: issue.key }).then(
      (options) => {
        if (active) setLoaded({ key: issue.key, options });
      },
      (cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [enabled, issue.key, issue.status, issue.updatedAt, rpc]);
  return { options: enabled && loaded?.key === issue.key ? loaded.options : null, error: enabled ? error : null };
}

/** One extra single-select field, showing the chosen value until fresh options arrive. */
function ExtraFieldRow({ issue, field }: { issue: JiraIssue; field: ExtraField }) {
  const { saving, update } = useEditing();
  const [pending, setPending] = useState<string | null | undefined>(undefined);
  useEffect(() => setPending(undefined), [field.value]);
  const value = pending === undefined ? field.value : pending;
  const label = field.options.find((option) => option.id === value)?.name ?? null;
  return (
    <PropertyRow label={field.name}>
      <ChoiceMenu
        label={field.name}
        value={<span className={cn("truncate", label === null && "text-muted-foreground")}>{label ?? "None"}</span>}
        choices={[
          ...(field.required ? [] : [{ id: "", text: "None", selected: value === null }]),
          ...field.options.map((option) => ({ id: option.id, text: option.name, selected: option.id === value })),
        ]}
        busy={saving.has(issue.key)}
        emptyText="Jira offers no options for this field."
        onSelect={(id) => {
          const optionId = id === "" ? null : id;
          const name = field.options.find((option) => option.id === optionId)?.name;
          setPending(optionId);
          void update(
            issue,
            { fields: { [field.id]: optionId } },
            {},
            name === undefined ? `Cleared ${field.name} on ${issue.key}` : `${field.name} set to ${name} on ${issue.key}`,
          ).then((saved) => {
            if (!saved) setPending(undefined);
          });
        }}
      />
    </PropertyRow>
  );
}

function EditableProperties({ issue, options }: { issue: JiraIssue; options: EditOptions | null }) {
  const { saving, transition, update } = useEditing();
  const { rules } = useBoard();
  const busy = saving.has(issue.key);

  const statusChoices =
    options === null
      ? null
      : distinctTargets(options.transitions, issue.status).map<Choice>((target) => ({
          id: target.id,
          text: target.toStatus,
          leading: <PhaseDot phase={transitionPhase(target, rules)} />,
          hint:
            target.requiredFields.length > 0
              ? `Needs ${target.requiredFields.join(", ")} in Jira`
              : target.name.toLowerCase() !== target.toStatus.toLowerCase()
                ? target.name
                : undefined,
        }));

  const sprint = options?.sprint;
  const currentSprint = sprint?.options.find((candidate) => candidate.id === sprint.currentId) ?? null;
  const sprintChoices: Choice[] | null =
    sprint === undefined
      ? null
      : [
          { id: "backlog", text: "Backlog", hint: "Not in a sprint", selected: sprint.currentId === null },
          ...sprint.options.map((candidate) => ({
            id: candidate.id,
            text: candidate.name,
            hint: [candidate.state === "active" ? "Active" : "Future", candidate.board].filter(Boolean).join(" · "),
            selected: candidate.id === sprint.currentId,
          })),
        ];

  return (
    <>
      <PropertyRow label="Status">
        <ChoiceMenu
          label="status"
          value={<StatusChip issue={issue} />}
          choices={statusChoices}
          busy={busy}
          emptyText="Jira's workflow has no transitions from this status."
          onSelect={(id) => {
            const target = options?.transitions.find((candidate) => candidate.id === id);
            if (target !== undefined) void transition(issue, target);
          }}
        />
      </PropertyRow>
      <PropertyRow label="Priority">
        {options !== null && !options.priority.editable ? (
          <>
            <PriorityIcon priority={issue.priority} />
            {issue.priority}
          </>
        ) : (
          <ChoiceMenu
            label="priority"
            value={
              <>
                <PriorityIcon priority={issue.priority} />
                {issue.priority}
              </>
            }
            choices={
              options?.priority.options.map((priority) => ({
                id: priority.id,
                text: priority.name,
                leading: <span className="inline-flex w-4 justify-center"><PriorityIcon priority={priority.name} /></span>,
                selected: priority.name === issue.priority,
              })) ?? null
            }
            busy={busy}
            emptyText="No priorities are available."
            onSelect={(id) => {
              const name = options?.priority.options.find((priority) => priority.id === id)?.name ?? issue.priority;
              void update(issue, { priorityId: id }, { priority: name }, `${issue.key} priority set to ${name}`);
            }}
          />
        )}
      </PropertyRow>
      <PropertyRow label="Story points">
        {options === null || options.storyPoints.editable ? (
          <StoryPointsEditor
            issue={issue}
            busy={busy || options === null}
            onSave={(points) =>
              void update(
                issue,
                { storyPoints: points },
                { storyPoints: points },
                points === null ? `Cleared the estimate on ${issue.key}` : `${issue.key} estimated at ${pointsLabel(points)}`,
              )
            }
          />
        ) : issue.storyPoints === null || issue.storyPoints === undefined ? (
          <span className="text-muted-foreground" title="Story points aren't on this issue's edit screen in Jira.">
            Not estimated
          </span>
        ) : (
          formatPoints(issue.storyPoints)
        )}
      </PropertyRow>
      {(options?.fields ?? []).map((field) => <ExtraFieldRow key={field.id} issue={issue} field={field} />)}
      <PropertyRow label="Sprint">
        {sprint !== undefined && !sprint.editable ? (
          issue.sprint?.name ?? <span className="text-muted-foreground">None</span>
        ) : (
          <ChoiceMenu
            label="sprint"
            value={
              <span className={cn("truncate", currentSprint === null && !issue.sprint && "text-muted-foreground")}>
                {currentSprint?.name ?? issue.sprint?.name ?? "Backlog"}
              </span>
            }
            choices={sprintChoices}
            busy={busy}
            emptyText="No open sprints were found for this project."
            onSelect={(id) => {
              const chosen = sprint?.options.find((candidate) => candidate.id === id) ?? null;
              void update(
                issue,
                { sprintId: chosen === null ? null : chosen.id },
                {
                  sprint:
                    chosen?.state === "active"
                      ? { id: chosen.id, name: chosen.name, goal: null, startDate: null, endDate: null }
                      : null,
                },
                chosen === null ? `Moved ${issue.key} to the backlog` : `Moved ${issue.key} to ${chosen.name}`,
              );
            }}
          />
        )}
      </PropertyRow>
    </>
  );
}

function IssueDrawer({
  issue,
  open,
  onClose,
  onOpenEpic,
}: {
  issue: JiraIssue;
  open: boolean;
  onClose: () => void;
  onOpenEpic: (issue: JiraIssue) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const summary = splitSummary(issue.summary);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [comments, setComments] = useState<JiraComment[] | null>(null);
  const [commentsCached, setCommentsCached] = useState(true);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [startingWork, setStartingWork] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [stacks, setStacks] = useState<IssueStacks | null>(null);
  const tags = [...new Set([...summary.labels, ...issue.labels])];

  useEffect(() => {
    let active = true;
    setStacks(null);
    void rpc.call("issue_stacks_get", { key: issue.key }).then(
      (result) => active && setStacks(result),
      () => active && setStacks(null),
    );
    return () => {
      active = false;
    };
  }, [issue.key, rpc]);
  const { editable, needsToken } = useEditing();
  const edit = useEditOptions(issue, editable && open);

  useEffect(() => {
    if (open) closeRef.current?.focus({ preventScroll: true });
  }, [open, issue.key]);

  useEffect(() => {
    let active = true;
    setComments(null);
    setCommentsCached(true);
    setCommentsError(null);
    setStartingWork(false);
    setChatOpen(false);
    void rpc.call("issue_comments_get", { key: issue.key }).then(
      (result) => {
        if (active) {
          setComments(result.comments);
          setCommentsCached(result.cached);
        }
      },
      (cause) => {
        if (active) {
          setCommentsError(cause instanceof Error ? cause.message : String(cause));
          setComments([]);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [issue.key, rpc]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issue.url);
      toast.success("Jira link copied");
    } catch {
      toast.error("Could not copy the Jira link");
    }
  };

  const startWork = async () => {
    setStartingWork(true);
    try {
      const result = await rpc.call("thread_start", { key: issue.key });
      navigate.toThread(result.threadId);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
      setStartingWork(false);
    }
  };

  return (
    <aside
      aria-label={`${issue.key} details`}
      aria-hidden={!open}
      inert={!open}
      className={cn(
        "absolute inset-y-0 right-0 z-30 flex w-[min(460px,92%)] flex-col border-l border-border bg-background shadow-[0_16px_40px_rgb(16_24_40/0.18)] transition-transform duration-200 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none",
        open ? "translate-x-0" : "translate-x-[104%]",
      )}
    >
      <header className="shrink-0 border-b border-border px-5 pb-3.5 pt-4">
        <div className="flex items-center gap-2">
          <ProjectChip project={issue.project} />
          <span className="font-mono text-xs text-muted-foreground">{issue.key}</span>
          <span className="text-xs text-muted-foreground">· {issue.type}</span>
          <div className="ml-auto flex items-center gap-0.5">
            <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => void copy()} aria-label="Copy Jira link">
              <Icon name="Copy" className="size-3.5" />
            </Button>
            <Button ref={closeRef} type="button" variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label="Close issue details">
              <Icon name="X" className="size-4" />
            </Button>
          </div>
        </div>
        <h2 className="mt-2.5 text-[17px] font-semibold leading-[1.35] tracking-[-0.01em] text-foreground">{summary.title}</h2>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-4">
        <dl className="m-0 mb-5 flex flex-col gap-1">
          {editable ? (
            <EditableProperties issue={issue} options={edit.options} />
          ) : (
            <>
              <PropertyRow label="Status"><StatusChip issue={issue} /></PropertyRow>
              <PropertyRow label="Priority"><PriorityIcon priority={issue.priority} />{issue.priority}</PropertyRow>
              <PropertyRow label="Story points">
                {issue.storyPoints === null || issue.storyPoints === undefined ? (
                  <span className="text-muted-foreground">Not estimated</span>
                ) : (
                  formatPoints(issue.storyPoints)
                )}
              </PropertyRow>
              {issue.sprint ? <PropertyRow label="Sprint">{issue.sprint.name}</PropertyRow> : null}
            </>
          )}
          {issue.parentSummary ? (
            <PropertyRow label="Epic">
              <button
                type="button"
                onClick={() => onOpenEpic(issue)}
                className="min-w-0 truncate rounded-md border border-border px-2 py-0.5 text-left text-[13px] hover:bg-state-hover"
                title="Show this epic's tickets"
              >
                {issue.parentSummary}
              </button>
            </PropertyRow>
          ) : null}
          <PropertyRow label="Project">{issue.projectName}</PropertyRow>
          <PropertyRow label="Assignee">{issue.assignee ?? "Unassigned"}</PropertyRow>
          <TicketStackRow stacks={stacks} />
          {tags.length > 0 ? (
            <PropertyRow label="Tags">
              <span className="flex flex-wrap gap-1 py-1">
                {tags.map((tag) => (
                  <span key={tag} className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{tag}</span>
                ))}
              </span>
            </PropertyRow>
          ) : null}
          <PropertyRow label="Updated">{shortDate(issue.updatedAt)} · {relativeTime(issue.updatedAt)}</PropertyRow>
        </dl>
        {edit.error !== null ? (
          <p role="alert" className="-mt-3 mb-5 text-xs text-destructive">Couldn't load what can be changed: {edit.error}</p>
        ) : null}
        {!editable && needsToken ? (
          <p className="-mt-3 mb-5 text-xs text-muted-foreground">
            To change status, points, priority, or sprint here, add a Jira API token under Settings → Plugins → Jira Board.
          </p>
        ) : null}

        <section aria-labelledby="description-heading" className="mb-6">
          <SectionLabel id="description-heading">Description</SectionLabel>
          {issue.description ? (
            <Markdown content={issue.description} className="text-[13px]" />
          ) : (
            <p className="text-[13px] text-muted-foreground">No description was provided.</p>
          )}
        </section>

        <section aria-labelledby="comments-heading">
          <SectionLabel id="comments-heading" count={comments?.length}>Comments</SectionLabel>
          {comments === null ? (
            <div className="space-y-3" aria-label="Loading comments">
              <div className="h-12 animate-pulse rounded-lg bg-muted/70" />
              <div className="h-16 animate-pulse rounded-lg bg-muted/70" />
            </div>
          ) : comments.length === 0 ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {commentsError ??
                (commentsCached ? "No comments on this ticket yet." : "Comments will appear after the next board refresh.")}
            </p>
          ) : (
            <ol className="flex flex-col gap-3">
              {comments.map((comment) => (
                <li key={comment.id} className="rounded-[10px] bg-muted/50 px-3 py-2.5">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-semibold text-foreground">{comment.author}</span>
                    <time className="text-[11px] text-muted-foreground" dateTime={comment.createdAt}>{shortDate(comment.createdAt)}</time>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[13px] leading-[1.55] text-foreground/85">{comment.body || "No text."}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-3">
        <Button
          type="button"
          size="sm"
          onClick={() => void startWork()}
          disabled={startingWork}
          aria-label="Start working on this ticket"
        >
          <Glyph name={startingWork ? "refresh" : "play"} className={cn("size-3.5", startingWork && "animate-spin")} />
          {startingWork ? "Starting work" : "Start working"}
        </Button>
        <Tooltip.Provider delayDuration={250}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => setChatOpen(true)}
                aria-label="Chat about this ticket"
              >
                <Glyph name="chat" className="size-4" />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                side="top"
                sideOffset={6}
                className="z-50 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-md"
              >
                Chat about this ticket
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Tooltip.Provider>
        <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => void navigate.openUrl(issue.url)}>
          <Icon name="ExternalLink" className="size-3.5" />
          Open in Jira
        </Button>
      </footer>
      <ChatDialog issue={issue} open={chatOpen} onOpenChange={setChatOpen} />
    </aside>
  );
}

// ---- Page -------------------------------------------------------------------

/** Asks for an extra field Jira's workflow requires, then retries the status change. */
function RequiredFieldDialog({
  prompt,
  onClose,
  onChoose,
}: {
  prompt: { issue: JiraIssue; target: JiraTransition; field: ExtraField; message: string } | null;
  onClose: () => void;
  onChoose: (prompt: { issue: JiraIssue; target: JiraTransition; field: ExtraField; message: string }, optionId: string) => void;
}) {
  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm gap-3">
        <DialogHeader>
          <DialogTitle>Set {prompt?.field.name} first</DialogTitle>
          <DialogDescription>
            Jira needs {prompt?.field.name} before {prompt?.issue.key} can move to {prompt?.target.toStatus}. Pick a value
            and the move will run again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1" role="group" aria-label={`${prompt?.field.name ?? "Field"} options`}>
          {prompt?.field.options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onChoose(prompt, option.id)}
              className="rounded-lg border border-border px-3 py-2 text-left text-[13px] font-medium hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {option.name}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">Jira said: {prompt?.message}</p>
      </DialogContent>
    </Dialog>
  );
}

/** Asks which status to use when a column holds several statuses the ticket can move to. */
function TransitionChoiceDialog({
  choice,
  onClose,
  onChoose,
}: {
  choice: { issue: JiraIssue; phase: Phase; targets: JiraTransition[] } | null;
  onClose: () => void;
  onChoose: (issue: JiraIssue, target: JiraTransition) => void;
}) {
  const label = SPRINT_PHASES.find((candidate) => candidate.id === choice?.phase)?.label ?? "";
  return (
    <Dialog open={choice !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm gap-3">
        <DialogHeader>
          <DialogTitle>Move {choice?.issue.key} to {label}</DialogTitle>
          <DialogDescription>Pick the Jira status. It's {choice?.issue.status} now.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1" role="group" aria-label="Statuses">
          {choice?.targets.map((target) => (
            <button
              key={target.id}
              type="button"
              onClick={() => onChoose(choice.issue, target)}
              className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-left text-[13px] hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <PhaseDot phase={choice.phase} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{target.toStatus}</span>
                {target.requiredFields.length > 0 ? (
                  <span className="block text-[11px] text-muted-foreground">Needs {target.requiredFields.join(", ")} in Jira</span>
                ) : target.name.toLowerCase() !== target.toStatus.toLowerCase() ? (
                  <span className="block text-[11px] text-muted-foreground">{target.name}</span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex h-full flex-col gap-4 px-6 py-5" aria-label="Loading Jira issues">
      <div className="h-6 w-40 animate-pulse rounded bg-muted" />
      <div className="grid min-h-0 flex-1 gap-3.5" style={{ gridTemplateColumns: `repeat(${PHASES.length}, minmax(0, 1fr))` }}>
        {PHASES.map((phase, column) => (
          <div
            key={phase.id}
            className="rounded-[14px] p-3"
            style={{ backgroundColor: tint(PHASE_COLORS[phase.id], 9, "var(--background)") }}
          >
            <div className="mb-4 flex items-center gap-2">
              <PhaseDot phase={phase.id} className="opacity-50" />
              <div className="h-3 w-16 animate-pulse rounded bg-muted-foreground/15" />
            </div>
            <div className="space-y-2">
              {Array.from({ length: [6, 1, 4, 2][column] ?? 2 }, (_, index) => (
                <div key={index} className="h-[92px] animate-pulse rounded-[10px] border border-border bg-card/80" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CenteredState({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6"><div className="max-w-md text-center">{children}</div></div>;
}

function JiraBoardPage() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<BoardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<ViewMode>("board");
  const [query, setQuery] = useState("");
  const [hiddenProjects, setHiddenProjectsState] = useState<Set<string>>(readHiddenProjects);
  const [sort, setSort] = useState<SortMode>("priority");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [drawerKey, setDrawerKey] = useState<string | null>(null);
  const [epicId, setEpicId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, IssuePatch>>({});
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [choice, setChoice] = useState<{ issue: JiraIssue; phase: Phase; targets: JiraTransition[] } | null>(null);
  const [fieldPrompt, setFieldPrompt] = useState<{
    issue: JiraIssue;
    target: JiraTransition;
    field: ExtraField;
    message: string;
  } | null>(null);
  const transitionCache = useRef(new Map<string, Promise<JiraTransition[]>>());

  const setHiddenProjects = useCallback((next: Set<string>) => {
    setHiddenProjectsState(next);
    writeHiddenProjects(next);
  }, []);

  const select = useCallback((key: string | null) => {
    setSelectedKey(key);
    if (key !== null) setDrawerKey(key);
  }, []);

  const load = useCallback(async () => {
    try {
      setState(await rpc.call("board_get"));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime("jira-issues-changed", () => void load());

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await rpc.call("board_refresh");
      setState(next);
      setError(null);
      toast.success(`Refreshed ${next.snapshot?.issues.length ?? 0} Jira issues`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      toast.error(message);
    } finally {
      setRefreshing(false);
    }
  }, [rpc]);

  const withOverrides = useCallback(
    (issues: JiraIssue[] | undefined) =>
      (issues ?? []).map((issue) => (overrides[issue.key] === undefined ? issue : { ...issue, ...overrides[issue.key] })),
    [overrides],
  );
  const allIssues = useMemo(() => withOverrides(state?.snapshot?.issues), [state, withOverrides]);
  const allSprintIssues = useMemo(() => withOverrides(state?.snapshot?.sprintIssues), [state, withOverrides]);
  const sprintSupport: SprintSupport = state?.snapshot?.sprints ?? "unknown";
  const applyFilters = useCallback(
    (issues: JiraIssue[]) => {
      const needle = query.trim().toLowerCase();
      const filtered = issues.filter(
        (issue) =>
          !hiddenProjects.has(issue.project) &&
          (needle === "" ||
            [issue.key, issue.summary, issue.status, issue.project, issue.projectName, issue.parentSummary, ...issue.labels]
              .filter(Boolean)
              .join(" ")
              .toLowerCase()
              .includes(needle)),
      );
      return filtered.sort((a, b) => {
        if (sort === "updated") return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        if (sort === "stale") return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
        return (
          (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
      });
    },
    [hiddenProjects, query, sort],
  );
  const visibleIssues = useMemo(() => applyFilters(allIssues), [allIssues, applyFilters]);
  const visibleSprintIssues = useMemo(() => applyFilters(allSprintIssues), [allSprintIssues, applyFilters]);
  const [sprintId, setSprintId] = useState<string | null>(null);
  const navigableIssues = view === "sprint" ? visibleSprintIssues.filter((issue) => issue.sprint !== null) : visibleIssues;
  const knownIssues = useMemo(() => {
    const byKey = new Map(allSprintIssues.map((issue) => [issue.key, issue]));
    for (const issue of allIssues) byKey.set(issue.key, issue);
    return [...byKey.values()];
  }, [allIssues, allSprintIssues]);

  const selected = knownIssues.find((issue) => issue.key === selectedKey) ?? null;
  const drawerIssue = knownIssues.find((issue) => issue.key === drawerKey) ?? null;
  const phaseRules = state?.phaseRules;
  const pinnedColors = state?.projectColors;
  const board = useMemo<BoardContextValue>(() => {
    const rules = phaseRules ?? DEFAULT_PHASE_RULES;
    const colors = assignProjectColors(
      [...new Set(knownIssues.map((issue) => issue.project))],
      pinnedColors ?? {},
    );
    return {
      rules,
      phaseOf: (issue) => phaseFor(issue, rules),
      colorOf: (project) => colors[project] ?? PROJECT_PALETTE[hashKey(project) % PROJECT_PALETTE.length]!,
    };
  }, [knownIssues, phaseRules, pinnedColors]);
  const blockedCount = visibleIssues.filter((issue) => board.phaseOf(issue) === "blocked").length;

  // ---- Editing ----

  const loadTransitions = useCallback(
    (issue: JiraIssue) => {
      const cacheKey = `${issue.key}|${issue.status}`;
      let transitions = transitionCache.current.get(cacheKey);
      if (transitions === undefined) {
        transitions = rpc.call("issue_transitions_get", { key: issue.key }).then((result) => result.transitions);
        transitionCache.current.set(cacheKey, transitions);
        transitions.catch(() => transitionCache.current.delete(cacheKey));
      }
      return transitions;
    },
    [rpc],
  );

  /** Applies the change locally right away, then replaces it with Jira's result or rolls it back. */
  const write = useCallback(
    async (
      issue: JiraIssue,
      optimistic: IssuePatch,
      call: () => Promise<BoardState>,
      success: string,
      /** Handles a refusal itself (returns true) instead of showing the error. */
      recover?: (message: string) => Promise<boolean>,
    ) => {
      setOverrides((current) => ({ ...current, [issue.key]: { ...current[issue.key], ...optimistic } }));
      setSaving((current) => new Set(current).add(issue.key));
      try {
        setState(await call());
        toast.success(success);
        return true;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!(await recover?.(message).catch(() => false))) toast.error(`Couldn't update ${issue.key}: ${message}`);
        return false;
      } finally {
        setOverrides(({ [issue.key]: _done, ...rest }) => rest);
        setSaving((current) => {
          const next = new Set(current);
          next.delete(issue.key);
          return next;
        });
      }
    },
    [rpc],
  );

  const transition = useCallback(
    async (issue: JiraIssue, target: JiraTransition) => {
      if (target.requiredFields.length > 0) {
        toast.error(`Moving ${issue.key} to ${target.toStatus} needs ${target.requiredFields.join(", ")}. Finish it in Jira.`, {
          action: { label: "Open in Jira", onClick: () => void navigate.openUrl(issue.url) },
        });
        return false;
      }
      return write(
        issue,
        { status: target.toStatus, statusCategory: target.toStatusCategory },
        () => rpc.call("issue_transition", { key: issue.key, transitionId: target.id }),
        `${issue.key} moved to ${target.toStatus}`,
        // When Jira's workflow needs an extra field that is still empty, ask for it.
        async (message) => {
          const options = await rpc.call("issue_edit_options_get", { key: issue.key });
          const lower = message.toLowerCase();
          const field = (options.fields ?? []).find(
            (candidate) =>
              candidate.value === null &&
              (lower.includes(candidate.name.toLowerCase()) || lower.includes(candidate.id.toLowerCase())),
          );
          if (field === undefined) return false;
          setFieldPrompt({ issue, target, field, message });
          return true;
        },
      );
    },
    [navigate, rpc, write],
  );

  const update = useCallback(
    (issue: JiraIssue, change: Omit<IssueUpdate, "key">, optimistic: IssuePatch, success: string) => {
      // Reuse a cached copy of the sprint so its dates and goal stay on screen.
      const sprint = optimistic.sprint;
      const known = sprint ? knownIssues.find((candidate) => candidate.sprint?.id === sprint.id)?.sprint : undefined;
      return write(
        issue,
        known ? { ...optimistic, sprint: known } : optimistic,
        () => rpc.call("issue_update", { key: issue.key, ...change }),
        success,
      );
    },
    [knownIssues, rpc, write],
  );

  const startDrag = useCallback(
    (issue: JiraIssue) => {
      setDrag({ issue, phase: board.phaseOf(issue), reachable: null });
      loadTransitions(issue).then(
        (transitions) => {
          const reachable = new Set(
            distinctTargets(transitions, issue.status).map((target) => transitionPhase(target, board.rules)),
          );
          setDrag((current) => (current?.issue.key === issue.key ? { ...current, reachable } : current));
        },
        () => {
          // Leave every column open; the drop reports the error.
        },
      );
    },
    [board, loadTransitions],
  );
  const endDrag = useCallback(() => setDrag(null), []);

  const dropOn = useCallback(
    (phase: Phase) => {
      const current = drag;
      setDrag(null);
      if (current === null) return;
      const { issue } = current;
      const label = SPRINT_PHASES.find((candidate) => candidate.id === phase)?.label ?? phase;
      void loadTransitions(issue).then(
        (transitions) => {
          const targets = distinctTargets(transitions, issue.status).filter(
            (target) => transitionPhase(target, board.rules) === phase,
          );
          if (targets.length === 0) {
            toast.error(`Jira's workflow has no way to move ${issue.key} from ${issue.status} to ${label}.`);
          } else if (targets.length === 1) {
            void transition(issue, targets[0]!);
          } else {
            setChoice({ issue, phase, targets });
          }
        },
        (cause) => toast.error(`Couldn't load ${issue.key}'s workflow: ${cause instanceof Error ? cause.message : String(cause)}`),
      );
    },
    [board, drag, loadTransitions, transition],
  );

  const editable = state?.editable ?? false;
  const editing = useMemo<EditingValue>(
    () => ({
      editable,
      needsToken: state !== null && !state.configured,
      saving,
      drag,
      startDrag,
      endDrag,
      dropOn,
      transition,
      update,
    }),
    [drag, dropOn, editable, endDrag, saving, startDrag, state, transition, update],
  );

  const closeDrawer = useCallback(() => {
    if (selectedKey === null) return;
    const key = selectedKey;
    setSelectedKey(null);
    window.requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-issue-key="${CSS.escape(key)}"]`)?.focus(),
    );
  }, [selectedKey]);

  const openEpic = useCallback((issue: JiraIssue) => {
    setView("epics");
    setEpicId(issue.parentKey ?? (issue.parentSummary?.trim() || NO_EPIC));
    setSelectedKey(null);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.matches("input, textarea, select, [contenteditable=true]")) return;
      // Board shortcuts are bare keys only; leave modifier chords (such as BB's
      // Shift+Cmd+J sidebar toggle) to the host and the OS.
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === "Escape") {
        closeDrawer();
        return;
      }
      if ((event.key === "j" || event.key === "k") && !event.shiftKey && navigableIssues.length > 0) {
        event.preventDefault();
        const current = navigableIssues.findIndex((issue) => issue.key === selectedKey);
        const delta = event.key === "j" ? 1 : -1;
        const next = current < 0 ? 0 : (current + delta + navigableIssues.length) % navigableIssues.length;
        select(navigableIssues[next]!.key);
        return;
      }
      if (event.key === "Enter" && selected !== null && !target?.closest("[data-issue-key]")) {
        event.preventDefault();
        void navigate.openUrl(selected.url);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDrawer, navigate, navigableIssues, select, selected, selectedKey]);

  if (state === null && error === null) return <BoardSkeleton />;
  if (state === null) {
    return (
      <CenteredState>
        <Icon name="TriangleAlert" className="mx-auto size-6 text-muted-foreground" />
        <h1 className="mt-3 text-base font-semibold">Jira Board could not load</h1>
        <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        <Button type="button" variant="outline" size="sm" className="mt-4" onClick={() => void load()}>
          Try again
        </Button>
      </CenteredState>
    );
  }
  if (!state.configured && state.snapshot === null) {
    return (
      <CenteredState>
        <Glyph name="columns" className="mx-auto size-7 text-muted-foreground" />
        <h1 className="mt-3 text-base font-semibold">Refresh through Atlassian MCP</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Use the Atlassian MCP connection BB already has. Refresh runs in the background without leaving this board.
          Prefer an API token? Add it under Settings → Plugins → Jira Board.
        </p>
        <Button type="button" size="sm" className="mt-4" onClick={() => void refresh()} disabled={refreshing}>
          <Glyph name="refresh" className={cn("size-4", refreshing && "animate-spin")} />
          {refreshing ? "Refreshing" : "Refresh Jira"}
        </Button>
        <code className="mt-4 block rounded-md bg-muted px-3 py-2 text-left text-xs text-muted-foreground">
          assignee = currentUser() AND statusCategory != Done
        </code>
      </CenteredState>
    );
  }
  if (state.snapshot === null) {
    return (
      <CenteredState>
        <Glyph name="refresh" className="mx-auto size-6 text-muted-foreground" />
        <h1 className="mt-3 text-base font-semibold">Your board is ready to refresh</h1>
        <p className="mt-1 text-sm text-muted-foreground">Pull your currently assigned open Jira issues.</p>
        <Button type="button" size="sm" className="mt-4" onClick={() => void refresh()} disabled={refreshing}>
          <Glyph name="refresh" className={cn("size-4", refreshing && "animate-spin")} />
          {refreshing ? "Refreshing" : "Refresh Jira"}
        </Button>
      </CenteredState>
    );
  }

  const drawerOpen = selected !== null;

  return (
    <BoardContext.Provider value={board}>
    <EditingContext.Provider value={editing}>
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center gap-4 px-6 pb-3 pt-5">
        <div className="min-w-0">
          <h1 className="text-[19px] font-semibold tracking-[-0.01em] text-foreground">My Jira work</h1>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            {visibleIssues.length === allIssues.length
              ? `${allIssues.length} open issues`
              : `${visibleIssues.length} of ${allIssues.length} open issues`}
            {blockedCount > 0 ? (
              <>
                {" · "}
                <span className="text-destructive">{blockedCount} blocked</span>
              </>
            ) : null}
            {" · "}
            {state.snapshot.refreshedAt ? `Updated ${relativeTime(state.snapshot.refreshedAt)}` : "Not refreshed"}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          className="ml-auto h-8 px-3"
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-label={state.configured ? "Refresh Jira issues" : "Refresh Jira issues through Atlassian MCP"}
        >
          <Glyph name="refresh" className={cn("size-3.5", refreshing && "animate-spin")} />
          {refreshing ? "Refreshing" : "Refresh"}
        </Button>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2.5 px-6 pb-4">
        <div className="inline-flex gap-0.5 rounded-[9px] bg-muted p-[3px]" role="group" aria-label="View">
          {VIEWS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              onClick={() => setView(id)}
              className={cn(
                "h-7 rounded-[7px] px-3 text-[13px] font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                view === id && "bg-background text-foreground shadow-sm",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <ProjectPicker issues={knownIssues} hidden={hiddenProjects} setHidden={setHiddenProjects} />
        <div className="relative w-56">
          <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search key or title"
            aria-label="Search Jira issues"
            className="h-8 pl-8 pr-7 text-[13px]"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border bg-background px-1 font-mono text-[9px] text-muted-foreground">/</kbd>
        </div>
        <SortMenu sort={sort} setSort={setSort} />
      </div>

      {error !== null ? (
        <div role="alert" className="mx-6 mb-3 flex min-h-8 items-center gap-2 rounded-lg bg-destructive/10 px-3 text-xs text-destructive">
          <Icon name="TriangleAlert" className="size-3.5" />
          {error}
        </div>
      ) : null}

      <main className="min-h-0 flex-1 overflow-hidden px-6 pb-5">
        {view === "sprint" ? (
          <SprintView
            issues={visibleSprintIssues}
            allSprintIssues={allSprintIssues}
            support={sprintSupport}
            sprintId={sprintId}
            setSprintId={setSprintId}
            selectedKey={selectedKey}
            onSelect={(issue) => select(issue.key)}
          />
        ) : visibleIssues.length === 0 ? (
          <CenteredState>
            <Icon name="CircleCheck" className="mx-auto size-6 text-muted-foreground" />
            <h2 className="mt-3 text-sm font-semibold">
              {allIssues.length === 0 ? "No open issues assigned to you" : "No issues match this view"}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {allIssues.length === 0 ? "That is a successful empty state." : "Clear search or pick more projects to see more work."}
            </p>
          </CenteredState>
        ) : view === "board" ? (
          <div className="h-full overflow-x-auto">
            <PhaseBoard issues={visibleIssues} selectedKey={selectedKey} onSelect={(issue) => select(issue.key)} />
          </div>
        ) : (
          <EpicsView
            issues={visibleIssues}
            siteUrl={state.siteUrl}
            epicId={epicId}
            setEpicId={setEpicId}
            selectedKey={selectedKey}
            onSelect={(issue) => select(issue.key)}
          />
        )}
      </main>

      <div
        aria-hidden
        onClick={closeDrawer}
        className={cn(
          "absolute inset-0 z-20 bg-black/25 transition-opacity duration-200 motion-reduce:transition-none",
          drawerOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      {drawerIssue !== null ? (
        <IssueDrawer
          issue={drawerIssue}
          open={drawerOpen}
          onClose={closeDrawer}
          onOpenEpic={openEpic}
        />
      ) : null}
      <RequiredFieldDialog
        prompt={fieldPrompt}
        onClose={() => setFieldPrompt(null)}
        onChoose={async (prompt, optionId) => {
          setFieldPrompt(null);
          const option = prompt.field.options.find((candidate) => candidate.id === optionId);
          const saved = await update(
            prompt.issue,
            { fields: { [prompt.field.id]: optionId } },
            {},
            `${prompt.field.name} set to ${option?.name ?? "a value"} on ${prompt.issue.key}`,
          );
          if (saved) await transition(prompt.issue, prompt.target);
        }}
      />
      <TransitionChoiceDialog
        choice={choice}
        onClose={() => setChoice(null)}
        onChoose={(issue, target) => {
          setChoice(null);
          void transition(issue, target);
        }}
      />
    </div>
    </EditingContext.Provider>
    </BoardContext.Provider>
  );
}

export default definePluginApp((app) => {
  app.experimental_icons.register({
    name: "jira-board.columns",
    component: ({ className }) => <Glyph name="columns" className={className} />,
  });
  app.slots.navPanel({
    id: "board",
    title: "Jira",
    icon: "jira-board.columns",
    path: "board",
    component: JiraBoardPage,
  });
});

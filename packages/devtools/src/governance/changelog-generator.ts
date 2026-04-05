/**
 * Changelog generator from Conventional Commits
 *
 * Parses git commit messages in Conventional Commits format and generates
 * Markdown changelogs grouped by type and optionally by version.
 */

// -- Types --------------------------------------------------------

export interface ConventionalCommit {
  /** Full commit hash */
  hash: string;
  /** Short hash (first 7 chars) */
  shortHash: string;
  /** Commit type (feat, fix, refactor, etc.) */
  type: string;
  /** Optional scope in parentheses */
  scope?: string;
  /** Whether this is a breaking change (! suffix or BREAKING CHANGE footer) */
  breaking: boolean;
  /** Commit subject (after type: prefix) */
  subject: string;
  /** Full commit body (if any) */
  body?: string;
  /** Commit date */
  date: Date;
  /** Author name */
  author: string;
}

export interface ChangelogOptions {
  /** Version label for the changelog section (e.g. "1.2.0") */
  version?: string;
  /** Date for the version header */
  date?: Date;
  /** Group types to include (default: all) */
  includeTypes?: string[];
  /** Whether to include commit hashes in output (default: true) */
  includeHashes?: boolean;
  /** Whether to include breaking changes section (default: true) */
  includeBreaking?: boolean;
}

export interface VersionGroup {
  version: string;
  date: Date;
  commits: ConventionalCommit[];
}

// -- Conventional Commit parser -----------------------------------

const CONVENTIONAL_COMMIT_RE =
  /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?:\s+(?<subject>.+)$/;

/**
 * Parse a raw commit message line into a ConventionalCommit structure.
 * Returns null if the message does not follow conventional commit format.
 */
export function parseConventionalCommit(
  message: string,
  meta: { hash: string; date: Date; author: string; body?: string },
): ConventionalCommit | null {
  const match = message.match(CONVENTIONAL_COMMIT_RE);
  if (!match?.groups) return null;

  const { type, scope, breaking, subject } = match.groups;

  const hasBreakingFooter = meta.body?.includes("BREAKING CHANGE") ?? false;

  return {
    hash: meta.hash,
    shortHash: meta.hash.slice(0, 7),
    type: type as string,
    scope: scope || undefined,
    breaking: !!breaking || hasBreakingFooter,
    subject: subject as string,
    body: meta.body || undefined,
    date: meta.date,
    author: meta.author,
  };
}

// -- Commit grouping ----------------------------------------------

/** Human-readable labels for conventional commit types */
const TYPE_LABELS: Record<string, string> = {
  feat: "Features",
  fix: "Bug Fixes",
  refactor: "Refactoring",
  perf: "Performance",
  test: "Tests",
  docs: "Documentation",
  style: "Style",
  build: "Build",
  ci: "CI/CD",
  chore: "Chores",
};

/** Presentation order for commit types */
const TYPE_ORDER: string[] = [
  "feat",
  "fix",
  "perf",
  "refactor",
  "docs",
  "test",
  "build",
  "ci",
  "style",
  "chore",
];

/**
 * Group commits by their type.
 * Returns a Map preserving preferred type order.
 */
function groupByType(commits: ConventionalCommit[]): Map<string, ConventionalCommit[]> {
  const groups = new Map<string, ConventionalCommit[]>();

  // Initialize in preferred order
  for (const type of TYPE_ORDER) {
    const matching = commits.filter((c) => c.type === type);
    if (matching.length > 0) {
      groups.set(type, matching);
    }
  }

  // Add any remaining types not in the predefined order
  for (const commit of commits) {
    if (!groups.has(commit.type)) {
      groups.set(commit.type, [commit]);
    } else if (!TYPE_ORDER.includes(commit.type)) {
      const existing = groups.get(commit.type) ?? [];
      if (!existing.includes(commit)) {
        existing.push(commit);
      }
    }
  }

  return groups;
}

// -- Changelog generation -----------------------------------------

/**
 * Generate a Markdown changelog from parsed conventional commits.
 */
export function generateChangelog(
  commits: ConventionalCommit[],
  options: ChangelogOptions = {},
): string {
  const { version, date, includeTypes, includeHashes = true, includeBreaking = true } = options;

  let filtered = commits;
  if (includeTypes && includeTypes.length > 0) {
    filtered = commits.filter((c) => includeTypes.includes(c.type));
  }

  if (filtered.length === 0) {
    return "";
  }

  const lines: string[] = [];

  // Version header
  if (version) {
    const dateStr = (date ?? new Date()).toISOString().slice(0, 10);
    lines.push(`## ${version} (${dateStr})`);
  } else {
    lines.push("## Unreleased");
  }
  lines.push("");

  // Breaking changes section
  if (includeBreaking) {
    const breaking = filtered.filter((c) => c.breaking);
    if (breaking.length > 0) {
      lines.push("### BREAKING CHANGES");
      lines.push("");
      for (const commit of breaking) {
        const scope = commit.scope ? `**${commit.scope}:** ` : "";
        const hash = includeHashes ? ` (${commit.shortHash})` : "";
        lines.push(`- ${scope}${commit.subject}${hash}`);
      }
      lines.push("");
    }
  }

  // Grouped by type
  const groups = groupByType(filtered);
  for (const [type, typeCommits] of groups) {
    const label = TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
    lines.push(`### ${label}`);
    lines.push("");
    for (const commit of typeCommits) {
      const scope = commit.scope ? `**${commit.scope}:** ` : "";
      const hash = includeHashes ? ` (${commit.shortHash})` : "";
      lines.push(`- ${scope}${commit.subject}${hash}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
 * Generate a changelog from multiple version groups.
 */
export function generateVersionedChangelog(
  versions: VersionGroup[],
  options: Omit<ChangelogOptions, "version" | "date"> = {},
): string {
  const sections: string[] = [];

  for (const vg of versions) {
    const section = generateChangelog(vg.commits, {
      ...options,
      version: vg.version,
      date: vg.date,
    });
    if (section) {
      sections.push(section);
    }
  }

  if (sections.length === 0) return "";

  return `# Changelog\n\n${sections.join("\n\n")}`;
}

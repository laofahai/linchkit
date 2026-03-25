/**
 * linch changelog — Generate changelog from git commits
 *
 * Reads git log history, parses Conventional Commits, and generates
 * a Markdown changelog using the governance module (spec 37).
 */

import type { ConventionalCommit } from "@linchkit/core/governance";
import { generateChangelog, parseConventionalCommit } from "@linchkit/core/governance";
import { defineCommand } from "citty";
import consola from "consola";

export const changelogCommand = defineCommand({
  meta: {
    name: "changelog",
    description: "Generate changelog from git commits (Conventional Commits)",
  },
  args: {
    from: {
      type: "string",
      description: "Start tag or commit (default: latest tag or first commit)",
    },
    to: {
      type: "string",
      description: "End tag or commit (default: HEAD)",
      default: "HEAD",
    },
    version: {
      type: "string",
      description: "Version label for the changelog header",
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output file path (default: stdout)",
    },
    json: {
      type: "boolean",
      description: "Output parsed commits as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const from = args.from as string | undefined;
    const to = (args.to as string) || "HEAD";
    const version = args.version as string | undefined;
    const outputFile = args.output as string | undefined;
    const outputJson = args.json as boolean;

    // Determine the --from range
    let rangeStart = from;
    if (!rangeStart) {
      // Try to find the latest tag
      rangeStart = await getLatestTag();
      if (rangeStart) {
        consola.info(`Using latest tag as start: ${rangeStart}`);
      }
    }

    const range = rangeStart ? `${rangeStart}..${to}` : to;

    // Read git log
    consola.start(`Reading git log: ${range}`);
    const rawCommits = await readGitLog(range);

    if (rawCommits.length === 0) {
      consola.warn("No commits found in the specified range.");
      return;
    }

    consola.info(`Found ${rawCommits.length} commit(s).`);

    // Parse conventional commits
    const parsed: ConventionalCommit[] = [];
    let skipped = 0;

    for (const raw of rawCommits) {
      const commit = parseConventionalCommit(raw.message, {
        hash: raw.hash,
        date: new Date(raw.date),
        author: raw.author,
        body: raw.body,
      });
      if (commit) {
        parsed.push(commit);
      } else {
        skipped++;
      }
    }

    if (skipped > 0) {
      consola.warn(`${skipped} commit(s) skipped (not in Conventional Commits format).`);
    }

    if (parsed.length === 0) {
      consola.warn("No conventional commits found to generate changelog.");
      return;
    }

    if (outputJson) {
      const output = JSON.stringify(parsed, null, 2);
      if (outputFile) {
        await Bun.write(outputFile, output);
        consola.success(`JSON written to ${outputFile}`);
      } else {
        console.log(output);
      }
      return;
    }

    // Generate markdown changelog
    const changelog = generateChangelog(parsed, {
      version,
      date: new Date(),
    });

    if (outputFile) {
      await Bun.write(outputFile, `${changelog}\n`);
      consola.success(`Changelog written to ${outputFile}`);
    } else {
      console.log("");
      console.log(changelog);
      console.log("");
    }
  },
});

// ── Git helpers ─────────────────────────────────────────

interface RawCommit {
  hash: string;
  message: string;
  date: string;
  author: string;
  body?: string;
}

/**
 * Read git log and parse into raw commit objects.
 * Uses a delimiter-based format to reliably split multi-line messages.
 */
async function readGitLog(range: string): Promise<RawCommit[]> {
  const DELIMITER = "---LINCH_COMMIT_DELIMITER---";
  const format = `${DELIMITER}%n%H%n%aI%n%aN%n%s%n%b${DELIMITER}`;

  const proc = Bun.spawn(["git", "log", `--format=${format}`, range], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  if (proc.exitCode !== 0) {
    throw new Error(`git log failed: ${stderr.trim()}`);
  }

  const commits: RawCommit[] = [];
  const blocks = stdout.split(DELIMITER).filter((b) => b.trim());

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 4) continue;

    const hash = lines[0]?.trim();
    const date = lines[1]?.trim();
    const author = lines[2]?.trim();
    const message = lines[3]?.trim();
    const body = lines.slice(4).join("\n").trim() || undefined;

    if (hash && date && author && message) {
      commits.push({ hash, date, author, message, body });
    }
  }

  return commits;
}

/**
 * Get the latest git tag, or undefined if none exists.
 */
async function getLatestTag(): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "describe", "--tags", "--abbrev=0"], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    });

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode === 0) {
      const tag = stdout.trim();
      return tag || undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

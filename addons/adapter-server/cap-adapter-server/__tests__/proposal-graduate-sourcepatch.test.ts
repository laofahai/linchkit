/**
 * Graduation source-patch wiring — the #566 capstone.
 *
 * Proves the WHOLE server-side chain for "say→change an existing code-condition
 * rule's threshold": the graduate route, using its DEFAULT writer with the
 * injected `sourcePatcher` (the real `patchNamedConstant` from
 * `@linchkit/devtools`, the same one `server.ts` wires in), rewrites the named
 * constant in a real source file when an approved proposal carries a
 * `sourcePatch`. No `createWriter` override — that is the point: the default
 * factory must thread the injected patcher through to `ProposalFileWriter`.
 *
 * The committer is the only stub (no real `git`/`gh`). The patch target is a
 * temp file created UNDER the repo root so the writer's default repoRoot
 * (`process.cwd()`) containment accepts it.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { CommandLayer, ProposalDefinition } from "@linchkit/core";
import type { ProposalGitCommitResult } from "@linchkit/core/server";
import { patchNamedConstant } from "@linchkit/devtools";
import { Elysia } from "elysia";
import {
  type GraduationEngine,
  type GraduationGitCommitter,
  mountProposalGraduateAPI,
} from "../src/proposal-graduate-api";

const BASE = "http://local.test";
const PASS_COMMAND_LAYER = { execute: async () => ({ success: true }) } as unknown as CommandLayer;

let tempDir: string | null = null;
afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

test("graduate patches the real source constant via the injected default sourcePatcher", async () => {
  // A temp module UNDER the repo root so default repoRoot containment accepts it.
  tempDir = mkdtempSync(join(process.cwd(), ".tmp-graduate-sp-"));
  const absFile = join(tempDir, "threshold.ts");
  writeFileSync(absFile, "/** demo */\nexport const MANAGER_APPROVAL_THRESHOLD = 10000;\n", "utf8");
  const relFile = relative(process.cwd(), absFile);

  const proposal = {
    id: "prop-sp-1",
    title: "Raise manager-approval threshold to 20000",
    description: "say→change the existing code-condition rule's threshold",
    author: { type: "ai", id: "schema-intent", name: "Schema Intent" },
    capability: "cap-purchase-demo",
    changeType: "minor",
    changes: [
      {
        target: "rule",
        operation: "update",
        name: "manager_approval_threshold",
        sourcePatch: {
          filePath: relFile,
          constantName: "MANAGER_APPROVAL_THRESHOLD",
          newValueLiteral: "20000",
        },
      },
    ],
    impact: {
      schemasAffected: [],
      actionsAffected: [],
      rulesAffected: ["manager_approval_threshold"],
      dependentsAffected: [],
      migrationRequired: false,
    },
    status: "approved",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as ProposalDefinition;

  const engine: GraduationEngine = {
    getProposal: (id) => {
      if (id !== proposal.id) throw new Error("not found");
      return proposal;
    },
    commitProposal: () => undefined,
  };
  const committerCalls: string[][] = [];
  const committer: GraduationGitCommitter = {
    async commitAndOpenPR(_p, files) {
      committerCalls.push([...files]);
      return {
        branch: "proposal/sp-1",
        prUrl: "https://github.com/acme/repo/pull/77",
        commitSha: "f00dcafe",
      } satisfies ProposalGitCommitResult;
    },
  };

  const app = new Elysia();
  // NOTE: no createWriter override — the DEFAULT writer must thread sourcePatcher.
  mountProposalGraduateAPI(app, {
    commandLayer: PASS_COMMAND_LAYER,
    engine,
    resolveConfig: () => ({ rootDir: process.cwd() }),
    sourcePatcher: patchNamedConstant,
    createCommitter: () => committer,
  });

  const res = await app.handle(
    new Request(`${BASE}/api/proposals/${proposal.id}/graduate`, { method: "POST" }),
  );
  // Assert status BEFORE parsing the body: a non-JSON error body would otherwise
  // throw a confusing SyntaxError that masks the real status-code mismatch.
  expect(res.status).toBe(200);
  const json = (await res.json()) as { success: boolean; data?: { prUrl?: string } };
  expect(json.success).toBe(true);
  expect(json.data?.prUrl).toBe("https://github.com/acme/repo/pull/77");
  // The committer was handed the patched file as a written path.
  expect(committerCalls).toHaveLength(1);
  expect(committerCalls[0]?.some((f) => f.endsWith("threshold.ts"))).toBe(true);

  // The REAL source constant changed on disk — the whole say→code chain works.
  const patched = readFileSync(absFile, "utf8");
  expect(patched).toContain("export const MANAGER_APPROVAL_THRESHOLD = 20000;");
  expect(patched).not.toContain("10000");
  // Comments / surrounding source survive the splice.
  expect(patched).toContain("/** demo */");
});

test("default writer ignores sourcePatcher when createWriter is overridden", async () => {
  // Guard: an explicit createWriter fully controls the writer (the injected
  // sourcePatcher must not leak into a test's custom writer).
  const writerCalls: ProposalDefinition[] = [];
  const app = new Elysia();
  const proposal = {
    id: "prop-sp-2",
    status: "approved",
    changes: [{ target: "rule", operation: "create", name: "x" }],
    impact: {
      schemasAffected: [],
      actionsAffected: [],
      rulesAffected: [],
      dependentsAffected: [],
      migrationRequired: false,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as ProposalDefinition;
  mountProposalGraduateAPI(app, {
    commandLayer: PASS_COMMAND_LAYER,
    engine: { getProposal: () => proposal, commitProposal: () => undefined },
    resolveConfig: () => ({ rootDir: process.cwd() }),
    sourcePatcher: patchNamedConstant,
    createWriter: () => ({
      async writeApprovedProposal(p) {
        writerCalls.push(p);
        return ["/repo/x.rule.ts"];
      },
    }),
    createCommitter: () => ({
      async commitAndOpenPR() {
        return { branch: "b", prUrl: "https://x/pr/1", commitSha: "abc" };
      },
    }),
  });
  const res = await app.handle(
    new Request(`${BASE}/api/proposals/${proposal.id}/graduate`, { method: "POST" }),
  );
  expect(res.status).toBe(200);
  expect(writerCalls).toHaveLength(1);
});

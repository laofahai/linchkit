/**
 * Source for the two files the dry-run child process runs, emitted as string
 * constants so the runner can write them into a throwaway temp dir per call (no
 * separate shipped child entrypoints to resolve). Both are plain Bun-run TS.
 *
 * - {@link PRELOAD_SOURCE} is `bun --preload`ed FIRST: it registers a Bun plugin
 *   that aliases `@linchkit/core` to a SHIM, so the generated source's
 *   `import { defineAction } from "@linchkit/core"` resolves to a fake that just
 *   returns the definition object (capturing its `handler`) — the real core, its
 *   DB wiring, and its side-effecting providers never load in the sandbox.
 * - {@link RUNNER_SOURCE} imports the generated source (now shimmed), finds the
 *   exported definition's `handler`, runs it once against the synthetic input with
 *   a RECORDING Proxy context (every `ctx.*` call is logged as an attempted side
 *   effect and throws — the handler can perform no real I/O), and writes a single
 *   JSON outcome to the result-file path. Handler stdout/stderr stay separate and
 *   become the outcome `logs`.
 */

/** Filename the runner imports the generated source from (written by the parent). */
export const SOURCE_FILENAME = "__dryrun_source.ts";
/** Filename of the preload shim (passed to `bun --preload`). */
export const PRELOAD_FILENAME = "__dryrun_preload.ts";
/** Filename of the runner harness. */
export const RUNNER_FILENAME = "__dryrun_runner.ts";

export const PRELOAD_SOURCE = `import { plugin } from "bun";

// Alias @linchkit/core to a shim so the generated source's define*() calls resolve
// to fakes that just return their definition object. The real core never loads in
// the sandbox, so no DB/provider/secret wiring is reachable.
plugin({
  name: "linchkit-core-dryrun-shim",
  setup(build) {
    build.module("@linchkit/core", () => ({
      exports: {
        defineAction: (def) => def,
        defineRule: (def) => def,
        defineEntity: (def) => def,
      },
      loader: "object",
    }));
  },
});
`;

export const RUNNER_SOURCE = `// Untrusted-code harness. Runs the generated handler ONCE in this sandboxed child
// and writes a JSON outcome to the (randomly named) result path. argv: [2]=input JSON,
// [3]=result path, [4]=change/def name, [5]=tenant id, [6]=metadata JSON.
//
// The generated source runs in THIS process and could try to forge the verdict (write
// a fake "passed" result and exit before we run the handler). We defend by: capturing
// the write primitive + the real exit BEFORE importing it; SCRUBBING process.argv so it
// cannot learn the result path (which is also randomly named, so it cannot guess it);
// and neutralising the exit functions so it cannot terminate before we record the real
// verdict, which we then write with the captured primitive and force-exit immediately.
import { writeFileSync } from "node:fs";

// ── Snapshot intrinsics BEFORE importing untrusted code ───────────────────────
// The generated module runs top-level code in THIS realm and could mutate any global
// the harness later relies on (\`JSON.stringify\`, \`Object.values\`, \`Proxy\`, …) to forge
// a passing verdict. We snapshot everything we use up front and reference only the
// snapshots afterward; verdict-shaping work (context, def selection, serialisation) is
// done with these, never with live globals.
const jsonStringify = JSON.stringify;
const jsonParse = JSON.parse;
const objectValues = Object.values;
const objectKeys = Object.keys;
const ProxyCtor = Proxy;
const SetCtor = Set;
const DateCtor = Date;
const StringFn = String;
const bunFileText = (p) => Bun.file(p).text();

// Snapshotting the constructors/functions above is not enough: the recording path
// (\`sideEffects.push\`, \`set.has\`, \`str.split\`, …) runs AFTER importing the untrusted
// module, which could replace PROTOTYPE methods (\`Array.prototype.push\`,
// \`Set.prototype.has\`, \`String.prototype.split\`, \`Object.prototype.hasOwnProperty\`) to
// hijack the harness and forge the verdict. Uncurry each method we call on an instance
// via the captured \`Function.prototype.call\`/\`bind\` (so even mutating those cannot
// subvert us) and invoke ONLY these snapshots afterward, never instance methods.
const fnCall = Function.prototype.call;
const fnBind = Function.prototype.bind;
const uncurry = (fn) => fnBind.call(fnCall, fn);
const arrayPush = uncurry(Array.prototype.push);
const stringSlice = uncurry(String.prototype.slice);
const stringSplit = uncurry(String.prototype.split);
const stringIndexOf = uncurry(String.prototype.indexOf);
const stringTrim = uncurry(String.prototype.trim);
const setHas = uncurry(Set.prototype.has);
const hasOwnFn = uncurry(Object.prototype.hasOwnProperty);

const inputPath = process.argv[2];
const resultPath = process.argv[3];
const targetName = process.argv[4] || "";
const tenantId = process.argv[5] || "dry-run";
const metaPath = process.argv[6] || "";
const realExit = process.exit.bind(process);

// Hide the args (incl. the result path) and disable early termination before any
// untrusted module code runs.
process.argv.length = 2;
const blockExit = () => {
  throw new Error("FORBIDDEN_SIDE_EFFECT:process.exit()");
};
process.exit = blockExit;
try {
  if (typeof Bun !== "undefined") Bun.exit = blockExit;
} catch (_e) {}

const sideEffects = [];
function recordEffect(path) {
  arrayPush(sideEffects, { kind: "unknown", detail: stringSlice(StringFn(path), 0, 200) });
}

// The known ActionContext I/O surfaces. Anything else a handler reaches for is an
// arbitrary property name we must NOT echo back: untrusted code could read a host
// file and use its contents as a property name (\`ctx[secret]()\`), turning the
// recorded path into an exfiltration channel. We keep the recognised first segment
// and redact the rest.
const KNOWN_CTX_IO = new SetCtor([
  "get", "query", "create", "update", "delete", "execute", "emit", "ai", "config",
]);
function sanitizePath(path) {
  const parts = stringSplit(StringFn(path), ".");
  const method = parts[1] || "";
  if (!setHas(KNOWN_CTX_IO, method)) return "ctx.<redacted>";
  return parts.length > 2 ? "ctx." + method + ".<redacted>" : "ctx." + method;
}

// A callable Proxy for an I/O surface: any property chain is callable; CALLING it
// records a forbidden side effect and throws. Used for the parts of the context the
// handler must NOT exercise in a dry-run (DB, events, nested actions, AI, config).
function makeForbidden(path) {
  return new ProxyCtor(function () {}, {
    get(_t, prop) {
      if (typeof prop === "symbol") return undefined;
      if (prop === "then") return undefined; // not a thenable
      return makeForbidden(path + "." + StringFn(prop));
    },
    apply() {
      const safe = sanitizePath(path);
      recordEffect(safe + "()");
      throw new Error("FORBIDDEN_SIDE_EFFECT:" + safe + "()");
    },
  });
}

// A read-only ExecutionMeta shim (Spec 65) over the supplied metadata payload, so a
// handler using \`ctx.meta.get('key')\` / has / require / toJSON behaves as it would
// under the real action engine instead of falsely throwing.
function makeMeta(data) {
  const d = data && typeof data === "object" ? data : {};
  return {
    get(key) { return d[key]; },
    has(key) { return hasOwnFn(d, key); },
    require(key) {
      if (!hasOwnFn(d, key)) {
        throw new Error("ExecutionMeta missing required key: " + StringFn(key));
      }
      return d[key];
    },
    toJSON() {
      const out = {};
      for (const k in d) if (hasOwnFn(d, k)) out[k] = d[k];
      return out;
    },
  };
}

// Build a LinchKit ActionContext for the dry-run. Handlers are \`(ctx) => ...\` with
// inputs at \`ctx.input\`. Read-only context fields are REAL (so a handler reading
// them does not falsely fail); every I/O method (get/query/create/update/delete/
// execute/emit/ai/config/…) is a forbidden surface that records + throws when called.
function makeCtx(input, meta) {
  const real = {
    input: input || {},
    logger: { info() {}, warn() {}, error() {}, debug() {}, trace() {} },
    meta: makeMeta(meta),
    actor: { id: "dry-run", type: "system", groups: [], tenantId: tenantId },
    tenantId: tenantId,
    executionId: "dry-run",
    timestamp: new DateCtor(),
    hasCapability: function () { return false; },
  };
  return new ProxyCtor(real, {
    get(t, prop) {
      if (typeof prop === "symbol") return undefined;
      if (prop === "then") return undefined; // not a thenable
      if (hasOwnFn(t, prop)) return t[prop];
      return makeForbidden("ctx." + StringFn(prop));
    },
  });
}

async function readJson(path, fallback) {
  try {
    return jsonParse(await bunFileText(path));
  } catch {
    return fallback;
  }
}

// Select the definition to dry-run, using the snapshotted \`Object.values\` and manual
// loops (no \`Array.prototype\` methods untrusted code could have replaced). A single
// handler-def is the materializer's normal output; with MORE than one, never guess the
// first — require a name match, else fail closed as malformed.
function selectDef(mod) {
  const vals = objectValues(mod);
  const defs = [];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v && typeof v === "object" && typeof v.handler === "function") arrayPush(defs, v);
  }
  if (defs.length === 1) return { def: defs[0], count: 1 };
  if (defs.length > 1 && targetName) {
    for (let i = 0; i < defs.length; i++) {
      if (defs[i].name === targetName) return { def: defs[i], count: defs.length };
    }
  }
  return { def: null, count: defs.length };
}

async function main() {
  // Read the integrity nonce from stdin FIRST — before any untrusted code runs — and
  // consume it. The parent passes it on stdin (not argv/env), so it is not recoverable
  // via /proc/self/cmdline or /proc/self/environ; once read, the stream is at EOF. The
  // parent rejects any result whose nonce does not match, so a forged result file (the
  // untrusted code can still discover the path via /proc) is ignored.
  let nonce = "";
  try {
    nonce = stringTrim(await Bun.stdin.text());
  } catch (_e) {}
  // Read inputs and BUILD THE CONTEXT before importing untrusted code, so a later
  // top-level mutation of Proxy/etc cannot subvert the recording context.
  const input = inputPath ? await readJson(inputPath, {}) : {};
  const metaData = metaPath ? await readJson(metaPath, {}) : {};
  const ctx = makeCtx(input, metaData);
  let outcome;
  try {
    const mod = await import("./${SOURCE_FILENAME}");
    const sel = selectDef(mod);
    if (!sel.def) {
      outcome = {
        status: "malformed_output",
        error:
          sel.count === 0
            ? "generated source exports no define*() definition with a handler"
            : "generated source exports " +
              sel.count +
              " definitions; none named '" +
              targetName +
              "' to disambiguate which to dry-run",
        sideEffects,
      };
    } else {
      const result = await sel.def.handler(ctx);
      // A void/null return is only malformed when the definition DECLARES an output
      // contract (a non-empty \`output\` map). LinchKit handlers are \`(ctx) => Promise<unknown>\`
      // and \`output\` is optional, so a side-effect-style action with no declared output may
      // legitimately return nothing — the real action engine runs it fine, so the dry-run
      // must not stamp a false content failure. \`output\` is read with snapshotted Object.keys.
      let requiresOutput = false;
      try {
        const out = sel.def.output;
        requiresOutput = !!out && typeof out === "object" && objectKeys(out).length > 0;
      } catch (_e) {
        requiresOutput = false;
      }
      if (result !== undefined && result !== null) {
        outcome = { status: "passed", sideEffects };
      } else if (requiresOutput) {
        outcome = {
          status: "malformed_output",
          error: "handler declares an output contract but returned null/undefined",
          sideEffects,
        };
      } else {
        outcome = { status: "passed", sideEffects };
      }
    }
  } catch (e) {
    const msg = e && e.message ? StringFn(e.message) : StringFn(e);
    if (stringIndexOf(msg, "FORBIDDEN_SIDE_EFFECT:") === 0) {
      // The message here is the sanitised forbidden path (no attacker text).
      outcome = { status: "forbidden_side_effect", error: stringSlice(msg, 0, 200), sideEffects };
    } else {
      // A thrown message is attacker-controlled (\`throw new Error(secret)\`), and so is
      // a custom \`error.name\`; surface only a BUILT-IN error class name (else "Error"),
      // never raw text, so the outcome cannot become a file-read exfiltration channel.
      const builtins = new SetCtor([
        "Error", "TypeError", "RangeError", "ReferenceError",
        "SyntaxError", "EvalError", "URIError", "AggregateError",
      ]);
      const name = e && typeof e.name === "string" && setHas(builtins, e.name) ? e.name : "Error";
      outcome = {
        status: "threw",
        error: "Handler threw during dry-run (" + name + "; message withheld)",
        sideEffects,
      };
    }
  }
  // A forbidden side-effect ATTEMPT taints the verdict even if the handler swallowed the
  // thrown error and returned a value (\`try { await ctx.create(...) } catch {}\`): the
  // attempt is the signal Phase 5 must act on, so a non-empty record forces the status.
  if (sideEffects.length > 0 && outcome.status !== "forbidden_side_effect") {
    outcome = {
      status: "forbidden_side_effect",
      error: "Handler attempted a forbidden side effect during dry-run",
      sideEffects,
    };
  }

  // Stamp the integrity nonce so the parent can distinguish this real verdict from any
  // result the untrusted code may have forged. Serialise + write with SNAPSHOTTED
  // primitives (untrusted code may have replaced \`JSON.stringify\` / \`Bun.write\`), then
  // force-exit via the REAL exit so no deferred task can overwrite the verdict.
  outcome.__nonce = nonce;
  writeFileSync(resultPath, jsonStringify(outcome));
  realExit(0);
}

main().catch(() => realExit(1));
`;

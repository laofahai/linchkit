/**
 * @linchkit/cap-dry-run
 *
 * Execution dry-run runner capability — Spec 70 P3. Implements the core
 * `ExecutionDryRunProvider` seam by running AI-generated handler source in a
 * hardened, network-denied Bun subprocess and reporting a `DryRunOutcome`.
 *
 * Core stays execution-free: it declares the seam (Spec 70 P2); this capability
 * supplies the implementation. The runner FAILS CLOSED (reports `infra_error`,
 * runs nothing) on any host where no OS sandbox can deny network egress.
 *
 * Spec 70 P5 adds the escalation tier: `createDryRunner({ runner: "microvm" })`
 * runs the IDENTICAL launcher inside a gVisor kernel boundary
 * (`docker run --runtime=runsc`), and the subprocess tier gains an OS-enforced
 * memory rlimit on Linux (`prlimit --data`). A configured microvm tier with no
 * usable mechanism fails closed — it never degrades to the subprocess tier.
 */

export {
  buildMemoryLimitArgv,
  buildMicrovmArgv,
  buildSandboxArgv,
  buildSandboxExecProfile,
  defaultSandboxEnv,
  detectMemoryLimitWrapper,
  detectMicrovmStrategy,
  detectSandboxStrategy,
  isMicrovmStrategyUsable,
  isSandboxStrategyUsable,
  type MemoryLimitWrapper,
  type MicrovmStrategy,
  type SandboxEnv,
  type SandboxStrategy,
} from "./sandbox";
export {
  createDryRunner,
  createSubprocessDryRunner,
  type DryRunnerOptions,
  type DryRunnerTier,
  type DryRunSpawn,
  type SpawnedDryRunChild,
  type SubprocessDryRunnerOptions,
} from "./subprocess-dry-runner";

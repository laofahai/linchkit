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
 */

export {
  buildSandboxArgv,
  buildSandboxExecProfile,
  defaultSandboxEnv,
  detectSandboxStrategy,
  isSandboxStrategyUsable,
  type SandboxEnv,
  type SandboxStrategy,
} from "./sandbox";
export {
  createSubprocessDryRunner,
  type SubprocessDryRunnerOptions,
} from "./subprocess-dry-runner";

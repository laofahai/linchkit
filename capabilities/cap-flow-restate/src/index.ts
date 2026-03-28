/**
 * @linchkit/cap-flow-restate — Restate durable flow engine capability
 *
 * Provides Restate-backed durable workflow execution for LinchKit flows.
 * Includes: flow compiler, Restate flow engine, endpoint management, health checks.
 */

export { compileFlow } from "./flow-compiler";
export {
  checkRestateHealth,
  createRestateEndpoint,
  registerDeployment,
  type RestateEndpoint,
  setupRestateEndpoint,
} from "./restate-client";
export { createRestateFlowEngine } from "./restate-flow-engine";
export type { CompiledFlow, FlowCompiler, FlowEngineConfig, RestateConfig } from "./types";

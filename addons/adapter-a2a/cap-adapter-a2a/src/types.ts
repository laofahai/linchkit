/**
 * A2A v1.0 protocol type definitions for cap-adapter-a2a.
 *
 * Hand-authored from the A2A v1.0 specification (a2a-protocol.org/latest/).
 * Mirrors the types in @a2a-js/sdk@1.0.0 so that when the SDK reaches GA we
 * can do a drop-in replacement with a minimal migration. Pin compatibility with
 * the SDK is intentional — field names follow the A2A 1.0 JSON schema exactly.
 *
 * Ref: https://a2a-protocol.org/latest/topics/agent-cards/ (Spec 15 §6.5)
 */

// ── AgentCapabilities ────────────────────────────────────────────────────────

export interface AgentExtension {
  uri: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
  extensions?: AgentExtension[];
}

// ── AgentSkill ───────────────────────────────────────────────────────────────

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  security?: Array<Record<string, string[]>>;
}

// ── SecurityScheme ───────────────────────────────────────────────────────────

export interface APIKeySecurityScheme {
  type: "apiKey";
  in: "header" | "query" | "cookie";
  name: string;
  description?: string;
}

export interface HTTPAuthSecurityScheme {
  type: "http";
  scheme: string;
  bearerFormat?: string;
  description?: string;
}

export type SecurityScheme = APIKeySecurityScheme | HTTPAuthSecurityScheme;

// ── AgentProvider ────────────────────────────────────────────────────────────

export interface AgentProvider {
  organization: string;
  url?: string;
}

// ── AgentInterface ───────────────────────────────────────────────────────────

export interface AgentInterface {
  url: string;
  transport?: string;
}

// ── AgentCard ────────────────────────────────────────────────────────────────

export interface AgentCard {
  /** Protocol version — always "1.0" for A2A v1.0 */
  protocolVersion: string;
  /** Display name of the agent */
  name: string;
  /** Human-readable description */
  description: string;
  /** Canonical URL where this agent accepts A2A requests */
  url: string;
  /** Agent implementation version (semver) */
  version: string;
  /** Optional documentation URL */
  documentationUrl?: string;
  /** Optional icon URL */
  iconUrl?: string;
  /** Protocol-level capabilities advertised by this agent */
  capabilities: AgentCapabilities;
  /** Default MIME types accepted as task input */
  defaultInputModes: string[];
  /** Default MIME types produced as task output */
  defaultOutputModes: string[];
  /** Named skills this agent exposes */
  skills: AgentSkill[];
  /** Security schemes (keyed by scheme name) */
  securitySchemes?: Record<string, SecurityScheme>;
  /** Top-level security requirements */
  security?: Array<Record<string, string[]>>;
  /** Whether an authenticated client can fetch an extended card */
  supportsAuthenticatedExtendedCard?: boolean;
  /** Hosting organization metadata */
  provider?: AgentProvider;
  /** Additional interfaces at alternate URLs / transports */
  additionalInterfaces?: AgentInterface[];
}

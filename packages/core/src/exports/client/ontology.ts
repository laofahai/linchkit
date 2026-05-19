/**
 * Ontology — unified semantic facade types + pure describe helpers (browser-safe).
 * Runtime ontology registry factory lives in ../server/ontology.ts.
 */

export type {
  EntityDescriptor,
  OntologyRegistry,
  OntologyRegistryDeps,
  RelationDescriptor,
} from "../../ontology";
export {
  type ActionDescription,
  type AgentsMdOptions,
  buildProjectOverview,
  buildRelationGraph,
  type DescribeInput,
  describeAction,
  describeEntity,
  describeRelation,
  type EntityDescription,
  type FieldDescription,
  generateAgentsMd,
  inferSemanticRelations,
  type ProjectOverview,
  type RelationDescription,
} from "../../ontology";

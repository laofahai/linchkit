/**
 * Ontology module — unified semantic layer over all registries
 */

export { generateAgentsMd, type AgentsMdOptions } from "./agents-md-generator";
export {
  buildProjectOverview,
  describeAction,
  describeEntity,
  describeRelation,
  type ActionDescription,
  type DescribeInput,
  type EntityDescription,
  type FieldDescription,
  type ProjectOverview,
  type RelationDescription,
} from "./describe";
export {
  analyzeImpact,
  type ImpactAnalysisOptions,
  type ImpactAnalysisResult,
  type ImpactNode,
} from "./impact-analysis";
export { generateSemanticMermaid, type MermaidExportOptions } from "./mermaid-export";
export {
  createOntologyRegistry,
  type EntityDescriptor,
  type OntologyRegistry,
  type OntologyRegistryDeps,
  type RelationDescriptor,
} from "./ontology-registry";
export { buildRelationGraph, inferSemanticRelations } from "./semantic-inference";

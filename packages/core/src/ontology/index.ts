/**
 * Ontology module — unified semantic layer over all registries
 */

export { type AgentsMdOptions, generateAgentsMd } from "./agents-md-generator";
export {
  type ActionDescription,
  buildProjectOverview,
  type DescribeInput,
  describeAction,
  describeEntity,
  describeRelation,
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
  bfsForward,
  bfsReverse,
  type DagExtractionInput,
  extractDependencyEdges,
  inferActionSemantics,
  inferEntitySemantics,
  inferFlowSemantics,
  inferGenericSemantics,
  inferRuleSemantics,
} from "./meta-semantics-inference";
export {
  createOntologyRegistry,
  type EntityDescriptor,
  type OntologyRegistry,
  type OntologyRegistryDeps,
  type RelationDescriptor,
} from "./ontology-registry";
export { buildRelationGraph, inferSemanticRelations } from "./semantic-inference";

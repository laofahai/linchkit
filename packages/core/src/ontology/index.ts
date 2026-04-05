/**
 * Ontology module — unified semantic layer over all registries
 */

export {
  createOntologyRegistry,
  type EntityDescriptor,
  type OntologyRegistry,
  type OntologyRegistryDeps,
  type RelationDescriptor,
} from "./ontology-registry";
export { buildRelationGraph, inferSemanticRelations } from "./semantic-inference";
export {
  analyzeImpact,
  type ImpactAnalysisOptions,
  type ImpactAnalysisResult,
  type ImpactNode,
} from "./impact-analysis";
export { generateSemanticMermaid, type MermaidExportOptions } from "./mermaid-export";

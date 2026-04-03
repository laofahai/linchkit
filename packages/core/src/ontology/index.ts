/**
 * Ontology module — unified semantic layer over all registries
 */

export {
  createOntologyRegistry,
  type OntologyRegistry,
  type OntologyRegistryDeps,
  type RelationDescriptor,
  type EntityDescriptor,
} from "./ontology-registry";
export { buildRelationGraph, inferSemanticRelations } from "./semantic-inference";

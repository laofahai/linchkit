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

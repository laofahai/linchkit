/**
 * Documentation generation module
 *
 * Generates API documentation, Markdown, OpenAPI specs, capability specs,
 * and provides documentation search from the ontology.
 */

export {
  type ActionDoc,
  type ApiDocGeneratorOptions,
  actionToDoc,
  type FieldDoc,
  fieldToDoc,
  generateApiDoc,
  type SchemaDoc,
  type SystemDoc,
  schemaToDoc,
} from "./api-doc-generator";

export {
  type CapabilityActionDoc,
  type CapabilityRelationDoc,
  type CapabilityRuleDoc,
  type CapabilitySchemaDoc,
  type CapabilitySpecDoc,
  type CapabilityStateMachineDoc,
  type CapabilityViewDoc,
  generateCapabilityDoc,
  renderCapabilityDoc,
} from "./capability-doc-generator";

export {
  createDocSearchIndex,
  DocSearchIndex,
  type DocSearchOptions,
  type DocSearchResult,
} from "./doc-search";

export {
  type MarkdownRenderOptions,
  renderActionDoc,
  renderSchemaDoc,
  renderSystemDoc,
} from "./markdown-renderer";

export {
  generateOpenAPISpec,
  type OpenAPIGeneratorOptions,
  type OpenAPIOperation,
  type OpenAPIPathItem,
  type OpenAPISchemaObject,
  type OpenAPISpec,
} from "./openapi-generator";

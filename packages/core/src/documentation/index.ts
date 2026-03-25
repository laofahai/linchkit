/**
 * Documentation generation module
 *
 * Generates API documentation, Markdown, and OpenAPI specs from the ontology.
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

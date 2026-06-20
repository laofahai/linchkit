/**
 * View layout helpers — syntactic sugar over FormLayoutNode JSON shape.
 * Browser-safe.
 */

export {
  applyViewExtensions,
  type ViewExtensionInput,
} from "../../view/apply-view-extensions";
export { type FormLayoutBuilder, formLayout } from "../../view/form-layout-builder";
export {
  type FieldOptions,
  field,
  group,
  notebook,
  page,
  row,
  separator,
} from "../../view/layout-helpers";

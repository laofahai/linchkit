/**
 * Documentation governance utilities (spec 37)
 *
 * Provides documentation validation, spec tracking, and changelog generation.
 */

export {
  type ChangelogOptions,
  type ConventionalCommit,
  generateChangelog,
  generateVersionedChangelog,
  parseConventionalCommit,
  type VersionGroup,
} from "./changelog-generator";
export {
  type DocCompleteness,
  type DocIssue,
  validateActionDoc,
  validateCapabilityDoc,
  validateEntityDoc,
  /** @deprecated Use validateEntityDoc instead */
  validateSchemaDoc,
} from "./doc-validator";

export {
  generateSpecReport,
  type SpecProgressReport,
  type SpecStatus,
  type SpecStatusValue,
  SpecTracker,
} from "./spec-tracker";

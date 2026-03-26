/**
 * System schema for proposals (change governance).
 *
 * Read-only — backed by ProposalEngine storage.
 */

import { defineSchema, defineView } from "../define";

export const proposalSchema = defineSchema({
  name: "_proposal",
  label: "Proposal",
  fields: {
    title: { type: "string", required: true, label: "Title" },
    description: { type: "text", label: "Description" },
    capability: { type: "string", label: "Capability" },
    author_name: { type: "string", label: "Author" },
    author_type: {
      type: "enum",
      options: [
        { value: "human", label: "Human" },
        { value: "ai", label: "AI" },
      ],
      label: "Author Type",
    },
    change_type: {
      type: "enum",
      options: [
        { value: "patch", label: "Patch" },
        { value: "minor", label: "Minor" },
        { value: "major", label: "Major" },
      ],
      label: "Change Type",
    },
    status: {
      type: "enum",
      options: [
        { value: "draft", label: "Draft" },
        { value: "validating", label: "Validating" },
        { value: "validated", label: "Validated" },
        { value: "approved", label: "Approved" },
        { value: "rejected", label: "Rejected" },
        { value: "committed", label: "Committed" },
        { value: "deployed", label: "Deployed" },
      ],
      label: "Status",
    },
    changes_count: { type: "number", label: "Changes" },
    migration_required: { type: "boolean", label: "Migration Required" },
  },
  presentation: {
    titleField: "title",
    subtitleField: "capability",
    badgeField: "status",
    summaryFields: ["title", "status", "change_type", "author_name"],
    icon: "file-edit",
  },
  exposure: { graphql: false, mcp: false },
});

export const proposalListView = defineView({
  name: "_proposal_list",
  schema: "_proposal",
  type: "list",
  label: "Proposals",
  fields: [
    { field: "title", sortable: true },
    { field: "capability", filterable: true },
    { field: "author_name", label: "Author" },
    { field: "author_type", width: 100 },
    { field: "change_type", sortable: true, filterable: true, width: 120 },
    { field: "status", sortable: true, filterable: true, width: 130 },
    { field: "changes_count", label: "Changes", width: 90 },
  ],
  defaultSort: { field: "title", order: "asc" },
  pageSize: 25,
});

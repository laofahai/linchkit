/**
 * linch validate — Validate all registered schemas, interfaces, links, and automations
 *
 * Loads linchkit.config.ts, registers all definitions from capabilities,
 * and runs comprehensive validation checks. Reports errors and warnings
 * in a formatted table. Exits non-zero if any errors are found.
 */

import type {
  ActionDefinition,
  AutomationDefinition,
  CapabilityDefinition,
  InterfaceDefinition,
  LinchKitConfig,
  LinkDefinition,
  SchemaDefinition,
} from "@linchkit/core";
import { createInterfaceRegistry, validateTranslatableSchema } from "@linchkit/core";
import type { ActionInfo, QualityIssue, SchemaInfo } from "@linchkit/devtools/methodology";
import { checkActionDefinitions, checkSchemaDefinitions } from "@linchkit/devtools/methodology";
import {
  convertSchemaRelationshipFieldsToImplicitLinks,
  createLinkRegistry,
  SchemaRegistry,
} from "@linchkit/core/server";
import { defineCommand } from "citty";
import consola from "consola";
import { loadConfig } from "../utils/load-config";

// ── Types ────────────────────────────────────────────────────

interface ValidationCategory {
  name: string;
  issues: QualityIssue[];
}

// ── Validate command ─────────────────────────────────────────

export const validateCommand = defineCommand({
  meta: {
    name: "validate",
    description: "Validate all registered schemas, interfaces, links, and automations",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output as JSON (for CI/CD)",
      default: false,
    },
  },
  async run({ args }) {
    const outputJson = args.json as boolean;

    // ── Load config ──
    let config: LinchKitConfig;
    try {
      const result = await loadConfig();
      config = result.config;
      if (!outputJson) {
        consola.info(`Config loaded from ${result.configPath}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Config file not found")) {
        consola.error("No linchkit.config.ts found. Are you in a LinchKit project directory?");
        consola.info("Run 'linch init' to create a new project.");
      } else {
        consola.error(`Failed to load config: ${msg}`);
      }
      process.exit(1);
    }

    const capabilities = (config.capabilities ?? []) as CapabilityDefinition[];

    // ── Collect all definitions from capabilities ──
    const schemas: SchemaDefinition[] = [];
    const actions: ActionDefinition[] = [];
    const interfaces: InterfaceDefinition[] = [];
    const links: LinkDefinition[] = [];
    const automations: AutomationDefinition[] = [];

    for (const cap of capabilities) {
      if (cap.schemas) schemas.push(...cap.schemas);
      if (cap.actions) actions.push(...cap.actions);
      if (cap.interfaces) interfaces.push(...cap.interfaces);
      if (cap.links) links.push(...cap.links);
      if (cap.automations) automations.push(...cap.automations);
    }

    if (!outputJson) {
      consola.info(
        `Found ${schemas.length} schema(s), ${actions.length} action(s), ${interfaces.length} interface(s), ${links.length} link(s), ${automations.length} automation(s)`,
      );
    }

    const categories: ValidationCategory[] = [];

    // ── 1. Schema inheritance validation ──
    {
      const issues: QualityIssue[] = [];
      const schemaRegistry = new SchemaRegistry();

      // Register schemas in order, catching errors
      for (const schema of schemas) {
        try {
          schemaRegistry.register(schema);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          issues.push({
            severity: "error",
            rule: "schema-registration",
            message: msg,
          });
        }
      }

      // Run bulk inheritance validation on successfully registered schemas
      const inheritanceErrors = schemaRegistry.validateInheritance();
      for (const errMsg of inheritanceErrors) {
        issues.push({
          severity: "error",
          rule: "schema-inheritance",
          message: errMsg,
        });
      }

      categories.push({ name: "Schema Inheritance", issues });
    }

    // ── 2. Interface implementation validation ──
    {
      const issues: QualityIssue[] = [];
      const interfaceRegistry = createInterfaceRegistry();

      // Register interfaces
      for (const iface of interfaces) {
        try {
          interfaceRegistry.register(iface);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          issues.push({
            severity: "error",
            rule: "interface-registration",
            message: msg,
          });
        }
      }

      // Validate each schema's interface implementation
      for (const schema of schemas) {
        if (!schema.implements || schema.implements.length === 0) continue;

        const implErrors = interfaceRegistry.validateImplementation(schema);
        for (const errMsg of implErrors) {
          issues.push({
            severity: "error",
            rule: "interface-implementation",
            message: errMsg,
          });
        }
      }

      categories.push({ name: "Interface Implementation", issues });
    }

    // ── 3. Translatable field validation ──
    {
      const issues: QualityIssue[] = [];

      for (const schema of schemas) {
        const transErrors = validateTranslatableSchema(schema);
        for (const errMsg of transErrors) {
          issues.push({
            severity: "error",
            rule: "translatable-field",
            message: `Schema "${schema.name}": ${errMsg}`,
          });
        }
      }

      categories.push({ name: "Translatable Fields", issues });
    }

    // ── 4. Implicit link validation (ref/has_many/many_to_many fields) ──
    {
      const issues: QualityIssue[] = [];
      const { implicitLinks, conflicts, missingTargets } =
        convertSchemaRelationshipFieldsToImplicitLinks(schemas, links);

      // Report missing targets as errors
      for (const mt of missingTargets) {
        issues.push({
          severity: "error",
          rule: "field-ref-target",
          message: `Schema "${mt.schemaName}" field "${mt.fieldName}": target schema "${mt.target}" does not exist`,
        });
      }

      // Report conflicts as warnings (explicit link wins)
      for (const conflict of conflicts) {
        issues.push({
          severity: "warning",
          rule: "link-implicit-conflict",
          message: `Implicit link "${conflict.name}" from schema field conflicts with explicit defineLink — explicit link wins`,
        });
      }

      // Merge implicit links into the links array for subsequent validation
      links.push(...implicitLinks);

      categories.push({ name: "Implicit Links", issues });
    }

    // ── 5. Link target existence validation ──
    {
      const issues: QualityIssue[] = [];
      const schemaNames = new Set(schemas.map((s) => s.name));
      const linkRegistry = createLinkRegistry();

      for (const link of links) {
        // Check that both from and to schemas exist
        if (!schemaNames.has(link.from)) {
          issues.push({
            severity: "error",
            rule: "link-target",
            message: `Link "${link.name}": source schema "${link.from}" does not exist`,
          });
        }
        if (!schemaNames.has(link.to)) {
          issues.push({
            severity: "error",
            rule: "link-target",
            message: `Link "${link.name}": target schema "${link.to}" does not exist`,
          });
        }

        // Check for duplicate link registration
        try {
          linkRegistry.register(link);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          issues.push({
            severity: "error",
            rule: "link-registration",
            message: msg,
          });
        }

        // Warn if many_to_many has no properties defined
        if (link.cardinality === "many_to_many" && !link.properties) {
          issues.push({
            severity: "info",
            rule: "link-m2m-properties",
            message: `Link "${link.name}" (many_to_many) has no junction table properties defined`,
          });
        }
      }

      categories.push({ name: "Link Targets", issues });
    }

    // ── 6. Schema naming conventions ──
    {
      const schemaInfos: SchemaInfo[] = schemas.map((s) => ({
        name: s.name,
        fields: Object.entries(s.fields).map(([name, field]) => ({
          name,
          type: field.type,
        })),
      }));
      const report = checkSchemaDefinitions(schemaInfos);
      categories.push({ name: "Schema Naming Conventions", issues: report.issues });
    }

    // ── 7. Action naming conventions ──
    {
      const actionInfos: ActionInfo[] = actions.map((a) => ({
        name: a.name,
        schema: a.schema,
      }));
      const report = checkActionDefinitions(actionInfos);
      categories.push({ name: "Action Naming Conventions", issues: report.issues });
    }

    // ── 8. Automation validation ──
    {
      const issues: QualityIssue[] = [];
      const schemaNames = new Set(schemas.map((s) => s.name));
      const actionNames = new Set(actions.map((a) => a.name));

      for (const automation of automations) {
        // Check trigger schema references (fieldChange and stateChange triggers)
        const trigger = automation.trigger;
        if (
          (trigger.type === "fieldChange" || trigger.type === "stateChange") &&
          "schema" in trigger &&
          !schemaNames.has(trigger.schema)
        ) {
          issues.push({
            severity: "error",
            rule: "automation-trigger",
            message: `Automation "${automation.name}": trigger references unknown schema "${trigger.schema}"`,
          });
        }

        // Check that action references in steps are valid
        for (const automationAction of automation.actions) {
          if (automationAction.type === "execute_action") {
            if (!actionNames.has(automationAction.action)) {
              issues.push({
                severity: "warning",
                rule: "automation-action-ref",
                message: `Automation "${automation.name}": references unknown action "${automationAction.action}"`,
              });
            }
          }
        }
      }

      categories.push({ name: "Automations", issues });
    }

    // ── Aggregate results ──
    const allIssues = categories.flatMap((c) => c.issues);
    const totalErrors = allIssues.filter((i) => i.severity === "error").length;
    const totalWarnings = allIssues.filter((i) => i.severity === "warning").length;
    const totalInfos = allIssues.filter((i) => i.severity === "info").length;

    // ── Output ──
    if (outputJson) {
      console.log(
        JSON.stringify(
          {
            passed: totalErrors === 0,
            summary: {
              errors: totalErrors,
              warnings: totalWarnings,
              infos: totalInfos,
            },
            categories: categories.map((c) => ({
              name: c.name,
              passed: c.issues.filter((i) => i.severity === "error").length === 0,
              issues: c.issues,
            })),
          },
          null,
          2,
        ),
      );
    } else {
      // Print per-category summaries
      console.log("");
      for (const cat of categories) {
        const errors = cat.issues.filter((i) => i.severity === "error").length;
        const warnings = cat.issues.filter((i) => i.severity === "warning").length;
        const infos = cat.issues.filter((i) => i.severity === "info").length;
        const icon = errors === 0 ? "\u2713" : "\u2717";
        console.log(`  ${icon} ${cat.name}: ${errors} errors, ${warnings} warnings, ${infos} info`);
      }

      // Print issues table
      if (allIssues.length > 0) {
        console.log("");
        printIssuesTable(allIssues);
      }

      // Final summary
      console.log("");
      if (totalErrors === 0) {
        consola.success(`Validation passed. ${totalWarnings} warning(s), ${totalInfos} info(s).`);
      } else {
        consola.error(
          `Validation failed: ${totalErrors} error(s), ${totalWarnings} warning(s), ${totalInfos} info(s).`,
        );
      }
    }

    if (totalErrors > 0) {
      process.exit(1);
    }
  },
});

// ── Helpers ──────────────────────────────────────────────────

/**
 * Print issues as a formatted table with ANSI colors.
 */
function printIssuesTable(issues: QualityIssue[]): void {
  const SEVERITY_COLORS: Record<string, string> = {
    error: "\x1b[31m",
    warning: "\x1b[33m",
    info: "\x1b[36m",
  };
  const RESET = "\x1b[0m";

  const sevWidth = 8;
  const ruleWidth = Math.min(Math.max(...issues.map((i) => i.rule.length), 4), 30);

  const header = `  ${"Severity".padEnd(sevWidth)}  ${"Rule".padEnd(ruleWidth)}  Message`;
  const separator = `  ${"\u2500".repeat(sevWidth)}  ${"\u2500".repeat(ruleWidth)}  ${"\u2500".repeat(50)}`;

  console.log(header);
  console.log(separator);

  for (const issue of issues) {
    const color = SEVERITY_COLORS[issue.severity] ?? "";
    const sev = `${color}${issue.severity.padEnd(sevWidth)}${RESET}`;
    const rule = issue.rule.padEnd(ruleWidth);
    const loc = issue.file ? ` [${issue.file}${issue.line ? `:${issue.line}` : ""}]` : "";
    console.log(`  ${sev}  ${rule}  ${issue.message}${loc}`);
  }
}

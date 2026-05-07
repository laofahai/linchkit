/**
 * linch validate — Validate all registered schemas, interfaces, links, and automations
 *
 * Loads linchkit.config.ts, registers all definitions from capabilities,
 * and runs comprehensive validation checks. Reports errors and warnings
 * in a formatted table. Exits non-zero if any errors are found.
 */

import type {
  ActionDefinition,
  CapabilityDefinition,
  EntityDefinition,
  InterfaceDefinition,
  LinchKitConfig,
  RelationDefinition,
} from "@linchkit/core";
import { createInterfaceRegistry, validateTranslatableEntity } from "@linchkit/core";
import { createRelationRegistry, EntityRegistry } from "@linchkit/core/server";
import type { ActionInfo, EntityInfo, QualityIssue } from "@linchkit/devtools/methodology";
import { checkActionDefinitions, checkEntityDefinitions } from "@linchkit/devtools/methodology";
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
    const entities: EntityDefinition[] = [];
    const actions: ActionDefinition[] = [];
    const interfaces: InterfaceDefinition[] = [];
    const links: RelationDefinition[] = [];

    for (const cap of capabilities) {
      if (cap.entities) entities.push(...cap.entities);
      if (cap.actions) actions.push(...cap.actions);
      if (cap.interfaces) interfaces.push(...cap.interfaces);
      if (cap.relations) links.push(...cap.relations);
    }

    if (!outputJson) {
      consola.info(
        `Found ${entities.length} entity(ies), ${actions.length} action(s), ${interfaces.length} interface(s), ${links.length} link(s)`,
      );
    }

    const categories: ValidationCategory[] = [];

    // Lookup map used by interface validation to mirror EntityRegistry.register()
    // by passing inherited+own fields into validateImplementation. Without this,
    // CLI validation disagreed with runtime behavior for inheritance+interface cases.
    const entityByName = new Map<string, EntityDefinition>();
    for (const entity of entities) entityByName.set(entity.name, entity);

    const collectResolvedFields = (entity: EntityDefinition) => {
      if (!entity.extends) return undefined;
      const chain: EntityDefinition[] = [];
      let cursor: string | undefined = entity.extends;
      while (cursor) {
        const parent = entityByName.get(cursor);
        if (!parent) break;
        chain.unshift(parent);
        cursor = parent.extends;
      }
      const fields: Record<string, EntityDefinition["fields"][string]> = {};
      for (const ancestor of chain) Object.assign(fields, ancestor.fields);
      Object.assign(fields, entity.fields);
      return fields;
    };

    // ── 1. Schema inheritance validation ──
    {
      const issues: QualityIssue[] = [];
      const entityRegistry = new EntityRegistry();

      // Register entities in order, catching errors
      for (const entity of entities) {
        try {
          entityRegistry.register(entity);
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
      const inheritanceErrors = entityRegistry.validateInheritance();
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

      // Validate each entity's interface implementation against inherited+own fields,
      // mirroring EntityRegistry.register() so CLI agrees with runtime.
      for (const entity of entities) {
        if (!entity.implements || entity.implements.length === 0) continue;

        const resolvedFields = collectResolvedFields(entity);
        const implErrors = interfaceRegistry.validateImplementation(entity, resolvedFields);
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

      for (const entity of entities) {
        const transErrors = validateTranslatableEntity(entity);
        for (const errMsg of transErrors) {
          issues.push({
            severity: "error",
            rule: "translatable-field",
            message: `Entity "${entity.name}": ${errMsg}`,
          });
        }
      }

      categories.push({ name: "Translatable Fields", issues });
    }

    // ── 4. Link target existence validation ──
    {
      const issues: QualityIssue[] = [];
      const entityNames = new Set(entities.map((s) => s.name));
      const relationRegistry = createRelationRegistry();

      for (const link of links) {
        // Check that both from and to schemas exist
        if (!entityNames.has(link.from)) {
          issues.push({
            severity: "error",
            rule: "link-target",
            message: `Link "${link.name}": source entity "${link.from}" does not exist`,
          });
        }
        if (!entityNames.has(link.to)) {
          issues.push({
            severity: "error",
            rule: "link-target",
            message: `Link "${link.name}": target entity "${link.to}" does not exist`,
          });
        }

        // Check for duplicate link registration
        try {
          relationRegistry.register(link);
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

    // ── 5. Schema naming conventions ──
    {
      const schemaInfos: EntityInfo[] = entities.map((s) => ({
        name: s.name,
        fields: Object.entries(s.fields).map(([name, field]) => ({
          name,
          type: field.type,
        })),
      }));
      const report = checkEntityDefinitions(schemaInfos);
      categories.push({ name: "Schema Naming Conventions", issues: report.issues });
    }

    // ── 6. Action naming conventions ──
    {
      const actionInfos: ActionInfo[] = actions.map((a) => ({
        name: a.name,
        entity: a.entity,
      }));
      const report = checkActionDefinitions(actionInfos);
      categories.push({ name: "Action Naming Conventions", issues: report.issues });
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

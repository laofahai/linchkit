import type { OntologyRegistry } from "../ontology/ontology-registry";
import type {
  AttentionBudget,
  AwarenessEngine,
  SensorSignal,
  StructuralIssue,
  UsageImportanceGraph,
} from "../types/life-system";
import { createAttentionBudget } from "./attention-budget";
import { createUsageImportanceGraph } from "./usage-graph";

export interface AwarenessEngineOptions {
  ontology: OntologyRegistry;
  usageGraph?: UsageImportanceGraph;
  attentionBudget?: AttentionBudget;
}

export function createAwarenessEngine(opts: AwarenessEngineOptions): AwarenessEngine {
  const usageGraph = opts.usageGraph ?? createUsageImportanceGraph();
  const attentionBudget = opts.attentionBudget ?? createAttentionBudget(undefined, usageGraph);

  return {
    get usageGraph() {
      return usageGraph;
    },
    get attentionBudget() {
      return attentionBudget;
    },

    ingestSignal(signal: SensorSignal): void {
      const schema = signal.context?.schema as string | undefined;
      if (schema) {
        usageGraph.recordUsage("schema", schema);
      }
      usageGraph.recordUsage("schema", signal.sensor);
    },

    structuralCheck(): StructuralIssue[] {
      const issues: StructuralIssue[] = [];
      const schemas = opts.ontology.listEntities();

      for (const schemaName of schemas) {
        const descriptor = opts.ontology.describe(schemaName);
        if (!descriptor) continue;

        // Check: schema has no views
        if (!descriptor.views || descriptor.views.length === 0) {
          issues.push({
            kind: "schema_no_view",
            schema: schemaName,
            message: `Schema "${schemaName}" has no views defined`,
          });
        }

        // Check: actions with zero usage
        for (const action of descriptor.actions ?? []) {
          const usage = usageGraph.getImportance("action", schemaName, action.name);
          if (usage === 0) {
            issues.push({
              kind: "action_never_called",
              schema: schemaName,
              target: action.name,
              message: `Action "${action.name}" on schema "${schemaName}" has never been called`,
            });
          }
        }
      }

      return issues;
    },
  };
}

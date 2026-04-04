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
      const entity = signal.context?.entity as string | undefined;
      if (entity) {
        usageGraph.recordUsage("entity", entity);
      }
      usageGraph.recordUsage("entity", signal.sensor);
    },

    structuralCheck(): StructuralIssue[] {
      const issues: StructuralIssue[] = [];
      const entityNames = opts.ontology.listEntities();

      for (const entityName of entityNames) {
        const descriptor = opts.ontology.describe(entityName);
        if (!descriptor) continue;

        // Check: entity has no views
        if (!descriptor.views || descriptor.views.length === 0) {
          issues.push({
            kind: "schema_no_view",
            entity: entityName,
            message: `Entity "${entityName}" has no views defined`,
          });
        }

        // Check: actions with zero usage
        for (const action of descriptor.actions ?? []) {
          const usage = usageGraph.getImportance("action", entityName, action.name);
          if (usage === 0) {
            issues.push({
            kind: "action_never_called",
            entity: entityName,
            target: action.name,
            message: `Action "${action.name}" on entity "${entityName}" has never been called`,
            });
          }
        }
      }

      return issues;
    },
  };
}

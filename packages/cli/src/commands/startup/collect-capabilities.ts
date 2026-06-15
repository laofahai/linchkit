/**
 * Collect all definitions from capabilities into flat arrays
 * for registry construction and transport startup.
 */

import type {
  ActionDefinition,
  CapabilityDefinition,
  CliCommand,
  EntityDefinition,
  EventHandlerDefinition,
  GraphQLExtensionRegistration,
  InterceptorRegistration,
  InterfaceDefinition,
  MiddlewareRegistration,
  RelationDefinition,
  RuleDefinition,
  Sensor,
  StateDefinition,
  TransportAdapterDefinition,
  ViewDefinition,
  ViewExtensionInput,
} from "@linchkit/core";
import { applyViewExtensions, registerTranslations } from "@linchkit/core";

export interface CollectedDefinitions {
  interfaces: InterfaceDefinition[];
  entities: EntityDefinition[];
  actions: ActionDefinition[];
  views: ViewDefinition[];
  states: StateDefinition[];
  links: RelationDefinition[];
  rules: RuleDefinition[];
  eventHandlers: EventHandlerDefinition[];
  middlewares: MiddlewareRegistration[];
  /** Interceptors collected from `cap.extensions.interceptors` (Spec 63 Phase 3). */
  interceptors: InterceptorRegistration[];
  transports: TransportAdapterDefinition[];
  graphqlExtensions: GraphQLExtensionRegistration[];
  commands: CliCommand[];
  /** Sensors collected from `cap.extensions.sensors` for the Sense layer (Spec 55 §3.3). */
  sensors: Sensor[];
}

/**
 * Iterate over all capabilities and collect their definitions into
 * categorized arrays. Middlewares are normalized into MiddlewareRegistration
 * with generated names when not explicitly provided.
 */
export function collectCapabilityDefinitions(
  capabilities: CapabilityDefinition[],
): CollectedDefinitions {
  const interfaces: InterfaceDefinition[] = [];
  const entities: EntityDefinition[] = [];
  const actions: ActionDefinition[] = [];
  const views: ViewDefinition[] = [];
  const states: StateDefinition[] = [];
  const links: RelationDefinition[] = [];
  const rules: RuleDefinition[] = [];
  const eventHandlers: EventHandlerDefinition[] = [];
  const middlewares: MiddlewareRegistration[] = [];
  const interceptors: InterceptorRegistration[] = [];
  const transports: TransportAdapterDefinition[] = [];
  const graphqlExtensions: GraphQLExtensionRegistration[] = [];
  const commands: CliCommand[] = [];
  const sensors: Sensor[] = [];
  // View extensions (`cap.extensions.views`, the Odoo view-inheritance model).
  // Views surface to the UI in this path via the OntologyRegistry and the
  // TransportContext (`transportCtx.views`), so collect extensions here and fold
  // them into `views` after the loop.
  const viewExtensions: ViewExtensionInput[] = [];

  for (const cap of capabilities) {
    if (cap.interfaces) interfaces.push(...cap.interfaces);
    if (cap.entities) entities.push(...cap.entities);
    if (cap.actions) actions.push(...cap.actions);
    if (cap.views) views.push(...cap.views);
    if (cap.states) states.push(...cap.states);
    if (cap.relations) links.push(...cap.relations);
    if (cap.rules) rules.push(...cap.rules);
    if (cap.eventHandlers) eventHandlers.push(...cap.eventHandlers);
    if (cap.extensions?.middlewares) {
      for (const [i, mw] of cap.extensions.middlewares.entries()) {
        middlewares.push({
          name: (mw as MiddlewareRegistration).name ?? `${cap.name}_${mw.slot}_${String(i)}`,
          slot: mw.slot,
          handler: mw.handler,
          order: mw.priority ?? (mw as MiddlewareRegistration).order,
        });
      }
    }
    if (cap.extensions?.interceptors) {
      for (const reg of cap.extensions.interceptors) {
        // Default the owning capability name when a registration omits it,
        // so fail-closed diagnostics always identify the source capability.
        interceptors.push({ ...reg, capability: reg.capability || cap.name });
      }
    }
    if (cap.extensions?.views) viewExtensions.push(...cap.extensions.views);
    if (cap.extensions?.transports) transports.push(...cap.extensions.transports);
    if (cap.extensions?.graphqlExtensions) {
      graphqlExtensions.push(cap.extensions.graphqlExtensions);
    }
    if (cap.extensions?.commands) commands.push(...cap.extensions.commands);
    if (cap.extensions?.sensors) sensors.push(...cap.extensions.sensors);

    // Register i18n translation resources from the capability
    if (cap.extensions?.i18n) {
      for (const [locale, resources] of Object.entries(cap.extensions.i18n)) {
        registerTranslations(cap.name, locale, resources as Record<string, unknown>);
      }
    }
  }

  // Fold view extensions into the collected views so the OntologyRegistry and
  // transport context surface the patched views to the UI. `applyViewExtensions`
  // is pure and throws if an extension targets a view that is not present.
  // NOTE: entity extensions are folded separately inside `buildRegistries`
  // (so the EntityRegistry sees them); they are intentionally NOT merged here.
  const mergedViews = applyViewExtensions(views, viewExtensions);

  return {
    interfaces,
    entities,
    actions,
    views: mergedViews,
    states,
    links,
    rules,
    eventHandlers,
    middlewares,
    interceptors,
    transports,
    graphqlExtensions,
    commands,
    sensors,
  };
}

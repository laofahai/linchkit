/**
 * Collect all definitions from capabilities into flat arrays
 * for registry construction and transport startup.
 */

import type {
  ActionDefinition,
  AutomationDefinition,
  CapabilityDefinition,
  EventHandlerDefinition,
  GraphQLExtensionRegistration,
  InterfaceDefinition,
  LinkDefinition,
  MiddlewareRegistration,
  RuleDefinition,
  SchemaDefinition,
  StateDefinition,
  TransportAdapterDefinition,
  ViewDefinition,
} from "@linchkit/core";

export interface CollectedDefinitions {
  interfaces: InterfaceDefinition[];
  schemas: SchemaDefinition[];
  actions: ActionDefinition[];
  views: ViewDefinition[];
  states: StateDefinition[];
  links: LinkDefinition[];
  rules: RuleDefinition[];
  eventHandlers: EventHandlerDefinition[];
  automations: AutomationDefinition[];
  middlewares: MiddlewareRegistration[];
  transports: TransportAdapterDefinition[];
  graphqlExtensions: GraphQLExtensionRegistration[];
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
  const schemas: SchemaDefinition[] = [];
  const actions: ActionDefinition[] = [];
  const views: ViewDefinition[] = [];
  const states: StateDefinition[] = [];
  const links: LinkDefinition[] = [];
  const rules: RuleDefinition[] = [];
  const eventHandlers: EventHandlerDefinition[] = [];
  const automations: AutomationDefinition[] = [];
  const middlewares: MiddlewareRegistration[] = [];
  const transports: TransportAdapterDefinition[] = [];
  const graphqlExtensions: GraphQLExtensionRegistration[] = [];

  for (const cap of capabilities) {
    if (cap.interfaces) interfaces.push(...cap.interfaces);
    if (cap.schemas) schemas.push(...cap.schemas);
    if (cap.actions) actions.push(...cap.actions);
    if (cap.views) views.push(...cap.views);
    if (cap.states) states.push(...cap.states);
    if (cap.links) links.push(...cap.links);
    if (cap.rules) rules.push(...cap.rules);
    if (cap.eventHandlers) eventHandlers.push(...cap.eventHandlers);
    if (cap.automations) automations.push(...cap.automations);
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
    if (cap.extensions?.transports) transports.push(...cap.extensions.transports);
    if (cap.extensions?.graphqlExtensions) {
      graphqlExtensions.push(cap.extensions.graphqlExtensions);
    }
  }

  return {
    interfaces,
    schemas,
    actions,
    views,
    states,
    links,
    rules,
    eventHandlers,
    automations,
    middlewares,
    transports,
    graphqlExtensions,
  };
}

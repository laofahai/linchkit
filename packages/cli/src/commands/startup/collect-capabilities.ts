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
  InterfaceDefinition,
  MiddlewareRegistration,
  RelationDefinition,
  RuleDefinition,
  StateDefinition,
  TransportAdapterDefinition,
  ViewDefinition,
} from "@linchkit/core";
import { registerTranslations } from "@linchkit/core";

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
  transports: TransportAdapterDefinition[];
  graphqlExtensions: GraphQLExtensionRegistration[];
  commands: CliCommand[];
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
  const transports: TransportAdapterDefinition[] = [];
  const graphqlExtensions: GraphQLExtensionRegistration[] = [];
  const commands: CliCommand[] = [];

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
    if (cap.extensions?.transports) transports.push(...cap.extensions.transports);
    if (cap.extensions?.graphqlExtensions) {
      graphqlExtensions.push(cap.extensions.graphqlExtensions);
    }
    if (cap.extensions?.commands) commands.push(...cap.extensions.commands);

    // Register i18n translation resources from the capability
    if (cap.extensions?.i18n) {
      for (const [locale, resources] of Object.entries(cap.extensions.i18n)) {
        registerTranslations(cap.name, locale, resources as Record<string, unknown>);
      }
    }
  }

  return {
    interfaces,
    entities,
    actions,
    views,
    states,
    links,
    rules,
    eventHandlers,
    middlewares,
    transports,
    graphqlExtensions,
    commands,
  };
}

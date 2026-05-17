/**
 * cap-view-calendar capability definition.
 *
 * Headless calendar surface for cap-adapter-ui. Logic lives in
 * use-calendar-data; rendering ships as CalendarBoard. Auto-installation is
 * opt-in because not every project wants a calendar view by default.
 */

import { defineCapability } from "@linchkit/core";

export const capViewCalendar = defineCapability({
  name: "cap-view-calendar",
  label: "Calendar View",
  description:
    "Month / week / day calendar renderer for entities with a date field. Pairs with cap-adapter-ui.",
  type: "standard",
  category: "view",
  version: "0.1.0",
  group: "view-calendar",
  dependencies: ["cap-adapter-ui"],
  autoInstall: false,
});

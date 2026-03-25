/**
 * Default widget registration.
 *
 * Registers all built-in widgets into the global registry.
 * Call this once at app initialization.
 * Capabilities can register additional widgets after this.
 */

import { widgetRegistry } from "@/lib/widget-registry";
import { BooleanDisplay, BooleanInput } from "./boolean-widget";
import { DateDisplay, DateInput } from "./date-widget";
import { DateTimeDisplay, DateTimeInput } from "./datetime-widget";
import { EnumDisplay, EnumInput } from "./enum-widget";
import { JsonDisplay, JsonInput } from "./json-widget";
import { NumberDisplay, NumberInput } from "./number-widget";
import { RefDisplay, RefInput } from "./ref-widget";
import { StateDisplay, StateInput } from "./state-widget";
import { StringDisplay, StringInput } from "./string-widget";
import { TextDisplay, TextInput } from "./text-widget";

export function registerDefaultWidgets() {
  widgetRegistry.register({
    definition: {
      id: "string",
      fieldTypes: "string",
      modes: ["display", "input"],
      isDefault: true,
    },
    display: StringDisplay,
    input: StringInput,
  });

  widgetRegistry.register({
    definition: { id: "text", fieldTypes: "text", modes: ["display", "input"], isDefault: true },
    display: TextDisplay,
    input: TextInput,
  });

  widgetRegistry.register({
    definition: {
      id: "number",
      fieldTypes: "number",
      modes: ["display", "input"],
      isDefault: true,
    },
    display: NumberDisplay,
    input: NumberInput,
  });

  widgetRegistry.register({
    definition: {
      id: "boolean",
      fieldTypes: "boolean",
      modes: ["display", "input"],
      isDefault: true,
    },
    display: BooleanDisplay,
    input: BooleanInput,
  });

  widgetRegistry.register({
    definition: { id: "date", fieldTypes: "date", modes: ["display", "input"], isDefault: true },
    display: DateDisplay,
    input: DateInput,
  });

  widgetRegistry.register({
    definition: {
      id: "datetime",
      fieldTypes: "datetime",
      modes: ["display", "input"],
      isDefault: true,
    },
    display: DateTimeDisplay,
    input: DateTimeInput,
  });

  widgetRegistry.register({
    definition: { id: "enum", fieldTypes: "enum", modes: ["display", "input"], isDefault: true },
    display: EnumDisplay,
    input: EnumInput,
  });

  widgetRegistry.register({
    definition: { id: "state", fieldTypes: "state", modes: ["display", "input"], isDefault: true },
    display: StateDisplay,
    input: StateInput,
  });

  widgetRegistry.register({
    definition: { id: "json", fieldTypes: "json", modes: ["display", "input"], isDefault: true },
    display: JsonDisplay,
    input: JsonInput,
  });

  // computed is display-only, uses string display as default
  widgetRegistry.register({
    definition: { id: "computed", fieldTypes: "computed", modes: ["display"], isDefault: true },
    display: StringDisplay,
  });

  // ref widget for reference/Link FK fields
  widgetRegistry.register({
    definition: { id: "ref", fieldTypes: "ref", modes: ["display", "input"], isDefault: true },
    display: RefDisplay,
    input: RefInput,
  });
}

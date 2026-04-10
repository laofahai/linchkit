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
import { HasManyDisplay, HasManyInput } from "./has-many-widget";
import { JsonDisplay, JsonInput } from "./json-widget";
import { ManyToManyDisplay, ManyToManyInput } from "./many-to-many-widget";
import { NumberDisplay, NumberInput } from "./number-widget";
import { RefDisplay, RefInput } from "./ref-widget";
import { RichTextDisplay, RichTextInput } from "./rich-text-widget";
import { StateDisplay, StateInput } from "./state-widget";
import { StringDisplay, StringInput } from "./string-widget";
import { TextDisplay, TextInput } from "./text-widget";
import { TranslatableStringDisplay, TranslatableStringInput } from "./translatable-string-widget";
import { TranslatableTextDisplay, TranslatableTextInput } from "./translatable-text-widget";

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

  // Rich text editor for text fields with ui.editor: "rich"
  widgetRegistry.register({
    definition: {
      id: "text-rich",
      fieldTypes: "text",
      modes: ["display", "input"],
    },
    display: RichTextDisplay,
    input: RichTextInput,
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

  // ── Relation widgets — resolved by cardinality from RelationRegistry (Spec 61) ──
  // IDs that share the same display/input components are registered in a loop.

  // Legacy widget ID aliases — kept for backward compatibility with existing view definitions
  for (const id of ["many_to_one", "one_to_one", "ref"] as const) {
    widgetRegistry.register({
      definition: { id, fieldTypes: "string", modes: ["display", "input"], isDefault: false },
      display: RefDisplay,
      input: RefInput,
    });
  }

  // Collection widgets: one_to_many with legacy "has_many" alias for backward compatibility
  for (const id of ["one_to_many", "has_many"] as const) {
    widgetRegistry.register({
      definition: { id, fieldTypes: "string", modes: ["display", "input"], isDefault: false },
      display: HasManyDisplay,
      input: HasManyInput,
    });
  }

  // many_to_many: multi-select tags
  widgetRegistry.register({
    definition: {
      id: "many_to_many",
      fieldTypes: "string",
      modes: ["display", "input"],
      isDefault: false,
    },
    display: ManyToManyDisplay,
    input: ManyToManyInput,
  });

  // Translatable string widget — locale tabs + text input for i18n fields
  widgetRegistry.register({
    definition: {
      id: "translatable-string",
      fieldTypes: "string",
      modes: ["display", "input"],
    },
    display: TranslatableStringDisplay,
    input: TranslatableStringInput,
  });

  // Translatable text widget — locale tabs + textarea for i18n multiline fields
  widgetRegistry.register({
    definition: {
      id: "translatable-text",
      fieldTypes: "text",
      modes: ["display", "input"],
    },
    display: TranslatableTextDisplay,
    input: TranslatableTextInput,
  });
}

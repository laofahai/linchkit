# @linchkit/cap-view-kanban

Kanban board view for LinchKit entities with a `defineState()` state machine.

- Columns derived from the entity's declared states.
- Drag-and-drop moves call the entity's transition action — never mutate
  the state field directly.
- Drops outside the declared transitions are rejected client-side before
  any mutation is sent.
- Accessible by default — keyboard activation (Space / arrows / Enter)
  via `@dnd-kit`.

## Install

```bash
bun add @linchkit/cap-view-kanban
```

Peer dependencies: `@linchkit/core`, `@linchkit/cap-adapter-ui`, `react`.

## Usage

```tsx
import { KanbanBoard } from "@linchkit/cap-view-kanban";
import type { EntityDefinition, StateDefinition } from "@linchkit/core/types";

interface Props {
  schema: EntityDefinition;
  stateDefinition: StateDefinition;
  data: Array<{ id: string; status: string; title: string }>;
  onRefresh: () => void;
}

export function PurchaseBoard({ schema, stateDefinition, data, onRefresh }: Props) {
  return (
    <KanbanBoard
      entity="purchase_request"
      schema={schema}
      stateDefinition={stateDefinition}
      stateField="status"
      cardFields={["title", "assignee"]}
      data={data}
      onCardClick={(id) => console.log("open", id)}
      onTransitioned={() => onRefresh()}
      onTransitionError={({ error }) => console.error(error)}
    />
  );
}
```

## Props

| Prop                | Type                                                                             | Required | Notes                                                                 |
| ------------------- | -------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| `entity`            | `string`                                                                         | yes      | Snake-case entity name.                                               |
| `schema`            | `EntityDefinition`                                                               | yes      | Entity definition — supplies field metadata / presentation hints.     |
| `stateDefinition`   | `StateDefinition`                                                                | yes      | State machine — columns derive from `states` + `transitions`.         |
| `stateField`        | `string`                                                                         | no       | Overrides `stateDefinition.field` if cards carry the state elsewhere. |
| `data`              | `ReadonlyArray<{ id: string; [k: string]: unknown }>`                            | yes      | Records to render.                                                    |
| `cardFields`        | `ReadonlyArray<string>`                                                          | no       | Fields shown on each card. Defaults to presentation summary fields.   |
| `loading`           | `boolean`                                                                        | no       | Show skeleton columns.                                                |
| `error`             | `string \| null`                                                                 | no       | Render an alert instead of the board.                                 |
| `onCardClick`       | `(recordId: string) => void`                                                     | no       | Called on click / Enter on a card.                                    |
| `onTransitioned`    | `(input: { recordId; from; to }) => void`                                        | no       | After a successful transition.                                        |
| `onTransitionError` | `(input: { recordId; to; error }) => void`                                       | no       | On validation failure or transport error.                             |
| `queryFields`       | `ReadonlyArray<string>`                                                          | no       | Fields requested from the transition mutation. Default `[id, state]`. |
| `transition`        | `(input: { entity; recordId; to; fields }) => Promise<KanbanRecord>`             | no       | Inject a custom transport (tests, custom transports).                 |
| `className`         | `string`                                                                         | no       | Applied to the board wrapper.                                         |

## References

- Spec 13 — View & UI (`docs/specs/13_view_and_ui.md`)
- Spec 54 — Advanced UI Features (`docs/specs/54_advanced_ui_features.md`)
- Issue [#86](https://github.com/laofahai/linchkit/issues/86)

# @linchkit/cap-view-calendar

Calendar view capability — month / week / day grid for entities with a date field.

Implements one of the advanced view types described in [Spec 54](../../docs/specs/54_advanced_ui_features.md). Tracks [issue #86](https://github.com/laofahai/linchkit/issues/86).

## Install

```bash
bun add @linchkit/cap-view-calendar
```

Register it alongside `cap-adapter-ui` (the calendar is rendered inside the React UI shell):

```ts
import { capViewCalendar } from "@linchkit/cap-view-calendar";
// pass to your capability set
```

`autoInstall: false` — opt in per project.

## Usage

```tsx
import { CalendarBoard } from "@linchkit/cap-view-calendar";

<CalendarBoard
  entity="task"
  dateField="due_date"
  endDateField="end_date"   // optional, enables multi-day bars
  titleField="title"
  data={records}
  initialMode="month"        // "month" | "week" | "day"
  onEventClick={(record) => router.navigate(`/tasks/${record.id}`)}
  onMoveEvent={(record, newDate) => updateDueDate(record.id, newDate)}
/>;
```

### Props

| Prop          | Type                                | Required | Notes                                                |
| ------------- | ----------------------------------- | :------: | ---------------------------------------------------- |
| `entity`      | `string`                            | yes      | Entity name (used for keying / labelling)            |
| `dateField`   | `string`                            | yes      | Field holding the event start date                   |
| `titleField`  | `string`                            | yes      | Field rendered as the chip title                     |
| `data`        | `Record<string, unknown>[]`         | yes      | Source records                                       |
| `endDateField`| `string`                            | no       | Enables multi-day bars                               |
| `initialMode` | `"month" \| "week" \| "day"`        | no       | Default: `"month"`                                   |
| `currentDate` | `Date`                              | no       | Controlled focal date                                |
| `onDateChange`| `(date: Date) => void`              | no       | Fires when the user navigates                        |
| `loading`     | `boolean`                           | no       | Renders the loading slot                             |
| `error`       | `Error \| null`                     | no       | Renders the error slot                               |
| `onEventClick`| `(record) => void`                  | no       | Fires when an event chip is clicked                  |
| `onMoveEvent` | `(record, newDate: Date) => void`   | no       | Fires after the user drops an event on a new day     |

## Architecture notes

- Pure date logic lives in `use-calendar-data.ts` — fully covered by `__tests__/use-calendar-data.test.ts`.
- Rendering is `CalendarBoard` → `CalendarGrid` → `CalendarEvent`.
- Drag-and-drop uses `@dnd-kit/core` (matches the rest of LinchKit's interactive views).
- Headless data layer: the component never calls GraphQL — pass `data` from the host.

## License

MIT, part of the LinchKit project.

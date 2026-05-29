# @linchkit/cap-view-timeline

Gantt/timeline view capability for LinchKit — renders entity records as horizontal bars on a configurable time axis (day / week / month).

Companion to `cap-view-kanban` and `cap-view-calendar`. Issue #86, Spec 54.

## Usage

```tsx
import { TimelineBoard } from "@linchkit/cap-view-timeline";

<TimelineBoard
  entity="project_task"
  startField="planned_start"
  endField="planned_end"
  labelField="name"
  groupByField="assignee"   // optional — groups rows
  data={records}
  initialMode="week"        // "day" | "week" | "month"
  onBarClick={(record) => router.push(`/tasks/${record.id}`)}
/>
```

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `entity` | `string` | — | Entity name (labelling only) |
| `startField` | `string` | — | ISO date / Date / epoch start field |
| `endField` | `string` | — | ISO date / Date / epoch end field |
| `labelField` | `string` | — | Text displayed on the bar |
| `groupByField` | `string?` | — | Optional group-by field |
| `data` | `TimelineRecord[]` | — | Records to render |
| `initialMode` | `"day"\|"week"\|"month"` | `"week"` | Time-axis granularity |
| `currentDate` | `Date?` | `new Date()` | Controlled anchor date |
| `onDateChange` | `(d: Date) => void` | — | Navigate callback |
| `loading` | `boolean` | `false` | Skeleton state |
| `error` | `Error?` | `null` | Error slot |
| `onBarClick` | `(r: TimelineRecord) => void` | — | Bar click handler |
| `className` | `string?` | — | Outer wrapper class |

## Installation

```ts
// linchkit.config.ts
import { capViewTimeline } from "@linchkit/cap-view-timeline/capability";

export default defineConfig({
  capabilities: [capViewTimeline],
});
```

`autoInstall: false` — opt-in only (requires `cap-adapter-ui` peer).

## i18n

Registers `en` and `zh-CN` bundles into the shared react-i18next instance on import. Override via `i18n.addResourceBundle`.

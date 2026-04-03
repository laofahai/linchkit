/**
 * Built-in panels that are always available (depend only on core features).
 */
import { registerRecordPanel } from "./panel-registry";

registerRecordPanel({
  id: "version-history",
  capability: "__builtin__",
  slot: "record-detail-tab",
  label: "versionHistory.title",
  icon: "History",
  order: 900,
  component: () => import("../components/version-history-panel"),
});

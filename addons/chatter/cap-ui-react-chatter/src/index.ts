import { registerRecordPanel } from "@linchkit/cap-adapter-ui-react/panel-registry";

export { capUiReactChatter } from "./capability";

registerRecordPanel({
  id: "chatter",
  capability: "cap-chatter",
  slot: "record-detail-tab",
  label: "chatter.title",
  icon: "MessageSquare",
  order: 200,
  component: () => import("./chatter-panel"),
});

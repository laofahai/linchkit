import { defineCapability } from "@linchkit/core";

export const capUiReactChatter = defineCapability({
  name: "cap-ui-react-chatter",
  label: "Chatter UI (React)",
  description:
    "Record timeline panel for the React UI adapter. Auto-installs when cap-chatter and cap-adapter-ui-react are both active.",
  type: "standard",
  category: "system",
  version: "0.1.0",
  group: "chatter",
  dependencies: ["cap-adapter-ui-react", "cap-chatter"],
  autoInstall: true,
});

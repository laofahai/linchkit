import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { registerDefaultWidgets } from "./components/widgets";
import "./app.css";

// Register built-in widgets before rendering
registerDefaultWidgets();

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

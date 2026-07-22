import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { bootstrapConsoleSession } from "./console-session";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("控制台挂载节点不存在。");
}

void bootstrapConsoleSession().catch(() => undefined).finally(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});

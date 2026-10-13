import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/app";
import { desktopBridge } from "./app/bootstrap";
import { followSystemAppearance } from "./design/appearance";
import "./styles.css";

followSystemAppearance(document.documentElement, window.matchMedia("(prefers-color-scheme: dark)"));
// In the desktop app the window has macOS's sidebar material for the sidebar to show (tokens.css).
if (desktopBridge() !== undefined) document.documentElement.dataset["material"] = "";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html is missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

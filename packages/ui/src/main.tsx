import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/app";
import { followSystemAppearance } from "./design/appearance";
import "./styles.css";

followSystemAppearance(document.documentElement, window.matchMedia("(prefers-color-scheme: dark)"));

const root = document.getElementById("root");
if (root === null) throw new Error("index.html is missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

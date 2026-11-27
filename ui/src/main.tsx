import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApi } from "./api";
import { App } from "./App";
import { applyTheme, loadThemePref } from "./lib/theme";

applyTheme(loadThemePref());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App api={createApi()} />
  </StrictMode>,
);

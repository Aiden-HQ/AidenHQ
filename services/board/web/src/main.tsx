import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { WelcomeGate } from "./Welcome";
import { preloadBoot } from "./queries";
// Tokens, then the components, then the older page styles (which may refine a component in place).
import "./ui/tokens.css";
import "./ui/ui.css";
import "./styles.css";

// A tab still running the build from before a deploy can't load that build's page chunks any more: reload into the new one
// (once a minute at most, so a genuinely missing chunk can't loop).
window.addEventListener("vite:preloadError", (e) => {
  try {
    const last = Number(sessionStorage.getItem("chunk-reload") ?? 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem("chunk-reload", String(Date.now()));
  } catch {}
  e.preventDefault();
  location.reload();
});

preloadBoot();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WelcomeGate>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </WelcomeGate>
  </StrictMode>,
);

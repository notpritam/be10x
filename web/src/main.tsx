import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// PWA: register the service worker in production builds so the board is installable with an offline
// shell. Skipped in dev so it never interferes with Vite HMR. When a NEW service worker takes control
// (a fresh build shipped), reload once so the live app is never a stale cached copy.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  let reloading = false;
  // Only reload on a genuine UPDATE (a controller was already in charge) — not the first-ever install,
  // which would otherwise cause a pointless reload on the user's first visit.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading || !hadController) return;
    reloading = true;
    window.location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => reg.update())
      .catch(() => {
        /* SW is a progressive enhancement — the app works without it */
      });
  });
}

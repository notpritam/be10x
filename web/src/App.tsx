// ABOUTME: Root component — resolves the session, then routes between the auth screen and the app shell.
// Single-page and state-driven (no client-side router / deep URLs), because the static server has no SPA fallback.
import { useCallback, useEffect, useState } from "react";
import { Toaster } from "sonner";
import { api } from "@/lib/api";
import type { User } from "@/lib/types";
import { AppProvider } from "@/state/app-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthScreen } from "@/components/auth/AuthScreen";
import { AppShell } from "@/components/shell/AppShell";
import { BootSplash } from "@/components/common/BootSplash";
import { ShareReviewPage } from "@/components/share/ShareReviewPage";
import { DeviceApprovePage } from "@/components/agent/DeviceApprovePage";
import { LandingPage } from "@/components/landing/LandingPage";
import { AdminDashboard } from "@/components/admin/AdminDashboard";

type Session = "loading" | User | null;

export function App() {
  const [session, setSession] = useState<Session>("loading");
  // Logged-out visitors see the landing page by default; the CTA (or /login) opens the auth form.
  const [authMode, setAuthMode] = useState<null | "signin" | "signup">(
    typeof window !== "undefined" && window.location.pathname === "/login" ? "signin" : null,
  );

  useEffect(() => {
    let active = true;
    api
      .me()
      .then(({ user }) => active && setSession(user))
      .catch(() => active && setSession(null));
    return () => {
      active = false;
    };
  }, []);

  const handleSignedOut = useCallback(() => setSession(null), []);

  // A public share/review link (/share/<token>) renders without an account — external reviewers.
  const shareToken =
    typeof window !== "undefined" ? /^\/share\/([^/]+)\/?$/.exec(window.location.pathname)?.[1] : undefined;

  // The admin dashboard (/admin) has its own bearer-token gate, independent of the session cookie
  // entirely — it renders before session resolution so it never waits on (or requires) a login.
  const isAdminRoute = typeof window !== "undefined" && window.location.pathname === "/admin";

  // The `be10x login` approve screen (/connect?code=…). Requires an account — the minted token binds to it —
  // so it renders after auth; a signed-out visitor hits the auth screen first, then lands back here.
  const connectCode =
    typeof window !== "undefined" && window.location.pathname === "/connect"
      ? new URLSearchParams(window.location.search).get("code") ?? ""
      : undefined;

  return (
    <TooltipProvider delayDuration={200}>
      {isAdminRoute ? (
        <AdminDashboard />
      ) : shareToken ? (
        <ShareReviewPage token={decodeURIComponent(shareToken)} />
      ) : session === "loading" ? (
        <BootSplash />
      ) : connectCode !== undefined && session ? (
        <DeviceApprovePage code={connectCode} user={session} />
      ) : session === null ? (
        connectCode !== undefined || authMode ? (
          <AuthScreen
            onAuthed={setSession}
            initialMode={authMode ?? "signin"}
            onBack={connectCode !== undefined ? undefined : () => setAuthMode(null)}
          />
        ) : (
          <LandingPage onGetStarted={() => setAuthMode("signup")} onSignIn={() => setAuthMode("signin")} />
        )
      ) : (
        <AppProvider user={session} onSignedOut={handleSignedOut}>
          <AppShell />
        </AppProvider>
      )}

      <Toaster
        position="top-right"
        gap={10}
        offset={16}
        toastOptions={{
          classNames: {
            toast:
              "!rounded-xl !border-border !bg-popover !text-popover-foreground !shadow-pop !font-sans",
            title: "!text-[13px] !font-semibold",
            description: "!text-muted-foreground !text-[13px]",
            actionButton: "!bg-primary !text-primary-foreground !rounded-md",
            closeButton: "!bg-popover !border-border",
          },
        }}
      />
    </TooltipProvider>
  );
}

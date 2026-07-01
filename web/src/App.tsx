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

type Session = "loading" | User | null;

export function App() {
  const [session, setSession] = useState<Session>("loading");

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

  return (
    <TooltipProvider delayDuration={200}>
      {shareToken ? (
        <ShareReviewPage token={decodeURIComponent(shareToken)} />
      ) : session === "loading" ? (
        <BootSplash />
      ) : session === null ? (
        <AuthScreen onAuthed={setSession} />
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

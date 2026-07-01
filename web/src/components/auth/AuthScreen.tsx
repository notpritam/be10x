// ABOUTME: Login / signup screen (tabbed). Same-origin auth: on success the session cookie is set
// and we hand the user object up to <App/>. Includes a one-tap demo-account fill for reviewers.
import { useState, type FormEvent } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import type { User } from "@/lib/types";
import { BrandTile, Wordmark } from "@/components/common/Brandmark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

type Mode = "signin" | "signup";

export function AuthScreen({ onAuthed }: { onAuthed: (user: User) => void }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(next: { email: string; password: string; displayName?: string }, m: Mode) {
    setBusy(true);
    setError(null);
    try {
      const { user } =
        m === "signin"
          ? await api.login(next.email, next.password)
          : await api.signup(next.email, next.displayName ?? "", next.password);
      toast.success(m === "signin" ? `Welcome back, ${user.displayName}.` : `Welcome, ${user.displayName}.`);
      onAuthed(user);
    } catch (err) {
      const msg = errorMessage(err);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mode === "signup" && !displayName.trim()) {
      setError("Please add a display name.");
      return;
    }
    void submit({ email: email.trim(), password, displayName: displayName.trim() }, mode);
  }

  function fillDemo() {
    setMode("signin");
    setEmail("demo@gfa.dev");
    setPassword("pw12345");
    setError(null);
    void submit({ email: "demo@gfa.dev", password: "pw12345" }, "signin");
  }

  return (
    <div className="relative grid h-full place-items-center overflow-hidden bg-background px-5">
      {/* Faint warm ambience, kept subtle — no neon, no AI gradient. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60rem 40rem at 50% -10%, rgba(232,98,13,0.07), transparent 60%)",
        }}
      />

      <div className="relative w-full max-w-[400px] soft-fade">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <BrandTile className="size-11" />
          <div>
            <Wordmark className="text-xl" />
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              A calm board for humans and agents.
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-border/70 bg-card p-6 shadow-pop">
          <Tabs value={mode} onValueChange={(v) => { setMode(v as Mode); setError(null); }}>
            <TabsList className="mb-5 w-full bg-muted">
              <TabsTrigger value="signin" className="flex-1">
                Sign in
              </TabsTrigger>
              <TabsTrigger value="signup" className="flex-1">
                Create account
              </TabsTrigger>
            </TabsList>

            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <TabsContent value="signup" className="m-0 flex flex-col gap-4 data-[state=inactive]:hidden">
                <Field
                  id="displayName"
                  label="Display name"
                  value={displayName}
                  onChange={setDisplayName}
                  placeholder="Ada Lovelace"
                  autoComplete="name"
                />
              </TabsContent>

              <Field
                id="email"
                label="Email"
                type="email"
                value={email}
                onChange={setEmail}
                placeholder="you@company.com"
                autoComplete="email"
                required
              />
              <Field
                id="password"
                label="Password"
                type="password"
                value={password}
                onChange={setPassword}
                placeholder="••••••••"
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                required
              />

              {error && (
                <p className="-mt-1 text-[13px] font-medium text-destructive" role="alert">
                  {error}
                </p>
              )}

              <Button type="submit" disabled={busy} className="mt-1 h-10 w-full text-[13px]">
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <>
                    {mode === "signin" ? "Sign in" : "Create account"}
                    <ArrowRight className="size-4" />
                  </>
                )}
              </Button>
            </form>
          </Tabs>
        </div>

        <button
          type="button"
          onClick={fillDemo}
          disabled={busy}
          className="mx-auto mt-4 block rounded-md px-3 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
        >
          Explore the demo account
          <span className="ml-1.5 font-mono text-[11px] text-foreground/70">demo@gfa.dev</span>
        </button>
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  autoComplete,
  required,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-[12.5px] text-foreground/80">
        {label}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        className="h-10 bg-background text-[13.5px]"
      />
    </div>
  );
}

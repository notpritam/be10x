// ABOUTME: The top-bar bell — unread count + a dropdown of recent notifications (assigned / review /
// ABOUTME: input / changes). Polls the feed; opening it marks all seen; clicking one opens the task.
import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { api } from "@/lib/api";
import type { Notification } from "@/lib/types";
import { useApp } from "@/state/app-store";
import { cn, relativeTime } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const KIND_LABEL: Record<string, string> = {
  assigned: "Assigned to you",
  review_requested: "Review requested",
  input_needed: "Needs your input",
  changes_requested: "Changes requested",
};

export function NotificationsBell() {
  const { selectTask } = useApp();
  const [items, setItems] = useState<Notification[]>([]);
  const [unseen, setUnseen] = useState(0);
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .notifications()
        .then((r) => {
          if (!live) return;
          setItems(r.notifications);
          // While the dropdown is open we've marked them seen, so don't flash the badge back on.
          if (!openRef.current) setUnseen(r.unseen);
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next && unseen > 0) {
      setUnseen(0);
      void api.markNotificationsSeen().catch(() => {});
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Notifications"
          className="relative grid size-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Bell className="size-[18px]" />
          {unseen > 0 && (
            <span className="absolute -right-0.5 -top-0.5 grid min-w-[15px] place-items-center rounded-full bg-primary px-1 text-[9.5px] font-bold leading-[15px] text-primary-foreground">
              {unseen > 9 ? "9+" : unseen}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="border-b border-border/60 px-3 py-2 text-[12px] font-semibold text-foreground">Notifications</div>
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12.5px] text-muted-foreground">You're all caught up.</p>
        ) : (
          <ul className="max-h-[360px] overflow-y-auto scroll-thin py-1">
            {items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (n.taskId) selectTask(n.taskId);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors hover:bg-accent/50",
                    !n.seenAt && "bg-primary/[0.04]",
                  )}
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                      {KIND_LABEL[n.kind] ?? n.kind}
                    </span>
                    <span className="ml-auto text-[10.5px] text-muted-foreground/60">{relativeTime(n.createdAt)}</span>
                  </span>
                  <span className="text-[13px] font-medium text-foreground">{n.title}</span>
                  {n.body && <span className="line-clamp-2 text-[12px] text-muted-foreground">{n.body}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

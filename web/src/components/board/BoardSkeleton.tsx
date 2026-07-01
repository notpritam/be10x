// ABOUTME: Loading state that matches the board's shape (columns of card-shaped skeletons).
import { BOARD_COLUMNS, STATUS_META } from "@/lib/lifecycle";
import { Skeleton } from "@/components/ui/skeleton";

export function BoardSkeleton() {
  return (
    <div className="flex h-full gap-3 overflow-hidden px-5 pb-6 pt-4">
      {BOARD_COLUMNS.slice(0, 6).map((status, ci) => (
        <div key={status} className="flex w-[300px] shrink-0 flex-col">
          <div className="flex h-9 items-center gap-2 px-1.5">
            <span className="size-2.5 rounded-full opacity-40" style={{ background: STATUS_META[status].color }} />
            <div className="h-3 w-20 rounded bg-muted" />
          </div>
          <div className="flex flex-col gap-2.5 px-1 pt-1">
            {Array.from({ length: (ci % 3) + 1 }).map((_, i) => (
              <div key={i} className="rounded-[14px] border border-border/60 bg-card p-3.5 shadow-card">
                <div className="mb-2 flex items-center justify-between">
                  <Skeleton className="h-3 w-12" />
                  <Skeleton className="h-4 w-14 rounded-full" />
                </div>
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="mt-2 h-3 w-2/3" />
                <div className="mt-4 flex items-center justify-between">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="size-6 rounded-full" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

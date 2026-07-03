// ABOUTME: A server-side folder browser for adding a repo without typing a path. The board runs on the
// user's machine, so browsing the server FS = browsing their folders. Git repos are flagged + selectable.
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, CornerLeftUp, Folder, FolderGit2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api";
import type { FsListing, Project } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function DirectoryPicker({
  open,
  onOpenChange,
  onAdded,
  teamId = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (project: Project) => void;
  /** Share the newly-added repo with this team instead of keeping it personal. */
  teamId?: string | null;
}) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  const browse = useCallback(async (path?: string) => {
    setLoading(true);
    try {
      setListing(await api.browseDirs(path));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void browse();
  }, [open, browse]);

  async function add(path: string) {
    setAdding(path);
    try {
      const { project } = await api.addProject(path, teamId);
      toast.success(`Added ${project.name}.`);
      onAdded(project);
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAdding(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="text-[16px]">Add a repository</DialogTitle>
          <DialogDescription>Browse to a git repo on this machine and add it — no path typing.</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-1.5">
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground/80">{listing?.path ?? "…"}</code>
          {loading && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
        </div>

        <div className="max-h-[340px] min-h-[160px] overflow-y-auto scroll-thin rounded-lg border border-border">
          {listing?.parent && (
            <button
              type="button"
              onClick={() => void browse(listing.parent ?? undefined)}
              className="flex w-full items-center gap-2 border-b border-border/60 px-3 py-2 text-left text-[13px] hover:bg-accent/50"
            >
              <CornerLeftUp className="size-4 text-muted-foreground" />
              <span className="text-muted-foreground">Up a level</span>
            </button>
          )}
          {listing && listing.entries.length === 0 && (
            <p className="px-3 py-8 text-center text-[12.5px] text-muted-foreground">No subfolders here.</p>
          )}
          {listing?.entries.map((e) => (
            <div key={e.path} className="flex items-center gap-2 border-b border-border/40 px-3 py-2 last:border-b-0 hover:bg-accent/40">
              <button type="button" onClick={() => void browse(e.path)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                {e.isRepo ? (
                  <FolderGit2 className="size-4 shrink-0 text-primary" />
                ) : (
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate text-[13px] text-foreground/90">{e.name}</span>
                {e.isRepo && (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">git</span>
                )}
                <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground/50" />
              </button>
              {e.isRepo && (
                <Button size="sm" variant="outline" disabled={adding === e.path} onClick={() => void add(e.path)}>
                  {adding === e.path ? "Adding…" : "Add"}
                </Button>
              )}
            </div>
          ))}
        </div>

        {listing?.isRepo && (
          <div className="flex justify-end">
            <Button disabled={adding === listing.path} onClick={() => void add(listing.path)}>
              {adding === listing.path ? "Adding…" : "Add this folder"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

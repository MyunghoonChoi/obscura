"use client";

import {
  AlertTriangleIcon,
  CheckIcon,
  DownloadIcon,
  ExternalLinkIcon,
  ImagePlusIcon,
  Loader2Icon,
  WandSparklesIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isBusy, type JobState } from "@/hooks/use-generation";
import { cn } from "@/lib/utils";

/** Sends a finished still back into the character's training dataset. */
export interface DatasetAction {
  characterName: string;
  state: "idle" | "adding" | "added";
  onAdd: () => void;
}

interface StageProps {
  job: JobState;
  width: number;
  height: number;
  datasetAction?: DatasetAction;
}

/** The big canvas: empty state → queued → live latent previews + progress → final video/image. */
export function Stage({ job, width, height, datasetAction }: StageProps) {
  const busy = isBusy(job.status);
  const result = job.results[0];
  const elapsed = useElapsed(busy ? job.startedAt : undefined);
  const pct = job.progress ? Math.round((job.progress.value / job.progress.max) * 100) : 0;

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4">
      <div
        className="relative max-h-full max-w-full overflow-hidden rounded-2xl border border-border bg-black/40 shadow-2xl shadow-black/40"
        style={{ aspectRatio: `${width} / ${height}`, height: "min(100%, 80dvh)" }}
      >
        {/* Result */}
        {job.status === "done" &&
          result &&
          (result.kind === "video" ? (
            <video key={result.url} src={result.url} autoPlay loop muted playsInline controls className="size-full object-contain" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- proxied ComfyUI output
            <img src={result.url} alt="Generated" className="size-full object-contain" />
          ))}

        {/* Live latent preview while rendering (needs ComfyUI launched with --preview-method auto) */}
        {busy && job.preview && (
          // eslint-disable-next-line @next/next/no-img-element -- data: URL from the socket
          <img src={job.preview} alt="" className="size-full object-contain" />
        )}

        {/* Busy, no preview yet */}
        {busy && !job.preview && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <div className="absolute inset-0 animate-pulse bg-linear-to-br from-violet-500/10 via-transparent to-fuchsia-500/10" />
            <Loader2Icon className="size-6 animate-spin text-primary" />
            <p className="text-sm">
              {job.status === "submitting"
                ? "Uploading & building workflow…"
                : job.status === "queued" && job.queuePosition
                  ? `Queued · position ${job.queuePosition}`
                  : (job.stage ?? "Warming up…")}
            </p>
          </div>
        )}

        {/* Progress HUD */}
        {busy && (
          <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/80 to-transparent p-4 pt-10">
            <div className="mb-2 flex items-center justify-between gap-3 text-xs text-white/80">
              <span className="flex min-w-0 items-center gap-2">
                <span className="relative flex size-2 shrink-0">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-fuchsia-400 opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-fuchsia-400" />
                </span>
                <span className="truncate">{job.stage ?? (job.status === "queued" ? "Waiting in queue" : "Starting")}</span>
                {job.progress && (
                  <span className="font-mono text-white/60">
                    {job.progress.value}/{job.progress.max}
                  </span>
                )}
              </span>
              <span className="font-mono tabular-nums">{elapsed}</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-white/15">
              <div
                className={cn(
                  "h-full rounded-full bg-linear-to-r from-violet-400 to-fuchsia-400 transition-[width] duration-300",
                  !job.progress && "w-1/3 animate-indeterminate",
                )}
                style={job.progress ? { width: `${pct}%` } : undefined}
              />
            </div>
          </div>
        )}

        {/* Idle */}
        {job.status === "idle" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="rounded-2xl bg-linear-to-br from-violet-500/20 to-fuchsia-500/20 p-4 ring-1 ring-white/10">
              <WandSparklesIcon className="size-7 text-violet-300" />
            </div>
            <p className="text-sm font-medium">Your canvas is empty</p>
            <p className="max-w-64 text-xs text-muted-foreground">
              Write a prompt, drop in a face to lock the character, and hit generate.
            </p>
          </div>
        )}

        {/* Error */}
        {job.status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center">
            <AlertTriangleIcon className="size-7 text-destructive" />
            <p className="text-sm font-medium">Generation failed</p>
            <p className="max-w-md font-mono text-xs break-words text-muted-foreground">{job.error}</p>
          </div>
        )}
      </div>

      {job.status === "done" && result && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {job.seed !== undefined && (
            <Badge variant="outline" className="font-mono">
              seed {job.seed}
            </Badge>
          )}
          <Button variant="outline" size="sm" nativeButton={false} render={<a href={result.url} download={result.filename} />}>
            <DownloadIcon /> Download
          </Button>
          <Button variant="ghost" size="sm" nativeButton={false} render={<a href={result.url} target="_blank" rel="noreferrer" />}>
            <ExternalLinkIcon /> Open
          </Button>
          {datasetAction && (
            <Button
              variant="outline"
              size="sm"
              onClick={datasetAction.onAdd}
              disabled={datasetAction.state !== "idle"}
              title="Good likeness? Add it to the training set for the next LoRA version."
              className="border-primary/40"
            >
              {datasetAction.state === "adding" ? (
                <Loader2Icon className="animate-spin" />
              ) : datasetAction.state === "added" ? (
                <CheckIcon className="text-emerald-400" />
              ) : (
                <ImagePlusIcon />
              )}
              {datasetAction.state === "added" ? "Added to" : "Add to"} {datasetAction.characterName}&apos;s dataset
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function useElapsed(since?: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return "";
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

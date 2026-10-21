"use client";

import { FilmIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { MAX_SOURCE_BYTES } from "@/lib/comfy/presets";
import { cn } from "@/lib/utils";

export interface SourceInfo {
  kind: "image" | "video";
  width: number;
  height: number;
  /** Seconds (video only). */
  duration?: number;
}

interface SourceDropProps {
  file: File | null;
  onChange: (file: File | null) => void;
  /** Called once the browser has decoded the source, so the server can pick an SDXL size for it. */
  onMeasured: (info: SourceInfo) => void;
}

export const sourceKind = (f: File | null): SourceInfo["kind"] | null =>
  !f ? null : f.type.startsWith("video/") ? "video" : f.type.startsWith("image/") ? "image" : null;

/** Drop target for the clip or photo a Remix edits. */
export function SourceDrop({ file, onChange, onMeasured }: SourceDropProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [info, setInfo] = useState<SourceInfo | null>(null);
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  const kind = sourceKind(file);

  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  const accept = (files: FileList | null) => {
    const f = Array.from(files ?? []).find((x) => sourceKind(x));
    if (!f) return;
    if (f.size > MAX_SOURCE_BYTES) {
      toast.error("That file is over 500 MB. Trim the clip first.");
      return;
    }
    setInfo(null);
    onChange(f);
  };

  const measured = (next: SourceInfo) => {
    setInfo(next);
    onMeasured(next);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => !file && inputRef.current?.click()}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        accept(e.dataTransfer.files);
      }}
      className={cn(
        "group relative overflow-hidden rounded-xl border border-dashed border-border bg-muted/30 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        !file && "flex h-36 cursor-pointer items-center justify-center hover:border-primary/60 hover:bg-muted/50",
        dragging && "border-primary bg-primary/10",
      )}
    >
      <input ref={inputRef} type="file" accept="video/*,image/*" hidden onChange={(e) => accept(e.target.files)} />

      {!file && (
        <div className="flex flex-col items-center gap-2 px-4 text-center text-muted-foreground">
          <FilmIcon className="size-6 transition-transform group-hover:scale-110" />
          <p className="text-sm">
            <span className="font-medium text-foreground">Drop a clip or photo to remix</span> or click
          </p>
          <p className="text-xs">MP4 / MOV / WebM or an image, up to 500 MB</p>
        </div>
      )}

      {file && url && (
        <div className="flex gap-3 p-2">
          <div className="h-28 w-20 shrink-0 overflow-hidden rounded-lg bg-black">
            {kind === "video" ? (
              <video
                src={url}
                muted
                loop
                autoPlay
                playsInline
                className="size-full object-cover"
                onLoadedMetadata={(e) =>
                  measured({
                    kind: "video",
                    width: e.currentTarget.videoWidth,
                    height: e.currentTarget.videoHeight,
                    duration: e.currentTarget.duration,
                  })
                }
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- blob: URL
              <img
                src={url}
                alt="Source"
                className="size-full object-cover"
                onLoad={(e) => measured({ kind: "image", width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
              />
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-1 py-1 text-xs">
            <p className="truncate text-sm font-medium">{file.name}</p>
            <p className="text-muted-foreground">
              {kind === "video" ? "Video" : "Image"}
              {info && ` · ${info.width}×${info.height}`}
              {info?.duration ? ` · ${info.duration.toFixed(1)}s` : ""}
            </p>
            <p className="text-muted-foreground">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
          </div>
          <button
            type="button"
            aria-label="Remove source"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
              setInfo(null);
              if (inputRef.current) inputRef.current.value = "";
            }}
            className="absolute top-2 right-2 rounded-full bg-background/80 p-1 text-muted-foreground backdrop-blur hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

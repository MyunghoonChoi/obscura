"use client";

import { ImagePlusIcon, UserRoundIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

interface ReferenceDropProps {
  file: File | null;
  onChange: (file: File | null) => void;
}

/** Drag-and-drop / paste / click-to-browse reference image slot. */
export function ReferenceDrop({ file, onChange }: ReferenceDropProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  // Paste an image from the clipboard anywhere on the page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const img = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (img) onChange(img);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onChange]);

  const accept = (files: FileList | null) => {
    const img = Array.from(files ?? []).find((f) => f.type.startsWith("image/"));
    if (img) onChange(img);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
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
        "group relative flex h-36 cursor-pointer items-center gap-4 overflow-hidden rounded-xl border border-dashed border-border bg-muted/30 p-3 transition-colors outline-none hover:border-primary/60 hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50",
        dragging && "border-primary bg-primary/10",
      )}
    >
      <input ref={inputRef} type="file" accept="image/*" hidden onChange={(e) => accept(e.target.files)} />

      {preview ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- blob: URL */}
          <img src={preview} alt="Reference" className="h-full aspect-square rounded-lg object-cover object-top" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <UserRoundIcon className="size-3.5 text-primary" /> Character locked
            </p>
            <p className="truncate text-xs text-muted-foreground">{file?.name}</p>
            <p className="text-xs text-muted-foreground">Face is injected via IP-Adapter on every frame.</p>
          </div>
          <button
            type="button"
            aria-label="Remove reference"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
              if (inputRef.current) inputRef.current.value = "";
            }}
            className="absolute top-2 right-2 rounded-full bg-background/80 p-1 text-muted-foreground backdrop-blur hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        </>
      ) : (
        <div className="flex w-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
          <ImagePlusIcon className="size-6 transition-transform group-hover:scale-110" />
          <p className="text-sm">
            <span className="font-medium text-foreground">Drop a face reference</span> or click / paste
          </p>
          <p className="text-xs">Clear, front-facing portrait works best</p>
        </div>
      )}
    </div>
  );
}

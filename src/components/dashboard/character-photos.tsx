"use client";

import { ImagePlusIcon, Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { api } from "@/lib/characters/api";
import type { CharacterSummary } from "@/lib/characters/types";
import { cn } from "@/lib/utils";

const MAX_REFS_SHOWN = 4;

/**
 * The selected character's face references, plus a drop target that adds any number of photos
 * straight to its training dataset — so building a dataset doesn't require leaving the studio.
 */
export function CharacterPhotos({ character: c, onAdded }: { character: CharacterSummary; onAdded: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);

  const upload = async (list: FileList | null) => {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    setUploading(files.length);
    try {
      const body = new FormData();
      files.forEach((f) => body.append("files", f));
      await api(`/api/characters/${c.id}/images`, { method: "POST", body });
      toast.success(`Added ${files.length} photo${files.length === 1 ? "" : "s"} to ${c.name}'s dataset.`, {
        description: "Star the best face shots and edit captions on the character page.",
      });
      onAdded();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(0);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void upload(e.dataTransfer.files);
      }}
      className={cn(
        "space-y-2 rounded-lg border border-dashed border-border p-2 transition-colors",
        dragging && "border-primary bg-primary/10",
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        onChange={(e) => upload(e.target.files)}
      />
      <div className="flex items-center gap-1.5">
        {c.refs.slice(0, MAX_REFS_SHOWN).map((name) => (
          // eslint-disable-next-line @next/next/no-img-element -- local dataset file
          <img
            key={name}
            src={`/api/characters/${c.id}/images/${encodeURIComponent(name)}`}
            alt=""
            title="Starred face reference"
            className="size-10 rounded-md object-cover object-top ring-1 ring-amber-300/60"
          />
        ))}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading > 0}
          aria-label={`Add photos to ${c.name}'s dataset`}
          className="grid size-10 place-items-center rounded-md border border-dashed border-border text-muted-foreground hover:border-primary/60 hover:text-foreground"
        >
          {uploading ? <Loader2Icon className="size-4 animate-spin" /> : <ImagePlusIcon className="size-4" />}
        </button>
        <div className="min-w-0 flex-1 pl-1 text-[11px] leading-tight text-muted-foreground">
          <span className="text-foreground">{c.imageCount} photos</span> in dataset
          <br />
          {uploading ? `Uploading ${uploading}…` : "Drop several here to add more"}
        </div>
      </div>
      <Link href={`/characters/${c.id}`} className="block text-[11px] text-primary hover:underline">
        Captions, stars &amp; training →
      </Link>
    </div>
  );
}

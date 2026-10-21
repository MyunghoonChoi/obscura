"use client";

import { CheckIcon, ImagePlusIcon, InfoIcon, Loader2Icon, StarIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";

import { Textarea } from "@/components/ui/textarea";
import { api, json } from "@/lib/characters/api";
import type { CharacterDetail, DatasetImage } from "@/lib/characters/types";
import { cn } from "@/lib/utils";

const RECOMMENDED = { min: 15, max: 30 };
const MAX_REFS_USED = 4;

/** Upload area + the dataset grid, with a caption box and a "face reference" star per image. */
export function DatasetPanel({ character: c, onChange }: { character: CharacterDetail; onChange: () => Promise<unknown> }) {
  const count = c.images.length;
  const starred = c.images.filter((i) => i.starred).length;

  return (
    <section className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Dataset</h2>
          <p className="text-xs text-muted-foreground">
            {count} image{count === 1 ? "" : "s"} ·{" "}
            <span className={cn(count >= RECOMMENDED.min ? "text-emerald-400" : "text-amber-300")}>
              {RECOMMENDED.min}–{RECOMMENDED.max} recommended
            </span>{" "}
            · {starred} starred as face reference{starred === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      <UploadDrop characterId={c.id} onUploaded={onChange} />

      <details className="group rounded-lg border border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground">
        <summary className="flex cursor-pointer items-center gap-1.5 select-none hover:text-foreground">
          <InfoIcon className="size-3.5" /> How to build a good dataset
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 leading-relaxed">
          <li>
            <b className="text-foreground">Variety beats volume.</b> Mix close-ups and half/full body, different angles, expressions,
            lighting, outfits and backgrounds. Twenty near-identical selfies teach the LoRA a single pose.
          </li>
          <li>
            <b className="text-foreground">Captions:</b> keep <code className="font-mono">{c.trigger} {c.classWord}</code> at the
            start, then describe what <i>changes</i> in this photo (outfit, place, pose, lighting). Don&apos;t describe the face or
            hair: whatever you leave out gets absorbed into the trigger word.
          </li>
          <li>
            <b className="text-foreground">★ Star</b> the clearest face shots. Up to {MAX_REFS_USED} starred images also drive
            IP-Adapter when you generate, which is how you bootstrap a character before its first LoRA exists.
          </li>
          <li>
            <b className="text-foreground">Iterate:</b> generate, add your best results with <i>Add to dataset</i> in the studio, and
            train the next version.
          </li>
        </ul>
      </details>

      {count === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">No images yet. Drop a few reference photos above.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {c.images.map((img) => (
            <DatasetCard key={img.name} characterId={c.id} image={img} onChange={onChange} />
          ))}
        </div>
      )}
    </section>
  );
}

function DatasetCard({
  characterId,
  image,
  onChange,
}: {
  characterId: string;
  image: DatasetImage;
  onChange: () => Promise<unknown>;
}) {
  // Captions are only ever edited here, so the local draft is the source of truth after mount.
  const [caption, setCaption] = useState(image.caption);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  /** Optimistic star state until the reload after the PATCH lands. */
  const [pendingStar, setPendingStar] = useState<boolean | null>(null);
  const starred = pendingStar ?? image.starred;
  const [removing, setRemoving] = useState(false);
  const base = `/api/characters/${characterId}/images/${encodeURIComponent(image.name)}`;

  const saveCaption = async () => {
    if (caption.trim() === image.caption) return;
    setSaved("saving");
    try {
      await api(base, json("PATCH", { caption }));
      setSaved("saved");
      setTimeout(() => setSaved("idle"), 1500);
    } catch (e) {
      setSaved("idle");
      toast.error((e as Error).message);
    }
  };

  const toggleStar = async () => {
    setPendingStar(!starred);
    try {
      await api(base, json("PATCH", { starred: !starred }));
      await onChange();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPendingStar(null);
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      await api(base, { method: "DELETE" });
      toast("Image moved to the character's removed/ folder.");
      onChange();
    } catch (e) {
      setRemoving(false);
      toast.error((e as Error).message);
    }
  };

  return (
    <div className={cn("overflow-hidden rounded-xl border border-border bg-card/60", removing && "opacity-40")}>
      <div className="relative aspect-[3/4] bg-muted/40">
        {/* eslint-disable-next-line @next/next/no-img-element -- local dataset file */}
        <img src={image.url} alt="" loading="lazy" className="size-full object-cover object-top" />
        <button
          type="button"
          onClick={toggleStar}
          aria-pressed={starred}
          aria-label={starred ? "Unstar face reference" : "Star as face reference"}
          title={starred ? "Face reference (used by IP-Adapter)" : "Use as face reference"}
          className={cn(
            "absolute top-2 left-2 rounded-full bg-background/80 p-1.5 backdrop-blur transition",
            starred ? "text-amber-300" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <StarIcon className={cn("size-3.5", starred && "fill-current")} />
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={removing}
          aria-label="Remove from dataset"
          title="Remove from dataset"
          className="absolute top-2 right-2 rounded-full bg-background/80 p-1.5 text-muted-foreground backdrop-blur hover:text-destructive"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div className="relative p-2">
        <Textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          onBlur={saveCaption}
          aria-label="Caption"
          className="min-h-16 resize-none text-xs leading-snug"
        />
        {saved !== "idle" && (
          <span className="absolute right-3.5 bottom-3.5 text-muted-foreground">
            {saved === "saving" ? <Loader2Icon className="size-3 animate-spin" /> : <CheckIcon className="size-3 text-emerald-400" />}
          </span>
        )}
      </div>
    </div>
  );
}

function UploadDrop({ characterId, onUploaded }: { characterId: string; onUploaded: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);

  const upload = async (list: FileList | File[] | null) => {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    setUploading(files.length);
    try {
      const body = new FormData();
      files.forEach((f) => body.append("files", f));
      await api(`/api/characters/${characterId}/images`, { method: "POST", body });
      toast.success(`Added ${files.length} image${files.length === 1 ? "" : "s"}.`);
      onUploaded();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(0);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  // Paste images from the clipboard anywhere on the page (except while typing a caption).
  const onPaste = useEffectEvent((e: ClipboardEvent) => {
    if ((e.target as HTMLElement | null)?.closest?.("textarea, input")) return;
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) void upload(files);
  });
  useEffect(() => {
    const handler = (e: ClipboardEvent) => onPaste(e);
    window.addEventListener("paste", handler);
    return () => window.removeEventListener("paste", handler);
  }, []);

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
        void upload(e.dataTransfer.files);
      }}
      className={cn(
        "flex h-24 cursor-pointer items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/30 px-4 text-center text-muted-foreground transition-colors outline-none hover:border-primary/60 hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50",
        dragging && "border-primary bg-primary/10",
      )}
    >
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => upload(e.target.files)} />
      {uploading ? (
        <>
          <Loader2Icon className="size-5 animate-spin text-primary" />
          <span className="text-sm">Uploading {uploading}…</span>
        </>
      ) : (
        <>
          <ImagePlusIcon className="size-5" />
          <span className="text-sm">
            <span className="font-medium text-foreground">Drop reference photos</span> or click / paste. PNG, JPEG or WebP, several at
            once.
          </span>
        </>
      )}
    </div>
  );
}

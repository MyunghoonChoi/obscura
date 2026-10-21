"use client";

import { ArrowLeftIcon, Loader2Icon, SparklesIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, type DetailResponse } from "@/lib/characters/api";

import { DatasetPanel } from "./dataset-panel";
import { TrainingPanel } from "./training-panel";

/** /characters/[id] — the dataset on the left, training + versions on the right. */
export function CharacterStudio({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wasTraining = useRef(false);

  const apply = useCallback((d: DetailResponse) => {
    if (wasTraining.current && !d.training) {
      const last = d.character.lastRun;
      if (last?.state === "done") toast.success(`LoRA v${last.version} is ready and set as active.`);
      else if (last?.state === "error") toast.error(`Training v${last.version} failed. See the log in the training panel.`);
    }
    wasTraining.current = !!d.training;
    setData(d);
  }, []);

  const reload = useCallback(
    () =>
      api<DetailResponse>(`/api/characters/${id}`)
        .then(apply)
        .catch((e: Error) => setError(e.message)),
    [id, apply],
  );

  useEffect(() => {
    api<DetailResponse>(`/api/characters/${id}`)
      .then(apply)
      .catch((e: Error) => setError(e.message));
  }, [id, apply]);

  // Poll while this (or any) character is training so progress and the GPU lock stay current.
  const busy = !!data?.busy;
  const trainingHere = !!data?.training;
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void reload(), trainingHere ? 2000 : 5000);
    return () => clearInterval(t);
  }, [busy, trainingHere, reload]);

  if (error && !data) {
    return (
      <div className="grid min-h-dvh place-items-center p-6 text-center">
        <div className="space-y-3">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" nativeButton={false} render={<Link href="/characters" />}>
            <ArrowLeftIcon /> All characters
          </Button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const c = data.character;

  const remove = async () => {
    if (!confirm(`Move "${c.name}" to characters/_trash? Trained LoRA files stay in ComfyUI.`)) return;
    try {
      await api(`/api/characters/${id}`, { method: "DELETE" });
      router.push("/characters");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="relative isolate min-h-dvh">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,oklch(0.35_0.12_300/0.22),transparent_60%)]" />
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 sm:px-6">
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/characters" />}>
          <ArrowLeftIcon /> Characters
        </Button>
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="truncate text-base font-semibold tracking-tight">{c.name}</h1>
          <span className="font-mono text-xs text-muted-foreground">
            {c.trigger} · {c.classWord}
          </span>
        </div>
        {c.activeVersion ? <Badge>LoRA v{c.activeVersion}</Badge> : <Badge variant="outline">No LoRA yet</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" aria-label="Move character to trash" title="Move to trash" onClick={remove}>
            <Trash2Icon />
          </Button>
          <Button
            size="sm"
            nativeButton={false}
            render={<Link href={`/?character=${c.id}`} />}
            className="bg-linear-to-r from-violet-500 to-fuchsia-500 text-white hover:opacity-90"
          >
            <SparklesIcon /> Generate with {c.name}
          </Button>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-6 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <DatasetPanel character={c} onChange={reload} />
        <TrainingPanel data={data} onChange={reload} />
      </main>
    </div>
  );
}

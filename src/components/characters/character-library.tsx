"use client";

import { ArrowLeftIcon, Loader2Icon, PlusIcon, Trash2Icon, UserRoundIcon, UsersRoundIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, deleteCharacter, json, suggestTrigger, type LibraryResponse } from "@/lib/characters/api";
import { CLASS_WORDS, type Character, type CharacterSummary } from "@/lib/characters/types";

/** /characters — every character as a card, plus the "new character" form. */
export function CharacterLibrary() {
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      api<LibraryResponse>("/api/characters")
        .then((d) => {
          setData(d);
          if (d.training) timer = setTimeout(load, 4000); // keep the "training" chip live
        })
        .catch((e: Error) => setError(e.message));
    load();
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="relative isolate min-h-dvh">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,oklch(0.35_0.12_300/0.22),transparent_60%)]" />
      <header className="flex items-center gap-3 border-b border-border px-4 py-4 sm:px-6">
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/" />}>
          <ArrowLeftIcon /> Studio
        </Button>
        <div className="flex items-center gap-2">
          <UsersRoundIcon className="size-4 text-primary" />
          <h1 className="text-sm font-semibold tracking-tight">Characters</h1>
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-4 sm:p-6">
        <p className="mb-5 max-w-2xl text-sm text-muted-foreground">
          Each character gets its own dataset and its own trained LoRA. Add reference photos, train v1, then feed your best
          generations back in and train again. Every version gets more consistent.
        </p>
        {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
        {data && !data.trainerInstalled && (
          <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            The LoRA trainer isn&apos;t installed yet, so you can build datasets but not train. See README → Character LoRAs.
          </p>
        )}

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <NewCharacterCard />
          {data === null && !error && (
            <div className="grid aspect-[3/4] place-items-center rounded-xl border border-border bg-card/40">
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {data?.characters.map((c) => (
            <CharacterCard
              key={c.id}
              character={c}
              trainingPct={
                data.training?.characterId === c.id
                  ? data.training.totalSteps
                    ? Math.round((data.training.step / data.training.totalSteps) * 100)
                    : 0
                  : null
              }
              onDeleted={() => setData((d) => d && { ...d, characters: d.characters.filter((x) => x.id !== c.id) })}
            />
          ))}
        </div>
      </main>
    </div>
  );
}

function CharacterCard({
  character: c,
  trainingPct,
  onDeleted,
}: {
  character: CharacterSummary;
  trainingPct: number | null;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    setDeleting(true);
    try {
      if (await deleteCharacter(c)) {
        toast(`Deleted ${c.name}.`);
        onDeleted();
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="group relative">
      <CardLink character={c} trainingPct={trainingPct} />
      {/* A sibling of the link, not inside it: a button nested in <a> is invalid and would navigate. */}
      <button
        type="button"
        onClick={remove}
        disabled={deleting || trainingPct !== null}
        aria-label={`Delete ${c.name}`}
        title={trainingPct !== null ? "Stop training before deleting" : `Delete ${c.name}`}
        className="absolute top-2 right-2 rounded-full bg-background/80 p-1.5 text-muted-foreground backdrop-blur transition hover:text-destructive focus-visible:opacity-100 disabled:opacity-40 sm:opacity-0 sm:group-hover:opacity-100"
      >
        {deleting ? <Loader2Icon className="size-3.5 animate-spin" /> : <Trash2Icon className="size-3.5" />}
      </button>
    </div>
  );
}

function CardLink({ character: c, trainingPct }: { character: CharacterSummary; trainingPct: number | null }) {
  return (
    <Link
      href={`/characters/${c.id}`}
      className="block overflow-hidden rounded-xl border border-border bg-card/60 transition hover:border-primary/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <div className="relative aspect-[3/4] bg-muted/40">
        {c.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- local dataset file
          <img src={c.coverUrl} alt="" className="size-full object-cover object-top transition group-hover:scale-[1.02]" />
        ) : (
          <div className="grid size-full place-items-center">
            <UserRoundIcon className="size-8 text-muted-foreground/50" />
          </div>
        )}
        {trainingPct !== null && (
          <Badge className="absolute top-2 left-2 gap-1 bg-fuchsia-500/90 text-white">
            <Loader2Icon className="animate-spin" /> Training {trainingPct}%
          </Badge>
        )}
      </div>
      <div className="space-y-1 p-3">
        <p className="truncate text-sm font-medium">{c.name}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">{c.trigger}</p>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Badge variant="outline">{c.imageCount} images</Badge>
          <Badge variant={c.activeVersion ? "default" : "outline"}>
            {c.activeVersion ? `LoRA v${c.activeVersion}` : "No LoRA yet"}
          </Badge>
        </div>
      </div>
    </Link>
  );
}

function NewCharacterCard() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("");
  const [triggerTouched, setTriggerTouched] = useState(false);
  const [classWord, setClassWord] = useState<string>("woman");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex aspect-[3/4] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/20 text-muted-foreground transition hover:border-primary/60 hover:bg-muted/40 hover:text-foreground"
      >
        <PlusIcon className="size-6" />
        <span className="text-sm font-medium">New character</span>
      </button>
    );
  }

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const c = await api<Character>("/api/characters", json("POST", { name, trigger, classWord }));
      router.push(`/characters/${c.id}`);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <form
      className="col-span-2 flex flex-col gap-3 rounded-xl border border-primary/40 bg-card/80 p-4 sm:col-span-1"
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <p className="text-sm font-medium">New character</p>
      <div className="space-y-1.5">
        <Label htmlFor="char-name" className="text-xs text-muted-foreground">
          Name
        </Label>
        <Input
          id="char-name"
          autoFocus
          value={name}
          placeholder="e.g. Mina"
          onChange={(e) => {
            setName(e.target.value);
            if (!triggerTouched) setTrigger(e.target.value ? suggestTrigger(e.target.value) : "");
          }}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="char-trigger" className="text-xs text-muted-foreground">
          Trigger word
        </Label>
        <Input
          id="char-trigger"
          value={trigger}
          className="font-mono text-xs"
          placeholder="mina_ob"
          onChange={(e) => {
            setTriggerTouched(true);
            setTrigger(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""));
          }}
        />
        <p className="text-[11px] leading-snug text-muted-foreground">
          A made-up word the LoRA learns as this character. Can&apos;t be changed later.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Class</Label>
        <Select value={classWord} onValueChange={(v) => v && setClassWord(String(v))}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CLASS_WORDS.map((w) => (
              <SelectItem key={w} value={w}>
                {w}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="mt-auto flex gap-2">
        <Button type="button" variant="ghost" className="flex-1" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" className="flex-1" disabled={saving || !trigger}>
          {saving ? <Loader2Icon className="animate-spin" /> : <PlusIcon />} Create
        </Button>
      </div>
    </form>
  );
}

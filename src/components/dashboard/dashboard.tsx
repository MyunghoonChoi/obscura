"use client";

import { ApertureIcon, RadioIcon, UsersRoundIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isBusy, useGeneration } from "@/hooks/use-generation";
import { api, json, trainedCheckpoint, type LibraryResponse } from "@/lib/characters/api";
import type { CharacterSummary, TrainingStatus } from "@/lib/characters/types";
import { guessPromptStyle, RESOLUTIONS } from "@/lib/comfy/presets";
import { DEFAULT_PARAMS, type GenerationParams } from "@/lib/comfy/types";

import { ControlPanel, type ComfyOptions } from "./control-panel";
import { HistoryStrip } from "./history-strip";
import { Stage, type DatasetAction } from "./stage";

const PARAMS_KEY = "obscura:params";
const OFFLINE: ComfyOptions = {
  online: false,
  checkpoints: [],
  motionModules: [],
  samplers: [],
  schedulers: [],
  remix: { missing: { motion: [], faceswap: [] }, refineAvailable: false },
};

export function Dashboard() {
  const router = useRouter();
  const [params, setParamsState] = useState<GenerationParams>(DEFAULT_PARAMS);
  const [reference, setReference] = useState<File | null>(null);
  /** Remix source clip/photo. Kept in memory only (too big for localStorage), like the reference. */
  const [source, setSource] = useState<File | null>(null);
  const [options, setOptions] = useState<ComfyOptions | null>(null);
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [training, setTraining] = useState<TrainingStatus | null>(null);
  /** Result URL → dataset add state, so a result can't be added twice by accident. */
  const [added, setAdded] = useState<Record<string, "adding" | "added">>({});
  const { job, display, viewing, history, generate, cancel, show, backToLive, clearHistory } = useGeneration();

  const setParams = useCallback((patch: Partial<GenerationParams>) => {
    setParamsState((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(PARAMS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const loadCharacters = useCallback(async () => {
    const lib = await api<LibraryResponse>("/api/characters").catch(() => null);
    if (lib) {
      setCharacters(lib.characters);
      setTraining(lib.training);
    }
    return lib;
  }, []);

  // Restore last-used params, fill model dropdowns from the live ComfyUI server, and apply
  // ?character=<id> (from a character's "Generate with" button).
  useEffect(() => {
    let cancelled = false;
    let saved: Partial<GenerationParams> = {};
    try {
      saved = JSON.parse(localStorage.getItem(PARAMS_KEY) ?? "{}");
    } catch {}
    const urlCharacter = new URLSearchParams(window.location.search).get("character");

    Promise.all([
      fetch("/api/comfy/options")
        .then((r) => r.json() as Promise<ComfyOptions>)
        .catch(() => OFFLINE),
      api<LibraryResponse>("/api/characters").catch(() => null),
    ]).then(([opts, lib]) => {
      if (cancelled) return;
      // Only consume ?character= once it has been applied (StrictMode runs this effect twice).
      if (urlCharacter) window.history.replaceState(null, "", window.location.pathname);
      setOptions(opts);
      const chars = lib?.characters ?? [];
      setCharacters(chars);
      setTraining(lib?.training ?? null);
      const pick = (current: string | undefined, list: string[]) =>
        current && list.includes(current) ? current : (list[0] ?? "");
      const fromUrl = chars.find((c) => c.id === urlCharacter);
      const characterId = fromUrl?.id ?? (chars.some((c) => c.id === saved.characterId) ? saved.characterId! : "");
      const checkpoint = trainedCheckpoint(fromUrl, opts.checkpoints) ?? pick(saved.checkpoint, opts.checkpoints);
      // Sizes saved by the old SD 1.5 build (512×768 etc.) aren't SDXL buckets; fall back to the default.
      const sdxlSize = RESOLUTIONS.some((r) => r.w === saved.width && r.h === saved.height);
      setParamsState({
        ...DEFAULT_PARAMS,
        ...saved,
        ...(!sdxlSize && { width: DEFAULT_PARAMS.width, height: DEFAULT_PARAMS.height }),
        checkpoint,
        promptStyle: saved.checkpoint === checkpoint && saved.promptStyle ? saved.promptStyle : guessPromptStyle(checkpoint),
        motionModule: pick(saved.motionModule, opts.motionModules),
        characterId,
        loraStrength: fromUrl?.loraStrength ?? saved.loraStrength ?? DEFAULT_PARAMS.loraStrength,
        useCharacterRefs: fromUrl ? !fromUrl.activeVersion : (saved.useCharacterRefs ?? DEFAULT_PARAMS.useCharacterRefs),
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // While a LoRA trains the GPU is taken; poll so the studio unlocks (and picks up the new version) when it's done.
  const isTraining = !!training;
  useEffect(() => {
    if (!isTraining) return;
    const t = setInterval(() => void loadCharacters(), 5000);
    return () => clearInterval(t);
  }, [isTraining, loadCharacters]);

  const busy = isBusy(job.status);
  const status = options === null ? "connecting" : options.online ? "online" : "offline";

  // "Add to dataset" for still images made with a character: the render's own character wins over the current pick.
  const result = display.results[0];
  const target = characters.find((c) => c.id === (display.characterId ?? params.characterId));
  let datasetAction: DatasetAction | undefined;
  if (display.status === "done" && result?.kind === "image" && target) {
    datasetAction = {
      characterName: target.name,
      state: added[result.url] ?? "idle",
      onAdd: async () => {
        setAdded((a) => ({ ...a, [result.url]: "adding" }));
        try {
          await api(`/api/characters/${target.id}/images`, json("POST", { output: result }));
          setAdded((a) => ({ ...a, [result.url]: "added" }));
          toast.success(`Added to ${target.name}'s dataset.`, {
            action: { label: "Open", onClick: () => router.push(`/characters/${target.id}`) },
          });
          void loadCharacters();
        } catch (e) {
          setAdded((a) => {
            const next = { ...a };
            delete next[result.url];
            return next;
          });
          toast.error((e as Error).message);
        }
      },
    };
  }

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh lg:flex-row lg:overflow-hidden">
      <aside className="flex w-full shrink-0 flex-col border-border bg-card/60 lg:w-[400px] lg:border-r">
        <header className="flex items-center justify-between gap-2 border-b border-border px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="grid size-8 place-items-center rounded-lg bg-linear-to-br from-violet-500 to-fuchsia-500">
              <ApertureIcon className="size-4.5 text-white" />
            </div>
            <div>
              <h1 className="text-sm leading-none font-semibold tracking-tight">Obscura</h1>
              <p className="mt-1 text-[11px] text-muted-foreground">Private ComfyUI studio</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Characters"
              title="Characters"
              nativeButton={false}
              render={<Link href="/characters" />}
            >
              <UsersRoundIcon />
            </Button>
            <Badge variant="outline" className="gap-1.5">
              <span
                data-status={status}
                className="size-1.5 rounded-full bg-muted-foreground data-[status=offline]:bg-red-400 data-[status=online]:bg-emerald-400"
              />
              {status === "connecting" ? "Connecting" : `ComfyUI ${status}`}
            </Badge>
          </div>
        </header>
        <div className="flex-1 px-5 pt-5 lg:overflow-y-auto">
          <ControlPanel
            params={params}
            setParams={setParams}
            reference={reference}
            setReference={setReference}
            source={source}
            setSource={setSource}
            options={options}
            characters={characters}
            training={training}
            onCharactersChanged={() => void loadCharacters()}
            busy={busy}
            onGenerate={() => generate(params, reference, params.mode === "remix" ? source : null)}
            onCancel={cancel}
          />
        </div>
      </aside>

      <main className="relative isolate flex min-h-[70vh] min-w-0 flex-1 flex-col gap-4 p-4 sm:p-6">
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,oklch(0.35_0.12_300/0.25),transparent_60%)]" />
        {viewing && busy && (
          <Button variant="secondary" size="sm" className="absolute top-4 left-1/2 z-10 -translate-x-1/2 shadow-lg" onClick={backToLive}>
            <RadioIcon className="text-fuchsia-400" /> Rendering in background · back to live
          </Button>
        )}
        <div className="min-h-0 flex-1">
          <Stage
            job={display}
            // Remix output follows the source's aspect ratio.
            width={params.mode === "remix" && params.sourceWidth ? params.sourceWidth : params.width}
            height={params.mode === "remix" && params.sourceHeight ? params.sourceHeight : params.height}
            datasetAction={datasetAction}
          />
        </div>
        <HistoryStrip items={history} activeId={display.promptId} onSelect={show} onClear={clearHistory} />
      </main>
    </div>
  );
}

"use client";

import { ClapperboardIcon, DicesIcon, GraduationCapIcon, ImageIcon, SparklesIcon, SquareIcon, UserRoundIcon } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { trainedCheckpoint } from "@/lib/characters/api";
import type { CharacterSummary, TrainingStatus } from "@/lib/characters/types";
import {
  ARCHITECTURES,
  motionArchitecture,
  paramsForArchitecture,
  paramsForCheckpoint,
  PROMPT_STYLES,
  VRAM_LIMITS,
  type Architecture,
  type PromptStyle,
  type VramProfile,
} from "@/lib/comfy/architectures";
import type { GenerationMode, GenerationParams } from "@/lib/comfy/types";
import { cn } from "@/lib/utils";

import { CharacterPhotos } from "./character-photos";
import { ParamSlider } from "./param-slider";
import { ReferenceDrop } from "./reference-drop";

export interface ComfyOptions {
  online: boolean;
  /** VRAM class of the ComfyUI host (server env), which caps frames and SDXL video. */
  vramProfile: VramProfile;
  checkpoints: string[];
  /** Detected per checkpoint on the server (safetensors header), so picking one switches the graph family. */
  checkpointArchitectures: Record<string, Architecture>;
  motionModules: string[];
  samplers: string[];
  schedulers: string[];
  ipAdapterPresets: string[];
}

interface ControlPanelProps {
  params: GenerationParams;
  setParams: (patch: Partial<GenerationParams>) => void;
  reference: File | null;
  setReference: (file: File | null) => void;
  options: ComfyOptions | null;
  characters: CharacterSummary[];
  /** A LoRA run holds the GPU, so generating is paused. */
  training: TrainingStatus | null;
  /** Refetch the library after photos are added from the studio. */
  onCharactersChanged: () => void;
  busy: boolean;
  onGenerate: () => void;
  onCancel: () => void;
}

export function ControlPanel({
  params: p,
  setParams,
  reference,
  setReference,
  options,
  characters,
  training,
  onCharactersChanged,
  busy,
  onGenerate,
  onCancel,
}: ControlPanelProps) {
  const isVideo = p.mode === "video";
  const character = characters.find((c) => c.id === p.characterId);
  // Starred dataset images stand in for a manual reference when a character is picked.
  const characterRefs = !reference && !!character && p.useCharacterRefs && character.refs.length > 0;
  const hasReference = !!reference || characterRefs;
  const resolutions = ARCHITECTURES[p.architecture].resolutions;
  const resolution = resolutions.find((r) => r.w === p.width && r.h === p.height)?.label ?? "custom";
  const motionModules = (options?.motionModules ?? []).filter((m) => motionArchitecture(m) === p.architecture);
  const maxFrames = VRAM_LIMITS[options?.vramProfile ?? "low"].maxFrames;
  const archDependent = { width: p.width, height: p.height, promptStyle: p.promptStyle, motionModule: p.motionModule };

  return (
    <div className="flex flex-col gap-5">
      <Tabs value={p.mode} onValueChange={(v) => setParams({ mode: v as GenerationMode })}>
        <TabsList className="w-full">
          <TabsTrigger value="video">
            <ClapperboardIcon /> Video
          </TabsTrigger>
          <TabsTrigger value="image">
            <ImageIcon /> Image
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="space-y-2">
        <Label htmlFor="prompt" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Prompt
        </Label>
        <Textarea
          id="prompt"
          value={p.prompt}
          onChange={(e) => setParams({ prompt: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy) onGenerate();
          }}
          placeholder="cinematic close-up of a woman walking through neon rain, film grain, shallow depth of field…"
          className="min-h-28 resize-none text-sm leading-relaxed"
        />
        <details className="group">
          <summary className="cursor-pointer text-xs text-muted-foreground select-none hover:text-foreground">
            Negative prompt
          </summary>
          <Textarea
            value={p.negativePrompt}
            onChange={(e) => setParams({ negativePrompt: e.target.value })}
            className="mt-2 min-h-16 resize-none text-xs"
          />
        </details>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Character</Label>
          <Link href="/characters" className="text-xs text-muted-foreground hover:text-foreground">
            Manage characters →
          </Link>
        </div>
        <CharacterSelect
          characters={characters}
          value={p.characterId}
          onChange={(id) => {
            const c = characters.find((x) => x.id === id);
            const checkpoint = trainedCheckpoint(c, options?.checkpoints ?? []);
            setParams({
              characterId: id,
              loraStrength: c?.loraStrength ?? p.loraStrength,
              // A trained LoRA carries the identity on its own; IP-Adapter on top tends to override outfits and scenes.
              useCharacterRefs: !c?.activeVersion,
              ...(checkpoint &&
                paramsForCheckpoint(checkpoint, options?.checkpointArchitectures ?? {}, archDependent, options?.motionModules ?? [])),
            });
          }}
        />
        {!character && (
          <p className="rounded-lg border border-dashed border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            {characters.length ? "Pick a character" : "Create a character"} to use many reference photos, train a LoRA on
            them and keep adding your best results.{" "}
            <Link href="/characters" className="text-primary hover:underline">
              {characters.length ? "All characters →" : "New character →"}
            </Link>
          </p>
        )}
        {character && (
          <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-3">
            <CharacterPhotos character={character} onAdded={onCharactersChanged} />
            <p className="text-xs text-muted-foreground">
              {character.activeVersion ? (
                <>
                  LoRA <b className="text-foreground">v{character.activeVersion}</b> is applied and{" "}
                  <code className="font-mono">{character.trigger}</code> is added to your prompt.
                </>
              ) : (
                <>
                  No LoRA trained yet. The face comes from{" "}
                  {character.refs.length ? `${Math.min(4, character.refs.length)} starred image(s)` : "a reference"} via
                  IP-Adapter.{" "}
                  <Link href={`/characters/${character.id}`} className="text-primary hover:underline">
                    Train v1 →
                  </Link>
                </>
              )}
            </p>
            {!!character.activeVersion && (
              <ParamSlider
                label="LoRA strength"
                hint="How strongly the character LoRA applies. 0.7–0.9 is typical; raise it if the face drifts, lower it if everything looks over-baked."
                value={p.loraStrength}
                min={0}
                max={1.5}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(loraStrength) => setParams({ loraStrength })}
              />
            )}
            {character.refs.length > 0 && (
              <label className="flex cursor-pointer items-center justify-between gap-3 text-xs">
                <span>
                  Also lock the face with starred images
                  <span className="block text-[11px] text-muted-foreground">
                    IP-Adapter on {Math.min(4, character.refs.length)} image(s).{" "}
                    {character.activeVersion
                      ? "Optional with a LoRA: steadier face, but it can override outfits and scenes."
                      : "A manual reference below replaces them."}
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={p.useCharacterRefs}
                  onChange={(e) => setParams({ useCharacterRefs: e.target.checked })}
                  className="size-4 accent-primary"
                />
              </label>
            )}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Label className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {character ? "One-off face override" : "One-off face reference"}
        </Label>
        <p className="-mt-1 text-[11px] text-muted-foreground">One image, used for this render only and not saved to a character.</p>
        <ReferenceDrop file={reference} onChange={setReference} />
        {hasReference && (
          <ParamSlider
            label="Identity strength"
            hint="IP-Adapter weight. ~0.7–1.0 keeps the face locked; higher values can over-bake the reference's pose and lighting."
            value={p.ipAdapterWeight}
            min={0}
            max={1.5}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(ipAdapterWeight) => setParams({ ipAdapterWeight })}
          />
        )}
      </div>

      <Separator />

      <div className="space-y-5">
        <ParamSlider
          label="CFG"
          hint="Classifier-free guidance: how strictly to follow the prompt. AnimateDiff likes 6–8; too high = burnt, flickery frames."
          value={p.cfg}
          min={1}
          max={20}
          step={0.5}
          format={(v) => v.toFixed(1)}
          onChange={(cfg) => setParams({ cfg })}
        />
        <ParamSlider
          label="Steps"
          hint="Sampling steps. 20–30 is the sweet spot; more costs time with diminishing returns."
          value={p.steps}
          min={4}
          max={80}
          step={1}
          onChange={(steps) => setParams({ steps })}
        />
        <ParamSlider
          label="Denoise"
          hint="1.0 = generate from pure noise. Below 1.0 (with a reference) starts from the reference image itself — lower keeps more of its composition."
          value={p.denoise}
          min={0.1}
          max={1}
          step={0.01}
          format={(v) => v.toFixed(2)}
          onChange={(denoise) => setParams({ denoise })}
          disabled={!hasReference}
        />
        {isVideo && (
          <div className="grid grid-cols-2 gap-4">
            <ParamSlider
              label="Frames"
              hint="Total frames. >16 uses sliding context windows, so length is limited by VRAM and time, not the motion model."
              value={p.frames}
              min={8}
              max={maxFrames}
              step={8}
              onChange={(frames) => setParams({ frames })}
            />
            <ParamSlider
              label="FPS"
              hint="Playback frame rate of the encoded MP4."
              value={p.fps}
              min={4}
              max={24}
              step={1}
              onChange={(fps) => setParams({ fps })}
            />
          </div>
        )}
      </div>

      <Separator />

      <div className="grid grid-cols-2 gap-3">
        <Field label="Checkpoint" className="col-span-2">
          <OptionSelect
            value={p.checkpoint}
            items={options?.checkpoints ?? []}
            placeholder="No checkpoints found"
            onChange={(checkpoint) =>
              setParams(
                paramsForCheckpoint(checkpoint, options?.checkpointArchitectures ?? {}, archDependent, options?.motionModules ?? []),
              )
            }
          />
        </Field>
        <Field label="Architecture">
          <Select
            value={p.architecture}
            onValueChange={(v) =>
              v && setParams(paramsForArchitecture(v as Architecture, archDependent, options?.motionModules ?? []))
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue>{ARCHITECTURES[p.architecture].label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(ARCHITECTURES) as Architecture[]).map((a) => (
                <SelectItem key={a} value={a}>
                  {ARCHITECTURES[a].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Prompt style">
          <Select value={p.promptStyle} onValueChange={(v) => v && setParams({ promptStyle: v as PromptStyle })}>
            <SelectTrigger className="w-full">
              <SelectValue>{PROMPT_STYLES[p.promptStyle].label}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PROMPT_STYLES) as PromptStyle[])
                .filter((s) => PROMPT_STYLES[s].architectures.includes(p.architecture))
                .map((s) => (
                  <SelectItem key={s} value={s}>
                    {PROMPT_STYLES[s].label}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Field>
        {isVideo && (
          <Field label="Motion module" className="col-span-2">
            <OptionSelect
              value={motionModules.includes(p.motionModule) ? p.motionModule : ""}
              items={motionModules}
              placeholder={`No ${ARCHITECTURES[p.architecture].label} motion module installed`}
              onChange={(motionModule) => setParams({ motionModule })}
            />
          </Field>
        )}
        <Field label="Resolution">
          <Select
            value={resolution}
            onValueChange={(v) => {
              const r = resolutions.find((x) => x.label === v);
              if (r) setParams({ width: r.w, height: r.h });
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue>{resolution === "custom" ? `${p.width}×${p.height}` : resolution}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {resolutions.map((r) => (
                <SelectItem key={r.label} value={r.label}>
                  {r.label} <span className="text-muted-foreground">{r.w}×{r.h}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Sampler">
          <OptionSelect
            value={p.sampler}
            items={options?.samplers ?? [p.sampler]}
            onChange={(sampler) => setParams({ sampler })}
          />
        </Field>
        {hasReference && (
          <Field label="IP-Adapter preset" className="col-span-2">
            <OptionSelect
              value={p.ipAdapterPreset}
              items={options?.ipAdapterPresets.length ? options.ipAdapterPresets : [p.ipAdapterPreset]}
              onChange={(ipAdapterPreset) => setParams({ ipAdapterPreset })}
            />
          </Field>
        )}
        <Field label="Seed" className="col-span-2">
          <div className="flex gap-2">
            <Input
              type="number"
              value={p.seed}
              onChange={(e) => setParams({ seed: Number(e.target.value) })}
              className="font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Random seed each run"
              title="-1 = random each run"
              onClick={() => setParams({ seed: -1 })}
            >
              <DicesIcon />
            </Button>
          </div>
        </Field>
      </div>

      <div className="sticky bottom-0 -mx-5 mt-auto border-t border-border bg-card/90 px-5 pt-4 pb-5 backdrop-blur">
        {training && !busy && (
          <Link
            href={`/characters/${training.characterId}`}
            className="mb-3 flex items-center gap-2 rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/10 px-3 py-2 text-xs text-fuchsia-200 hover:bg-fuchsia-500/15"
          >
            <GraduationCapIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              Training {characters.find((c) => c.id === training.characterId)?.name ?? training.characterId} v{training.version}
              {training.totalSteps ? ` · ${Math.round((training.step / training.totalSteps) * 100)}%` : "…"}. Generating is
              paused until it finishes.
            </span>
          </Link>
        )}
        {busy ? (
          <Button variant="secondary" className="h-11 w-full" onClick={onCancel}>
            <SquareIcon className="fill-current" /> Stop render
          </Button>
        ) : (
          <Button
            className="h-11 w-full bg-linear-to-r from-violet-500 to-fuchsia-500 text-white shadow-lg shadow-violet-500/20 hover:opacity-90"
            onClick={onGenerate}
            disabled={!options?.online || !!training}
          >
            <SparklesIcon /> Generate {isVideo ? "video" : "image"}
            <kbd className="ml-auto hidden rounded bg-white/20 px-1.5 font-mono text-[10px] sm:inline">Ctrl ↵</kbd>
          </Button>
        )}
      </div>
    </div>
  );
}

function CharacterSelect({
  characters,
  value,
  onChange,
}: {
  characters: CharacterSummary[];
  value: string;
  onChange: (id: string) => void;
}) {
  const current = characters.find((c) => c.id === value);
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE || !v ? "" : String(v))}>
      <SelectTrigger className="w-full min-w-0">
        <SelectValue>
          {current ? <CharacterOption c={current} /> : <span className="text-muted-foreground">None (prompt only)</span>}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>None (prompt only)</SelectItem>
        {characters.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            <CharacterOption c={c} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const NONE = "__none";

function CharacterOption({ c }: { c: CharacterSummary }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="grid size-5 shrink-0 place-items-center overflow-hidden rounded bg-muted">
        {c.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- local dataset file
          <img src={c.coverUrl} alt="" className="size-full object-cover object-top" />
        ) : (
          <UserRoundIcon className="size-3 text-muted-foreground" />
        )}
      </span>
      <span className="truncate">{c.name}</span>
      <span className={cn("shrink-0 font-mono text-[10px]", c.activeVersion ? "text-primary" : "text-muted-foreground")}>
        {c.activeVersion ? `v${c.activeVersion}` : "no LoRA"}
      </span>
    </span>
  );
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={className}>
      <Label className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</Label>
      {children}
    </div>
  );
}

function OptionSelect({
  value,
  items,
  placeholder = "—",
  onChange,
}: {
  value: string;
  items: string[];
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value || null} onValueChange={(v) => v && onChange(String(v))} disabled={!items.length}>
      <SelectTrigger className="w-full min-w-0">
        <SelectValue className="truncate">{value || placeholder}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item} value={item}>
            {item}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

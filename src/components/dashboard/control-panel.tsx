"use client";

import {
  ClapperboardIcon,
  DicesIcon,
  GraduationCapIcon,
  ImageIcon,
  SparklesIcon,
  SquareIcon,
  TriangleAlertIcon,
  UserRoundIcon,
  WandSparklesIcon,
} from "lucide-react";
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
import { guessPromptStyle, MAX_FRAMES, PROMPT_STYLES, RESOLUTIONS, type PromptStyle } from "@/lib/comfy/presets";
import type { GenerationMode, GenerationParams, RemixMode } from "@/lib/comfy/types";
import { cn } from "@/lib/utils";

import { CharacterPhotos } from "./character-photos";
import { ParamSlider } from "./param-slider";
import { ReferenceDrop } from "./reference-drop";
import { SourceDrop, sourceKind } from "./source-drop";

export interface ComfyOptions {
  online: boolean;
  /** SDXL / Pony checkpoints (SD 1.5 files are filtered out server-side). */
  checkpoints: string[];
  /** SDXL motion modules only. */
  motionModules: string[];
  samplers: string[];
  schedulers: string[];
  remix: { missing: Record<RemixMode, string[]>; refineAvailable: boolean };
}

const REMIX_MODES: Record<RemixMode, { label: string; hint: string }> = {
  motion: {
    label: "Motion transfer",
    hint: "Keeps the source's movement and timing. Your character, outfit and background come from the prompt.",
  },
  faceswap: {
    label: "Face swap",
    hint: "Keeps the source exactly as filmed and puts your character's face in it.",
  },
};

/** 0 keeps the source's own frame rate. */
const RESAMPLE_FPS = [0, 8, 12, 16, 24];

interface ControlPanelProps {
  params: GenerationParams;
  setParams: (patch: Partial<GenerationParams>) => void;
  reference: File | null;
  setReference: (file: File | null) => void;
  source: File | null;
  setSource: (file: File | null) => void;
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
  source,
  setSource,
  options,
  characters,
  training,
  onCharactersChanged,
  busy,
  onGenerate,
  onCancel,
}: ControlPanelProps) {
  const isRemix = p.mode === "remix";
  const isFaceSwap = isRemix && p.remixMode === "faceswap";
  const isMotion = isRemix && p.remixMode === "motion";
  const sourceIsVideo = isRemix && sourceKind(source) === "video";
  const isVideo = p.mode === "video" || sourceIsVideo;
  // Face swap runs no diffusion unless the (stills-only) refine pass is on.
  const samples = !isFaceSwap || (p.refineFace && !sourceIsVideo);
  const needsMotionModule = p.mode === "video" || (isMotion && sourceIsVideo);

  const character = characters.find((c) => c.id === p.characterId);
  const characterFaces = !reference && !!character && (p.useCharacterRefs || isRemix) && character.refs.length > 0;
  const hasFace = !!reference || characterFaces;
  const resolution = RESOLUTIONS.find((r) => r.w === p.width && r.h === p.height)?.label ?? "custom";
  const missing = isRemix ? (options?.remix.missing[p.remixMode] ?? []) : [];
  const maxFrames = isRemix ? MAX_FRAMES[p.remixMode] : MAX_FRAMES.video;

  const blocker =
    !options?.online || !!training
      ? "offline"
      : isRemix && !source
        ? "Drop a source clip or photo."
        : missing.length
          ? "This ComfyUI is missing Remix models."
          : isFaceSwap && !hasFace
            ? "Face swap needs a character with starred photos, or a one-off face."
            : null;

  return (
    <div className="flex flex-col gap-5">
      <Tabs value={p.mode} onValueChange={(v) => setParams({ mode: v as GenerationMode })}>
        <TabsList className="w-full">
          <TabsTrigger value="image">
            <ImageIcon /> Image
          </TabsTrigger>
          <TabsTrigger value="video">
            <ClapperboardIcon /> Video
          </TabsTrigger>
          <TabsTrigger value="remix">
            <WandSparklesIcon /> Remix
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {isRemix && (
        <div className="space-y-3">
          <SourceDrop
            file={source}
            onChange={setSource}
            onMeasured={(info) => setParams({ sourceWidth: info.width, sourceHeight: info.height })}
          />
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
            {(Object.keys(REMIX_MODES) as RemixMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setParams({ remixMode: m })}
                data-active={p.remixMode === m || undefined}
                className="rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground transition data-active:bg-background data-active:text-foreground data-active:shadow-sm"
              >
                {REMIX_MODES[m].label}
              </button>
            ))}
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">{REMIX_MODES[p.remixMode].hint}</p>
          {missing.length > 0 && (
            <p className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-200">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>
                This ComfyUI is missing {missing.join("; ")}. Run <code className="font-mono">setup_cloud.sh</code> on the GPU
                box.
              </span>
            </p>
          )}
        </div>
      )}

      {samples && (
        <div className="space-y-2">
          <Label htmlFor="prompt" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {isMotion ? "Outfit, background & style" : isFaceSwap ? "Face refine prompt (optional)" : "Prompt"}
          </Label>
          <Textarea
            id="prompt"
            value={p.prompt}
            onChange={(e) => setParams({ prompt: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !busy && !blocker) onGenerate();
            }}
            placeholder={
              isMotion
                ? "wearing a black leather jacket, rainy neon street at night, cinematic lighting, film grain…"
                : isFaceSwap
                  ? "detailed skin, natural lighting…"
                  : "cinematic close-up of a woman walking through neon rain, film grain, shallow depth of field…"
            }
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
      )}

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
              // A trained LoRA carries the identity on its own; FaceID on top tends to override outfits and scenes.
              useCharacterRefs: !c?.activeVersion,
              ...(checkpoint && { checkpoint, promptStyle: guessPromptStyle(checkpoint) }),
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
              {isFaceSwap ? (
                <>The face comes from {character.refs.length ? "the first starred photo" : "a starred photo (star one first)"}.</>
              ) : character.activeVersion ? (
                <>
                  LoRA <b className="text-foreground">v{character.activeVersion}</b> is applied and{" "}
                  <code className="font-mono">{character.trigger}</code> is added to your prompt.
                </>
              ) : (
                <>
                  No LoRA trained yet. The face comes from{" "}
                  {character.refs.length ? `${Math.min(4, character.refs.length)} starred photo(s)` : "a reference"} via
                  FaceID.{" "}
                  <Link href={`/characters/${character.id}`} className="text-primary hover:underline">
                    Train v1 →
                  </Link>
                </>
              )}
            </p>
            {!!character.activeVersion && samples && (
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
            {character.refs.length > 0 && !isRemix && (
              <label className="flex cursor-pointer items-center justify-between gap-3 text-xs">
                <span>
                  Also lock the face with FaceID
                  <span className="block text-[11px] text-muted-foreground">
                    On {Math.min(4, character.refs.length)} starred photo(s).{" "}
                    {character.activeVersion
                      ? "Optional with a LoRA: steadier face, but it can override outfits and scenes."
                      : "A one-off face below replaces them."}
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
        {hasFace && samples && (
          <ParamSlider
            label="Identity strength"
            hint="IP-Adapter FaceID Plus v2 weight. 0.6–1.0 keeps the face locked; higher values can fight the prompt."
            value={p.identityWeight}
            min={0}
            max={1.5}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(identityWeight) => setParams({ identityWeight })}
          />
        )}
      </div>

      <Separator />

      <div className="space-y-5">
        {isMotion && (
          <>
            <ParamSlider
              label="Pose strength"
              hint="How tightly the result follows the source's pose (OpenPose ControlNet). 0.7–1.0 is typical."
              value={p.controlStrength}
              min={0.3}
              max={1.5}
              step={0.05}
              format={(v) => v.toFixed(2)}
              onChange={(controlStrength) => setParams({ controlStrength })}
            />
            <ParamSlider
              label="New look"
              hint="1.0 redraws everything from your prompt. Lower values start from the source frames and keep more of their colours and layout."
              value={p.denoise}
              min={0.3}
              max={1}
              step={0.05}
              format={(v) => v.toFixed(2)}
              onChange={(denoise) => setParams({ denoise })}
            />
          </>
        )}
        {isFaceSwap && (
          <div className="space-y-3">
            <label
              className={cn(
                "flex cursor-pointer items-center justify-between gap-3 text-xs",
                (sourceIsVideo || !options?.remix.refineAvailable) && "cursor-not-allowed opacity-50",
              )}
            >
              <span>
                Refine the face with the character LoRA
                <span className="block text-[11px] text-muted-foreground">
                  {sourceIsVideo
                    ? "Stills only: re-sampling every frame would make the face flicker."
                    : options?.remix.refineAvailable
                      ? "FaceDetailer redraws the swapped face for skin detail and likeness."
                      : "Needs Impact Pack + a face detector (setup_cloud.sh)."}
                </span>
              </span>
              <input
                type="checkbox"
                checked={p.refineFace && !sourceIsVideo && !!options?.remix.refineAvailable}
                disabled={sourceIsVideo || !options?.remix.refineAvailable}
                onChange={(e) => setParams({ refineFace: e.target.checked })}
                className="size-4 accent-primary"
              />
            </label>
            {samples && (
              <ParamSlider
                label="Refine strength"
                hint="Denoise of the face refine pass. 0.3–0.45 adds detail without changing the swapped identity."
                value={p.refineDenoise}
                min={0.1}
                max={0.7}
                step={0.05}
                format={(v) => v.toFixed(2)}
                onChange={(refineDenoise) => setParams({ refineDenoise })}
              />
            )}
          </div>
        )}
        {samples && (
          <>
            <ParamSlider
              label="CFG"
              hint="How strictly to follow the prompt. SDXL likes 4–7; Pony 6–8. Too high looks burnt."
              value={p.cfg}
              min={1}
              max={15}
              step={0.5}
              format={(v) => v.toFixed(1)}
              onChange={(cfg) => setParams({ cfg })}
            />
            <ParamSlider
              label="Steps"
              hint="Sampling steps per pass. 25–35 is the sweet spot for SDXL."
              value={p.steps}
              min={10}
              max={80}
              step={1}
              onChange={(steps) => setParams({ steps })}
            />
          </>
        )}
        {samples && !isFaceSwap && (
          <div className="grid grid-cols-2 gap-4">
            <ParamSlider
              label="Hires fix"
              hint="Upscales the latent and samples a second pass for sharper detail. 1.0 = off. Clips cap at 1.5×."
              value={p.hiresScale}
              min={1}
              max={isVideo ? 1.5 : 2}
              step={0.25}
              format={(v) => (v > 1 ? `${v.toFixed(2)}×` : "off")}
              onChange={(hiresScale) => setParams({ hiresScale })}
            />
            <ParamSlider
              label="Hires denoise"
              hint="How much the second pass may change. 0.35–0.5 sharpens without drifting."
              value={p.hiresDenoise}
              min={0.2}
              max={0.7}
              step={0.05}
              format={(v) => v.toFixed(2)}
              onChange={(hiresDenoise) => setParams({ hiresDenoise })}
              disabled={p.hiresScale <= 1}
            />
          </div>
        )}
        {isVideo && (
          <div className="grid grid-cols-2 gap-4">
            <ParamSlider
              label={isRemix ? "Frame cap" : "Frames"}
              hint={
                isRemix
                  ? `Frames read from the source after resampling, up to ${maxFrames}. Longer clips are cut here, so split them first.`
                  : "Total frames. AnimateDiff renders them in overlapping windows, so length is limited by time, not the model."
              }
              // Remix defaults to the whole clip (0 = up to the cap); dragging sets an explicit cap.
              value={isRemix ? p.remixFrameCap || maxFrames : p.frames}
              min={8}
              max={maxFrames}
              step={8}
              format={isRemix ? (v) => (v >= maxFrames ? `${v} (max)` : String(v)) : undefined}
              onChange={(v) => setParams(isRemix ? { remixFrameCap: v } : { frames: v })}
            />
            {p.mode === "video" ? (
              <ParamSlider
                label="FPS"
                hint="Playback frame rate of the encoded MP4."
                value={p.fps}
                min={4}
                max={30}
                step={1}
                onChange={(fps) => setParams({ fps })}
              />
            ) : isMotion ? (
              <Field label="Resample to">
                <Select value={String(p.fps)} onValueChange={(v) => setParams({ fps: Number(v) })}>
                  <SelectTrigger className="w-full">
                    <SelectValue>{p.fps ? `${p.fps} fps` : "Source fps"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {RESAMPLE_FPS.map((f) => (
                      <SelectItem key={f} value={String(f)}>
                        {f ? `${f} fps` : "Source fps"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : (
              <p className="self-end text-[11px] text-muted-foreground">
                Keeps the source&apos;s fps and audio. Frames over 1920 px are scaled down.
              </p>
            )}
          </div>
        )}
      </div>

      <Separator />

      <div className="grid grid-cols-2 gap-3">
        <Field label="Checkpoint" className="col-span-2">
          <OptionSelect
            value={p.checkpoint}
            items={options?.checkpoints ?? []}
            placeholder="No SDXL checkpoints found"
            onChange={(checkpoint) => setParams({ checkpoint, promptStyle: guessPromptStyle(checkpoint) })}
          />
        </Field>
        {samples && (
          <Field label="Prompt style">
            <Select value={p.promptStyle} onValueChange={(v) => v && setParams({ promptStyle: v as PromptStyle })}>
              <SelectTrigger className="w-full">
                <SelectValue>{PROMPT_STYLES[p.promptStyle].label}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PROMPT_STYLES) as PromptStyle[]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {PROMPT_STYLES[s].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        {samples && (
          <Field label="Sampler">
            <OptionSelect value={p.sampler} items={options?.samplers ?? [p.sampler]} onChange={(sampler) => setParams({ sampler })} />
          </Field>
        )}
        {needsMotionModule && (
          <Field label="Motion module" className="col-span-2">
            <OptionSelect
              value={options?.motionModules.includes(p.motionModule) ? p.motionModule : ""}
              items={options?.motionModules ?? []}
              placeholder="No SDXL motion module installed"
              onChange={(motionModule) => setParams({ motionModule })}
            />
          </Field>
        )}
        {!isRemix && (
          <Field label="Resolution" className="col-span-2">
            <Select
              value={resolution}
              onValueChange={(v) => {
                const r = RESOLUTIONS.find((x) => x.label === v);
                if (r) setParams({ width: r.w, height: r.h });
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue>{resolution === "custom" ? `${p.width}×${p.height}` : resolution}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {RESOLUTIONS.map((r) => (
                  <SelectItem key={r.label} value={r.label}>
                    {r.label} <span className="text-muted-foreground">{r.w}×{r.h}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        {samples && (
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
        )}
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
        {blocker && blocker !== "offline" && !busy && <p className="mb-2 text-center text-[11px] text-muted-foreground">{blocker}</p>}
        {busy ? (
          <Button variant="secondary" className="h-11 w-full" onClick={onCancel}>
            <SquareIcon className="fill-current" /> Stop render
          </Button>
        ) : (
          <Button
            className="h-11 w-full bg-linear-to-r from-violet-500 to-fuchsia-500 text-white shadow-lg shadow-violet-500/20 hover:opacity-90"
            onClick={onGenerate}
            disabled={!!blocker}
          >
            <SparklesIcon /> {isRemix ? `Remix ${sourceIsVideo ? "video" : "image"}` : `Generate ${isVideo ? "video" : "image"}`}
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

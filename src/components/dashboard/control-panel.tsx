"use client";

import { ClapperboardIcon, DicesIcon, ImageIcon, SparklesIcon, SquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { GenerationMode, GenerationParams } from "@/lib/comfy/types";

import { ParamSlider } from "./param-slider";
import { ReferenceDrop } from "./reference-drop";

export interface ComfyOptions {
  online: boolean;
  checkpoints: string[];
  motionModules: string[];
  samplers: string[];
  schedulers: string[];
  ipAdapterPresets: string[];
}

const RESOLUTIONS = [
  { label: "Portrait 2:3", w: 512, h: 768 },
  { label: "Square 1:1", w: 512, h: 512 },
  { label: "Landscape 3:2", w: 768, h: 512 },
  { label: "Wide 16:9", w: 912, h: 512 },
  { label: "Tall 9:16", w: 512, h: 912 },
  { label: "SDXL 1:1", w: 1024, h: 1024 },
];

interface ControlPanelProps {
  params: GenerationParams;
  setParams: (patch: Partial<GenerationParams>) => void;
  reference: File | null;
  setReference: (file: File | null) => void;
  options: ComfyOptions | null;
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
  busy,
  onGenerate,
  onCancel,
}: ControlPanelProps) {
  const isVideo = p.mode === "video";
  const resolution = RESOLUTIONS.find((r) => r.w === p.width && r.h === p.height)?.label ?? "custom";

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
        <Label className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Character reference</Label>
        <ReferenceDrop file={reference} onChange={setReference} />
        {reference && (
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
          disabled={!reference}
        />
        {isVideo && (
          <div className="grid grid-cols-2 gap-4">
            <ParamSlider
              label="Frames"
              hint="Total frames. >16 uses sliding context windows, so length is limited by VRAM and time, not the motion model."
              value={p.frames}
              min={8}
              max={96}
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
            onChange={(checkpoint) => setParams({ checkpoint })}
          />
        </Field>
        {isVideo && (
          <Field label="Motion module" className="col-span-2">
            <OptionSelect
              value={p.motionModule}
              items={options?.motionModules ?? []}
              placeholder="AnimateDiff not installed"
              onChange={(motionModule) => setParams({ motionModule })}
            />
          </Field>
        )}
        <Field label="Resolution">
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
        <Field label="Sampler">
          <OptionSelect
            value={p.sampler}
            items={options?.samplers ?? [p.sampler]}
            onChange={(sampler) => setParams({ sampler })}
          />
        </Field>
        {reference && (
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
        {busy ? (
          <Button variant="secondary" className="h-11 w-full" onClick={onCancel}>
            <SquareIcon className="fill-current" /> Stop render
          </Button>
        ) : (
          <Button
            className="h-11 w-full bg-linear-to-r from-violet-500 to-fuchsia-500 text-white shadow-lg shadow-violet-500/20 hover:opacity-90"
            onClick={onGenerate}
            disabled={!options?.online}
          >
            <SparklesIcon /> Generate {isVideo ? "video" : "image"}
            <kbd className="ml-auto hidden rounded bg-white/20 px-1.5 font-mono text-[10px] sm:inline">Ctrl ↵</kbd>
          </Button>
        )}
      </div>
    </div>
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

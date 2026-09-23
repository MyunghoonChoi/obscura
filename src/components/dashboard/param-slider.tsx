"use client";

import { InfoIcon } from "lucide-react";

import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface ParamSliderProps {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  disabled?: boolean;
}

export function ParamSlider({ label, hint, value, min, max, step, onChange, format, disabled }: ParamSliderProps) {
  return (
    <div className="space-y-2.5" data-disabled={disabled || undefined}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Label className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</Label>
          <Tooltip>
            <TooltipTrigger render={<button type="button" aria-label={`About ${label}`} />}>
              <InfoIcon className="size-3 text-muted-foreground/60" />
            </TooltipTrigger>
            <TooltipContent className="max-w-60">{hint}</TooltipContent>
          </Tooltip>
        </div>
        <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums">
          {format ? format(value) : value}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
      />
    </div>
  );
}

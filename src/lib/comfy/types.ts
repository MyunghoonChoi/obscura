// Shared types between the dashboard UI and the ComfyUI proxy routes.

export type GenerationMode = "image" | "video";

export interface GenerationParams {
  mode: GenerationMode;
  prompt: string;
  negativePrompt: string;
  checkpoint: string;
  motionModule: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  /** 1.0 = pure noise. < 1.0 with a reference image = img2img / img2vid from the reference. */
  denoise: number;
  seed: number;
  sampler: string;
  scheduler: string;
  /** Video only */
  frames: number;
  fps: number;
  /** IP-Adapter strength applied to the reference image (0 disables the adapter). */
  ipAdapterWeight: number;
  ipAdapterPreset: string;
}

/** A file that lives on the ComfyUI server (as returned by /upload/image and /history). */
export interface ComfyFileRef {
  filename: string;
  subfolder: string;
  type: "input" | "output" | "temp";
}

export interface GenerationResult extends ComfyFileRef {
  kind: "image" | "video";
  url: string;
}

/** Events the /api/jobs/[id]/stream SSE endpoint emits to the browser. */
export type JobEvent =
  | { type: "queued"; position: number | null }
  | { type: "executing"; node: string; nodeType?: string }
  | { type: "progress"; value: number; max: number; node?: string }
  | { type: "preview"; dataUrl: string }
  | { type: "done"; results: GenerationResult[] }
  | { type: "error"; message: string };

export const DEFAULT_PARAMS: GenerationParams = {
  mode: "video",
  prompt: "",
  negativePrompt:
    "blurry, lowres, deformed face, extra fingers, watermark, text, jpeg artifacts",
  checkpoint: "",
  motionModule: "",
  width: 512,
  height: 768,
  steps: 25,
  cfg: 7,
  denoise: 1,
  seed: -1,
  sampler: "euler_ancestral",
  scheduler: "normal",
  frames: 16,
  fps: 8,
  ipAdapterWeight: 0.85,
  ipAdapterPreset: "PLUS FACE (portraits)",
};

// Shared types between the dashboard UI and the ComfyUI proxy routes.

import type { GenerationMode, PromptStyle, RemixMode } from "./presets";

export type { GenerationMode, PromptStyle, RemixMode } from "./presets";

export interface GenerationParams {
  /** image / video = generate from the prompt; remix = edit an uploaded source clip or photo. */
  mode: GenerationMode;
  /**
   * The user's own text only. Trigger words and style tags are kept out of it and composed
   * server-side (see composePrompts), so any prompt text goes through unchanged.
   */
  prompt: string;
  negativePrompt: string;
  /** An SDXL / Pony checkpoint. */
  checkpoint: string;
  /** Fine-tune prompt conventions (e.g. Pony score tags + clip skip). */
  promptStyle: PromptStyle;
  /** SDXL AnimateDiff module (mm_sdxl_v10_beta or HotshotXL). */
  motionModule: string;
  /** Output size for image/video; snapped to the nearest SDXL bucket. Remix derives it from the source. */
  width: number;
  height: number;
  steps: number;
  cfg: number;
  seed: number;
  sampler: string;
  scheduler: string;
  /** Video: frames to generate. */
  frames: number;
  /** Video: playback rate. Remix motion: rate the source is resampled to (0 = keep the source's). */
  fps: number;
  /** Second sampling pass on an upscaled latent ("hires fix"). 1 = off. */
  hiresScale: number;
  hiresDenoise: number;
  /** IP-Adapter FaceID Plus v2 strength on the reference face(s). 0 disables it. */
  identityWeight: number;
  /** Character from the library ("" = none): adds its LoRA + trigger word to the graph. */
  characterId: string;
  loraStrength: number;
  /** Feed the character's starred dataset images to FaceID (when no one-off face reference is set). */
  useCharacterRefs: boolean;
  /** Image/Video: finish by pasting the reference face on with ReActor (exact likeness); stills also get refineFace. */
  faceSwapAfter: boolean;

  // ── Remix ──
  remixMode: RemixMode;
  /** OpenPose ControlNet strength (motion transfer). */
  controlStrength: number;
  /** Motion transfer: 1 = redraw everything from the prompt; lower keeps more of the source's colours/layout. */
  denoise: number;
  /** Face swap: refine the swapped face with the character LoRA + FaceID (stills only, see workflow.ts). */
  refineFace: boolean;
  refineDenoise: number;
  /** Remix video: frames read from the source (after resampling). 0 = the whole clip, up to MAX_FRAMES. */
  remixFrameCap: number;
  /** Source dimensions as measured by the browser; used to pick the SDXL bucket. */
  sourceWidth: number;
  sourceHeight: number;
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
  mode: "image",
  prompt: "",
  negativePrompt: "blurry, lowres, deformed face, bad anatomy, extra fingers, watermark, text, jpeg artifacts",
  checkpoint: "",
  promptStyle: "none",
  motionModule: "",
  width: 832,
  height: 1216,
  steps: 30,
  cfg: 6,
  seed: -1,
  sampler: "dpmpp_2m",
  scheduler: "karras",
  frames: 48,
  fps: 12,
  hiresScale: 1.5,
  hiresDenoise: 0.45,
  identityWeight: 0.8,
  characterId: "",
  loraStrength: 0.8,
  useCharacterRefs: true,
  faceSwapAfter: true,
  remixMode: "motion",
  controlStrength: 0.9,
  denoise: 1,
  refineFace: true,
  refineDenoise: 0.35,
  remixFrameCap: 0,
  sourceWidth: 0,
  sourceHeight: 0,
};

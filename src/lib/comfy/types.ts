// Shared types between the dashboard UI and the ComfyUI proxy routes.

import type { GenerationMode, PromptStyle, RemixMode } from "./presets";
import { UPSCALE, WAN_LENGTH } from "./presets";

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
  /** An SDXL / Pony checkpoint: every still, including the first frame of every video, comes from it. */
  checkpoint: string;
  /** Fine-tune prompt conventions (e.g. Pony score tags + clip skip). */
  promptStyle: PromptStyle;
  /** Output size for image/video; snapped to the nearest SDXL (stills) or Wan (video) bucket. Remix derives it from the source. */
  width: number;
  height: number;
  /** SDXL still pass (and the upscale / refine passes that reuse them). Video sampling has fixed Wan settings. */
  steps: number;
  cfg: number;
  seed: number;
  sampler: string;
  scheduler: string;
  /** Video: Wan clip length in frames (4n+1, 16 fps). Remix motion transfer on a clip uses it as the length too. */
  frames: number;
  /** Stills: pixel upscale factor (UltimateSDUpscale). 1 = off. */
  upscale: number;
  /** Denoise of each upscale tile's re-sampling pass: adds detail without changing the picture. */
  upscaleDenoise: number;
  /** IP-Adapter FaceID Plus v2 strength on the reference face(s). 0 disables it. */
  identityWeight: number;
  /** Character from the library ("" = none): adds its LoRA + trigger word to the graph. */
  characterId: string;
  loraStrength: number;
  /** Feed the character's starred dataset images to FaceID (when no one-off face reference is set). */
  useCharacterRefs: boolean;
  /**
   * Finish stills (and the first frame of videos) with a FaceDetailer pass driven by the character LoRA
   * + FaceID (weight 0.85, denoise refineDenoise). No ReActor involved; that is Remix › Face swap only.
   */
  faceRefine: boolean;

  // ── Remix ──
  remixMode: RemixMode;
  /** ControlNet strength on stills (OpenPose), VACE control strength on clips. */
  controlStrength: number;
  /** Motion transfer on a still ("New look"): 1 = redraw everything from the prompt; ~0.55 keeps the source's composition and lighting and changes outfit/background to taste. */
  denoise: number;
  /** Denoise of the face refine pass (Image / Video / Motion transfer): keeps the face, sharpens the likeness. */
  refineDenoise: number;
  /** Denoise of the photo face swap (FaceDetailer replacing the identity): high enough to change who it is, ~0.6. */
  swapDenoise: number;
  /** Face-swap video: frames read from the source. 0 = the whole clip, up to FACESWAP_MAX_FRAMES. */
  remixFrameCap: number;
  /** Source dimensions as measured by the browser; used to pick the output bucket. */
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
  | { type: "done"; results: GenerationResult[]; warnings?: string[] }
  | { type: "error"; message: string };

export const DEFAULT_PARAMS: GenerationParams = {
  mode: "image",
  prompt: "",
  negativePrompt: "blurry, lowres, deformed face, bad anatomy, extra fingers, watermark, text, jpeg artifacts",
  checkpoint: "",
  promptStyle: "none",
  width: 832,
  height: 1216,
  steps: 30,
  cfg: 6,
  seed: -1,
  sampler: "dpmpp_2m",
  scheduler: "karras",
  frames: WAN_LENGTH.default,
  upscale: UPSCALE.defaultFactor,
  upscaleDenoise: UPSCALE.defaultDenoise,
  identityWeight: 0.8,
  characterId: "",
  loraStrength: 0.8,
  useCharacterRefs: true,
  faceRefine: true,
  remixMode: "motion",
  controlStrength: 0.85,
  denoise: 0.55,
  refineDenoise: 0.4,
  swapDenoise: 0.6,
  remixFrameCap: 0,
  sourceWidth: 0,
  sourceHeight: 0,
};

// Generation presets shared by the UI and the server (no server-only imports here).
// Stills: SDXL / Pony. Video: Wan 2.1 14B (I2V for the Video tab, VACE for motion transfer),
// always seeded from an SDXL still so the character LoRA decides what the person looks like.

export type PromptStyle = "none" | "pony";
export type GenerationMode = "image" | "video" | "remix";
/** Genjutsu-style edits of an uploaded clip or photo. */
export type RemixMode = "motion" | "faceswap";

export interface Resolution {
  label: string;
  w: number;
  h: number;
}

/** SDXL was trained on ~1 MP aspect buckets; off-bucket sizes cause duplicated limbs and framing errors. */
export const RESOLUTIONS: Resolution[] = [
  { label: "Portrait 2:3", w: 832, h: 1216 },
  { label: "Portrait 3:4", w: 896, h: 1152 },
  { label: "Square 1:1", w: 1024, h: 1024 },
  { label: "Landscape 3:2", w: 1216, h: 832 },
  { label: "Wide 16:9", w: 1344, h: 768 },
  { label: "Tall 9:16", w: 768, h: 1344 },
];

const SDXL_BUCKETS: [number, number][] = [
  [640, 1536], [704, 1472], [768, 1344], [832, 1216], [896, 1152], [960, 1088], [1024, 1024],
  [1088, 960], [1152, 896], [1216, 832], [1344, 768], [1472, 704], [1536, 640],
];

const nearest = (buckets: [number, number][], width: number, height: number) => {
  const target = Math.log(width / height);
  return buckets.reduce((best, b) =>
    Math.abs(Math.log(b[0] / b[1]) - target) < Math.abs(Math.log(best[0] / best[1]) - target) ? b : best,
  );
};

/** The SDXL bucket with the closest aspect ratio, e.g. a 1920×1080 source renders at 1344×768. */
export function fitResolution(width: number, height: number): { width: number; height: number } {
  if (!(width > 0 && height > 0)) return { width: 832, height: 1216 };
  const [w, h] = nearest(SDXL_BUCKETS, width, height);
  return { width: w, height: h };
}

/** Wan 2.1 720p sizes (multiples of 16, ~0.9 MP), matching what the 720p models were trained on. */
const WAN_SIZES: [number, number][] = [[720, 1280], [832, 1120], [960, 960], [1120, 832], [1280, 720]];

export function fitWanResolution(width: number, height: number): { width: number; height: number } {
  if (!(width > 0 && height > 0)) return { width: 720, height: 1280 };
  const [w, h] = nearest(WAN_SIZES, width, height);
  return { width: w, height: h };
}

/** Wan generates 4n+1 frames at 16 fps; 81 (≈5 s) is the length the 720p models were trained on. */
export const WAN_FPS = 16;
export const WAN_LENGTH = { default: 81, min: 17, max: 121 };
export const snapWanLength = (n: number) =>
  Math.min(WAN_LENGTH.max, Math.max(WAN_LENGTH.min, 4 * Math.round((n - 1) / 4) + 1));

/** Sampling settings from ComfyUI's reference Wan 2.1 workflows (ComfyUI_examples/wan). */
export const WAN_SAMPLING = { steps: 20, cfg: 6, sampler: "uni_pc", scheduler: "simple", shift: 8 } as const;

/** The negative prompt Wan 2.1 ships with in those workflows; the model was tuned against it. */
export const WAN_NEGATIVE =
  "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走";

export const PROMPT_STYLES: Record<PromptStyle, { label: string; positive: string; negative: string; clipSkip?: number }> = {
  none: { label: "None", positive: "", negative: "" },
  // Pony Diffusion V6 XL was trained with quality "score" tags and on the penultimate CLIP layer.
  pony: {
    label: "Pony (score tags)",
    positive: "score_9, score_8_up, score_7_up",
    negative: "score_6, score_5, score_4",
    clipSkip: -2,
  },
};

export function guessPromptStyle(checkpoint: string): PromptStyle {
  return /pony/i.test(checkpoint) ? "pony" : "none";
}

/** Pixel upscale of stills (UltimateSDUpscale over a 4x-UltraSharp pass): factor and tile re-sampling denoise. */
export const UPSCALE = { min: 1, max: 3, step: 0.5, defaultFactor: 2, defaultDenoise: 0.3 };

/** Frame cap for face swap: VHS holds every frame in RAM as float32 (~25 MB per 1080p frame, twice over). */
export const FACESWAP_MAX_FRAMES = 360;

/** Largest accepted Remix source upload. Matches experimental.proxyClientMaxBodySize in next.config.ts. */
export const MAX_SOURCE_BYTES = 500 * 1024 * 1024;

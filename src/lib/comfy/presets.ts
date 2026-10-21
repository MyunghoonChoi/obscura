// SDXL-only generation presets shared by the UI and the server (no server-only imports here).
// Obscura targets cloud GPUs (24–48 GB+) running SDXL / Pony V6 XL; there is no SD 1.5 path.

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

/** The SDXL bucket with the closest aspect ratio, e.g. a 1920×1080 source renders at 1344×768. */
export function fitResolution(width: number, height: number): { width: number; height: number } {
  if (!(width > 0 && height > 0)) return { width: 832, height: 1216 };
  const target = Math.log(width / height);
  const [w, h] = SDXL_BUCKETS.reduce((best, b) =>
    Math.abs(Math.log(b[0] / b[1]) - target) < Math.abs(Math.log(best[0] / best[1]) - target) ? b : best,
  );
  return { width: w, height: h };
}

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

/** SDXL AnimateDiff modules: mm_sdxl_v10_beta (16-frame windows) and HotshotXL (8-frame windows). */
export function isSdxlMotionModule(name: string): boolean {
  return /sdxl|hsxl|hotshot/i.test(name);
}

export function motionContextLength(motionModule: string): number {
  return /hsxl|hotshot/i.test(motionModule) ? 8 : 16;
}

/**
 * Frame caps per job type. Face swap runs no diffusion, but VHS holds every source frame in RAM as
 * float32 (~25 MB per 1080p frame, and ReActor makes a second copy), so 360 ≈ 12 s at 30 fps.
 */
export const MAX_FRAMES: Record<"video" | RemixMode, number> = { video: 192, motion: 240, faceswap: 360 };

/** Largest accepted Remix source upload. Matches experimental.proxyClientMaxBodySize in next.config.ts. */
export const MAX_SOURCE_BYTES = 500 * 1024 * 1024;

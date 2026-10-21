// Model-architecture knowledge shared by the UI and the server (no server-only imports here).
//
// Two independent axes decide how a graph is built:
//   architecture — which UNet/CLIP family the checkpoint is (SD1.5 vs SDXL). Changes nodes and resolution.
//   promptStyle  — conventions of a fine-tune on top of that (e.g. Pony's score tags + clip skip 2).
// A third axis, the VRAM profile, belongs to the ComfyUI host and is set server-side (COMFY_VRAM_PROFILE).

export type Architecture = "sd15" | "sdxl";
export type PromptStyle = "none" | "pony";
/** low ≈ 8–12 GB consumer card (local testing); high ≈ 24 GB+ (A5000 / A100 / cloud). */
export type VramProfile = "low" | "high";

export interface Resolution {
  label: string;
  w: number;
  h: number;
}

export const ARCHITECTURES: Record<Architecture, { label: string; resolutions: Resolution[] }> = {
  sd15: {
    label: "SD 1.5",
    resolutions: [
      { label: "Portrait 2:3", w: 512, h: 768 },
      { label: "Square 1:1", w: 512, h: 512 },
      { label: "Landscape 3:2", w: 768, h: 512 },
      { label: "Wide 16:9", w: 912, h: 512 },
      { label: "Tall 9:16", w: 512, h: 912 },
    ],
  },
  sdxl: {
    label: "SDXL / Pony",
    // SDXL was trained on ~1 MP aspect buckets; off-bucket sizes cause duplicated limbs and framing errors.
    resolutions: [
      { label: "Portrait 2:3", w: 832, h: 1216 },
      { label: "Portrait 3:4", w: 896, h: 1152 },
      { label: "Square 1:1", w: 1024, h: 1024 },
      { label: "Landscape 3:2", w: 1216, h: 832 },
      { label: "Wide 16:9", w: 1344, h: 768 },
      { label: "Tall 9:16", w: 768, h: 1344 },
    ],
  },
};

/** SDXL training buckets (all ≈1 MP, multiples of 64). */
const SDXL_BUCKETS: [number, number][] = [
  [640, 1536], [704, 1472], [768, 1344], [832, 1216], [896, 1152], [960, 1088], [1024, 1024],
  [1088, 960], [1152, 896], [1216, 832], [1344, 768], [1472, 704], [1536, 640],
];

/**
 * The size actually rendered. SD1.5 keeps the request (snapped to 8); SDXL snaps to the bucket with the
 * closest aspect ratio, so an SD1.5-style 512×768 request becomes 832×1216 instead of a blurry sub-MP image.
 */
export function fitResolution(arch: Architecture, width: number, height: number): { width: number; height: number } {
  if (arch === "sd15") return { width: Math.round(width / 8) * 8, height: Math.round(height / 8) * 8 };
  const target = Math.log(width / height);
  const [w, h] = SDXL_BUCKETS.reduce((best, b) =>
    Math.abs(Math.log(b[0] / b[1]) - target) < Math.abs(Math.log(best[0] / best[1]) - target) ? b : best,
  );
  return { width: w, height: h };
}

export const PROMPT_STYLES: Record<
  PromptStyle,
  { label: string; positive: string; negative: string; clipSkip?: number; architectures: Architecture[] }
> = {
  none: { label: "None", positive: "", negative: "", architectures: ["sd15", "sdxl"] },
  // Pony Diffusion V6 XL was trained with quality "score" tags and on the penultimate CLIP layer.
  pony: {
    label: "Pony (score tags)",
    positive: "score_9, score_8_up, score_7_up",
    negative: "score_6, score_5, score_4",
    clipSkip: -2,
    architectures: ["sdxl"],
  },
};

/** Best guess from a checkpoint file name; the server refines it from the file header when it can read it. */
export function guessArchitecture(checkpoint: string): Architecture {
  return /xl|pony|illustrious|noob|animagine/i.test(checkpoint) ? "sdxl" : "sd15";
}

export function guessPromptStyle(checkpoint: string): PromptStyle {
  return /pony/i.test(checkpoint) ? "pony" : "none";
}

/** AnimateDiff motion modules are architecture-specific: SD1.5 (v2/v3) vs SDXL (mm_sdxl beta, HotshotXL). */
export function motionArchitecture(motionModule: string): Architecture {
  return /sdxl|hsxl|hotshot/i.test(motionModule) ? "sdxl" : "sd15";
}

/** Sliding-window size each motion module was trained on. HotshotXL's sweet spot is 8 frames, the rest 16. */
export function motionContextLength(motionModule: string): number {
  return /hsxl|hotshot/i.test(motionModule) ? 8 : 16;
}

/** The preset of an architecture whose aspect ratio is closest to the current size. */
export function nearestPreset(arch: Architecture, width: number, height: number): Resolution {
  const target = Math.log(width / height);
  return ARCHITECTURES[arch].resolutions.reduce((best, r) =>
    Math.abs(Math.log(r.w / r.h) - target) < Math.abs(Math.log(best.w / best.h) - target) ? r : best,
  );
}

interface ArchDependent {
  architecture: Architecture;
  promptStyle: PromptStyle;
  width: number;
  height: number;
  motionModule: string;
}

/** Everything that has to follow when the graph family changes: size preset, prompt style, motion module. */
export function paramsForArchitecture(
  architecture: Architecture,
  current: Omit<ArchDependent, "architecture">,
  motionModules: string[],
): ArchDependent {
  const size = nearestPreset(architecture, current.width, current.height);
  const promptStyle = PROMPT_STYLES[current.promptStyle].architectures.includes(architecture) ? current.promptStyle : "none";
  const motionModule =
    motionArchitecture(current.motionModule) === architecture
      ? current.motionModule
      : (motionModules.find((m) => motionArchitecture(m) === architecture) ?? current.motionModule);
  return { architecture, promptStyle, width: size.w, height: size.h, motionModule };
}

/** Picking a checkpoint picks its architecture (from the server's header check) and, for Pony, its prompt style. */
export function paramsForCheckpoint(
  checkpoint: string,
  checkpointArchitectures: Record<string, Architecture>,
  current: Omit<ArchDependent, "architecture">,
  motionModules: string[],
): ArchDependent & { checkpoint: string } {
  const architecture = checkpointArchitectures[checkpoint] ?? guessArchitecture(checkpoint);
  const promptStyle = architecture === "sdxl" ? guessPromptStyle(checkpoint) : "none";
  return { checkpoint, ...paramsForArchitecture(architecture, { ...current, promptStyle }, motionModules) };
}

export const VRAM_LIMITS: Record<VramProfile, { maxFrames: number; sdxlVideo: boolean }> = {
  low: { maxFrames: 96, sdxlVideo: false },
  high: { maxFrames: 128, sdxlVideo: true },
};

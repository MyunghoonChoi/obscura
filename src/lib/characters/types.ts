// Shared types for the character library and LoRA training (UI ↔ API).

export const CLASS_WORDS = ["woman", "man", "girl", "boy", "person"] as const;

/** One trained LoRA file. Versions only ever grow: v1, v2, … each trained on the dataset as it was then. */
export interface LoraVersion {
  version: number;
  /** File name relative to ComfyUI's models/loras folder, e.g. "obscura/mina_v2.safetensors". */
  loraFile: string;
  createdAt: number;
  imageCount: number;
  steps: number;
  preset: TrainingPreset;
  checkpoint: string;
  /** Model family the LoRA loads into. Missing = trained before the SDXL switch (SD 1.5, no longer loadable). */
  architecture?: "sd15" | "sdxl";
}

export interface Character {
  /** Folder slug, also used in URLs. */
  id: string;
  name: string;
  /** Rare token the LoRA binds the identity to. Fixed at creation because captions embed it. */
  trigger: string;
  classWord: string;
  /** Default LoRA strength when generating with this character. */
  loraStrength: number;
  /** Version used for generation; null = none trained yet (IP-Adapter only). */
  activeVersion: number | null;
  versions: LoraVersion[];
  /** Dataset file names used as IP-Adapter face references (first = cover). */
  refs: string[];
  createdAt: number;
}

export interface DatasetImage {
  name: string;
  caption: string;
  starred: boolean;
  addedAt: number;
  url: string;
}

export interface CharacterSummary extends Character {
  imageCount: number;
  coverUrl: string | null;
}

export interface CharacterDetail extends Character {
  images: DatasetImage[];
  lastRun: RunResult | null;
}

export type TrainingPreset = "quick" | "standard" | "thorough";

/** SDXL LoRA batch size on a 24 GB card (1024px, gradient checkpointing). Bigger GPUs scale it up; see runner.ts. */
export const TRAINING_BATCH_SIZE = 4;

export const TRAINING_PRESETS: Record<TrainingPreset, { label: string; views: number; epochs: number; hint: string }> = {
  quick: { label: "Quick", views: 1600, epochs: 8, hint: "First draft. Good for checking the dataset works." },
  standard: { label: "Standard", views: 3000, epochs: 10, hint: "Balanced. Start here once you have 15+ images." },
  thorough: { label: "Thorough", views: 5000, epochs: 10, hint: "More detail, but can over-bake small datasets." },
};

export type TrainingPhase = "starting" | "loading" | "caching" | "training" | "saving";

/** Free space on the volume that holds characters, LoRAs and models (so you know when to grow it). */
export interface DiskInfo {
  freeGb: number;
  totalGb: number;
}

/** A run in progress (at most one at a time — the GPU is shared with ComfyUI). */
export interface TrainingStatus {
  characterId: string;
  version: number;
  preset: TrainingPreset;
  startedAt: number;
  phase: TrainingPhase;
  step: number;
  totalSteps: number;
  /** tqdm's own remaining-time estimate, e.g. "06:12". */
  eta?: string;
  loss?: number;
  logTail: string[];
}

/** How the most recent run of a character ended (kept until the next run starts). */
export interface RunResult {
  version: number;
  state: "done" | "error" | "stopped";
  finishedAt: number;
  message?: string;
  logTail?: string[];
}

import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { CHECKPOINT_DIR } from "@/lib/paths";

import { guessArchitecture, type Architecture, type VramProfile } from "./architectures";

/** VRAM class of the ComfyUI host. Set COMFY_VRAM_PROFILE=high on 24 GB+ cloud GPUs. */
export const VRAM_PROFILE: VramProfile = process.env.COMFY_VRAM_PROFILE === "high" ? "high" : "low";

const cache = new Map<string, { mtimeMs: number; arch: Architecture }>();

/**
 * Architecture of a checkpoint. Reads the safetensors header (tensor names only, a few hundred KB)
 * when the file is on this machine, and falls back to the file name when it isn't (remote ComfyUI,
 * .ckpt pickles).
 */
export async function checkpointArchitecture(name: string): Promise<Architecture> {
  const file = path.join(CHECKPOINT_DIR, name);
  const stat = name.includes("..") ? null : await fs.stat(file).catch(() => null);
  if (!stat?.isFile() || !/\.safetensors$/i.test(name)) return guessArchitecture(name);

  const hit = cache.get(file);
  if (hit?.mtimeMs === stat.mtimeMs) return hit.arch;

  let arch = guessArchitecture(name);
  const fh = await fs.open(file, "r");
  try {
    const len = Buffer.alloc(8);
    await fh.read(len, 0, 8, 0);
    const headerLen = Number(len.readBigUInt64LE());
    if (headerLen > 0 && headerLen < 64 * 1024 * 1024) {
      const header = Buffer.alloc(headerLen);
      await fh.read(header, 0, headerLen, 8);
      const keys = header.toString("utf8");
      // SDXL checkpoints carry a second text encoder (OpenCLIP bigG) under conditioner.embedders.1.
      if (keys.includes('"conditioner.embedders.1.')) arch = "sdxl";
      else if (keys.includes('"cond_stage_model.')) arch = "sd15";
    }
  } finally {
    await fh.close();
  }
  cache.set(file, { mtimeMs: stat.mtimeMs, arch });
  return arch;
}

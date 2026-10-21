import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { CHECKPOINT_DIR } from "@/lib/paths";

import { getNodeSpec, listNodeOptions } from "./client";
import type { RemixModels } from "./workflow";

type Family = "sdxl" | "sd15" | "unknown";
const cache = new Map<string, { mtimeMs: number; family: Family }>();

/**
 * Model family of a checkpoint, read from the safetensors header (tensor names only, a few hundred KB).
 * "unknown" when the file isn't on this machine or isn't a safetensors file; callers then trust the name.
 */
export async function checkpointFamily(name: string): Promise<Family> {
  const file = path.join(CHECKPOINT_DIR, name);
  const stat = name.includes("..") ? null : await fs.stat(file).catch(() => null);
  if (!stat?.isFile() || !/\.safetensors$/i.test(name)) return "unknown";

  const hit = cache.get(file);
  if (hit?.mtimeMs === stat.mtimeMs) return hit.family;

  let family: Family = "unknown";
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
      if (keys.includes('"conditioner.embedders.1.')) family = "sdxl";
      else if (keys.includes('"cond_stage_model.')) family = "sd15";
    }
  } finally {
    await fh.close();
  }
  cache.set(file, { mtimeMs: stat.mtimeMs, family });
  return family;
}

/** Checkpoints this pipeline can use: everything except files we can positively identify as SD 1.5. */
export async function sdxlCheckpoints(): Promise<string[]> {
  const all = await listNodeOptions("CheckpointLoaderSimple", "ckpt_name");
  const families = await Promise.all(all.map(checkpointFamily));
  return all.filter((_, i) => families[i] !== "sd15");
}

const best = (options: string[], ...preferences: RegExp[]) => {
  for (const re of preferences) {
    const hit = options.find((o) => re.test(o));
    if (hit) return hit;
  }
  return undefined;
};

export interface RemixAvailability {
  models: RemixModels;
  /** What each Remix mode still lacks on this ComfyUI (empty = ready). setup_cloud.sh installs all of it. */
  missing: { motion: string[]; faceswap: string[] };
  /** Face-swap refine (FaceDetailer + face detector) is optional; the swap itself works without it. */
  refineAvailable: boolean;
}

/** Finds the best installed model for each Remix role and reports anything missing per mode. */
export async function remixAvailability(): Promise<RemixAvailability> {
  const [controlNets, swapModels, restorers, detectors, dwpose, faceIdLoader, faceDetailer] = await Promise.all([
    listNodeOptions("ControlNetLoader", "control_net_name"),
    listNodeOptions("ReActorFaceSwap", "swap_model"),
    listNodeOptions("ReActorFaceSwap", "face_restore_model"),
    listNodeOptions("UltralyticsDetectorProvider", "model_name"),
    getNodeSpec("DWPreprocessor"),
    getNodeSpec("IPAdapterUnifiedLoaderFaceID"),
    getNodeSpec("FaceDetailer"),
  ]);

  const models: RemixModels = {
    controlNet: best(controlNets, /openpose.*(xl|sdxl)|xinsir.*openpose|(xl|sdxl).*openpose/i),
    swapModel: best(swapModels, /hyperswap_1b/i, /hyperswap/i, /reswapper_256/i, /inswapper_128/i, /./),
    faceRestore: best(restorers, /codeformer/i, /GFPGANv1\.4/i, /GPEN/i) ?? "none",
    faceDetector: best(detectors, /bbox\/face_yolov8m/i, /bbox\/face_yolo/i),
  };

  const motion: string[] = [];
  if (!dwpose) motion.push("comfyui_controlnet_aux (DWPreprocessor)");
  if (!models.controlNet) motion.push("an SDXL OpenPose ControlNet in models/controlnet");
  if (!faceIdLoader) motion.push("ComfyUI_IPAdapter_plus (FaceID)");

  const faceswap: string[] = [];
  if (!models.swapModel) faceswap.push("ComfyUI-ReActor with a swap model (models/insightface, reswapper or hyperswap)");

  return { models, missing: { motion, faceswap }, refineAvailable: !!(faceDetailer && faceIdLoader && models.faceDetector) };
}

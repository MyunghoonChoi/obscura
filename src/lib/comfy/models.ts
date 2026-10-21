import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { CHECKPOINT_DIR } from "@/lib/paths";

import { getNodeSpec, listNodeOptions } from "./client";
import type { PipelineModels } from "./workflow";

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

/**
 * The checkpoint the studio starts on. OBSCURA_DEFAULT_CHECKPOINT wins when installed; otherwise
 * Pony V6 XL, then the first file. Never "whatever sorts first".
 */
export function defaultCheckpoint(checkpoints: string[]): string {
  const wanted = process.env.OBSCURA_DEFAULT_CHECKPOINT;
  if (wanted && checkpoints.includes(wanted)) return wanted;
  return checkpoints.find((c) => /pony/i.test(c)) ?? checkpoints[0] ?? "";
}

const best = (options: string[], ...preferences: RegExp[]) => {
  for (const re of preferences) {
    const hit = options.find((o) => re.test(o));
    if (hit) return hit;
  }
  return undefined;
};

export type Capability = "video" | "motion" | "motionVideo" | "faceswap" | "faceswapPhoto" | "upscale";

export interface PipelineAvailability {
  models: PipelineModels;
  /** What each capability still lacks on this ComfyUI (empty = ready). setup_cloud.sh installs all of it. */
  missing: Record<Capability, string[]>;
  /** Face refine (FaceDetailer + face detector) is optional; the swap itself works without it. */
  refineAvailable: boolean;
}

/** Finds the best installed model for each role and reports what every capability is missing. */
export async function pipelineAvailability(): Promise<PipelineAvailability> {
  const [controlNets, swapModels, restorers, detectors, upscalers, unets, clips, vaes, clipVisions, nodes] = await Promise.all([
    listNodeOptions("ControlNetLoader", "control_net_name"),
    listNodeOptions("ReActorFaceSwap", "swap_model"),
    listNodeOptions("ReActorFaceSwap", "face_restore_model"),
    listNodeOptions("UltralyticsDetectorProvider", "model_name"),
    listNodeOptions("UpscaleModelLoader", "model_name"),
    listNodeOptions("UNETLoader", "unet_name"),
    listNodeOptions("CLIPLoader", "clip_name"),
    listNodeOptions("VAELoader", "vae_name"),
    listNodeOptions("CLIPVisionLoader", "clip_name"),
    Promise.all(
      ["DWPreprocessor", "IPAdapterUnifiedLoaderFaceID", "FaceDetailer", "UltimateSDUpscale", "ReActorFaceBoost", "WanImageToVideo", "WanVaceToVideo"].map(
        async (n) => [n, !!(await getNodeSpec(n))] as const,
      ),
    ).then((pairs) => Object.fromEntries(pairs) as Record<string, boolean>),
  ]);

  const models: PipelineModels = {
    controlNet: best(controlNets, /openpose.*(xl|sdxl)|xinsir.*openpose|(xl|sdxl).*openpose/i),
    tileControlNet: best(controlNets, /tile.*(xl|sdxl)|(xl|sdxl).*tile/i),
    swapModel: best(swapModels, /hyperswap_1b/i, /hyperswap/i, /reswapper_256/i, /inswapper_128/i, /./),
    faceRestore: best(restorers, /codeformer/i, /GFPGANv1\.4/i, /GPEN/i) ?? "none",
    faceDetector: best(detectors, /bbox\/face_yolov8m/i, /bbox\/face_yolo/i),
    upscaler: best(upscalers, /4x-UltraSharp/i, /UltraSharp/i, /ESRGAN_4x|4x_ESRGAN/i, /4x/i),
    usdu: nodes.UltimateSDUpscale,
    wanI2V: best(unets, /wan2\.1_i2v_720p_14B.*fp16/i, /wan2\.1_i2v_720p_14B/i, /wan2\.1_i2v.*14B/i),
    wanVace: best(unets, /wan2\.1_vace_14B/i, /vace.*14B/i),
    wanTextEncoder: best(clips, /umt5_xxl.*fp8.*scaled/i, /umt5_xxl/i),
    wanVae: best(vaes, /wan_2\.1_vae/i, /wan.*vae/i),
    wanClipVision: best(clipVisions, /clip_vision_h/i),
  };

  const wanCommon: string[] = [];
  if (!models.wanTextEncoder) wanCommon.push("umt5_xxl text encoder (models/text_encoders)");
  if (!models.wanVae) wanCommon.push("wan_2.1_vae (models/vae)");
  const video = [...wanCommon];
  if (!nodes.WanImageToVideo) video.push("a ComfyUI with native Wan nodes (update ComfyUI)");
  if (!models.wanI2V) video.push("wan2.1_i2v_720p_14B (models/diffusion_models)");
  if (!models.wanClipVision) video.push("clip_vision_h (models/clip_vision)");

  const motion: string[] = [];
  if (!nodes.DWPreprocessor) motion.push("comfyui_controlnet_aux (DWPreprocessor)");
  if (!models.controlNet) motion.push("an SDXL OpenPose ControlNet (models/controlnet)");
  if (!nodes.IPAdapterUnifiedLoaderFaceID) motion.push("ComfyUI_IPAdapter_plus (FaceID)");
  const motionVideo = [...motion, ...wanCommon];
  if (!nodes.WanVaceToVideo) motionVideo.push("a ComfyUI with native Wan VACE nodes (update ComfyUI)");
  if (!models.wanVace) motionVideo.push("wan2.1_vace_14B (models/diffusion_models)");

  // Clips swap with ReActor; photos re-sample the face with FaceDetailer + FaceID (no ReActor involved).
  const faceswap: string[] = [];
  if (!models.swapModel) faceswap.push("ComfyUI-ReActor with a swap model (models/hyperswap, reswapper or insightface)");
  if (!nodes.ReActorFaceBoost) faceswap.push("ComfyUI-ReActor (FaceBoost)");
  const faceswapPhoto: string[] = [];
  if (!nodes.FaceDetailer) faceswapPhoto.push("ComfyUI-Impact-Pack (FaceDetailer)");
  if (!models.faceDetector) faceswapPhoto.push("models/ultralytics/bbox/face_yolov8m.pt");
  if (!nodes.IPAdapterUnifiedLoaderFaceID) faceswapPhoto.push("ComfyUI_IPAdapter_plus (FaceID)");

  const upscale: string[] = [];
  if (!nodes.UltimateSDUpscale) upscale.push("ComfyUI_UltimateSDUpscale");
  if (!models.upscaler) upscale.push("4x-UltraSharp.pth (models/upscale_models)");

  return {
    models,
    missing: { video, motion, motionVideo, faceswap, faceswapPhoto, upscale },
    refineAvailable: faceswapPhoto.length === 0,
  };
}

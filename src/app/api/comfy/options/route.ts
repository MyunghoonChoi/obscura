import type { Architecture } from "@/lib/comfy/architectures";
import { listNodeOptions } from "@/lib/comfy/client";
import { checkpointArchitecture, VRAM_PROFILE } from "@/lib/comfy/models";

export const runtime = "nodejs";

/** GET /api/comfy/options — model/sampler dropdowns, read live from the ComfyUI server's /object_info. */
export async function GET() {
  const [checkpoints, motionModules, samplers, schedulers, ipAdapterPresets] = await Promise.all([
    listNodeOptions("CheckpointLoaderSimple", "ckpt_name"),
    listNodeOptions("ADE_AnimateDiffLoaderGen1", "model_name"),
    listNodeOptions("KSampler", "sampler_name"),
    listNodeOptions("KSampler", "scheduler"),
    listNodeOptions("IPAdapterUnifiedLoader", "preset"),
  ]);
  // Lets the UI switch the graph family automatically when a checkpoint is picked.
  const checkpointArchitectures: Record<string, Architecture> = Object.fromEntries(
    await Promise.all(checkpoints.map(async (c) => [c, await checkpointArchitecture(c)] as const)),
  );
  return Response.json({
    online: samplers.length > 0,
    vramProfile: VRAM_PROFILE,
    checkpoints,
    checkpointArchitectures,
    motionModules,
    samplers,
    schedulers,
    ipAdapterPresets,
  });
}

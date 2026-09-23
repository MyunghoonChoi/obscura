import { listNodeOptions } from "@/lib/comfy/client";

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
  return Response.json({
    online: samplers.length > 0,
    checkpoints,
    motionModules,
    samplers,
    schedulers,
    ipAdapterPresets,
  });
}

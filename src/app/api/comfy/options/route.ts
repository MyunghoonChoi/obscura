import { listNodeOptions } from "@/lib/comfy/client";
import { remixAvailability, sdxlCheckpoints } from "@/lib/comfy/models";
import { isSdxlMotionModule } from "@/lib/comfy/presets";

export const runtime = "nodejs";

/**
 * GET /api/comfy/options — dropdowns read live from ComfyUI's /object_info, filtered to what the
 * SDXL pipeline can use, plus which Remix modes are ready on this ComfyUI.
 */
export async function GET() {
  const [checkpoints, motionModules, samplers, schedulers, remix] = await Promise.all([
    sdxlCheckpoints(),
    listNodeOptions("ADE_AnimateDiffLoaderGen1", "model_name"),
    listNodeOptions("KSampler", "sampler_name"),
    listNodeOptions("KSampler", "scheduler"),
    remixAvailability(),
  ]);
  return Response.json({
    online: samplers.length > 0,
    checkpoints,
    motionModules: motionModules.filter(isSdxlMotionModule),
    samplers,
    schedulers,
    remix: { missing: remix.missing, refineAvailable: remix.refineAvailable },
  });
}

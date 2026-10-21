import { listNodeOptions } from "@/lib/comfy/client";
import { defaultCheckpoint, pipelineAvailability, sdxlCheckpoints } from "@/lib/comfy/models";

export const runtime = "nodejs";

/**
 * GET /api/comfy/options — dropdowns read live from ComfyUI's /object_info, filtered to what the
 * SDXL pipeline can use, the configured default checkpoint, and what each capability is missing.
 */
export async function GET() {
  const [checkpoints, samplers, schedulers, availability] = await Promise.all([
    sdxlCheckpoints(),
    listNodeOptions("KSampler", "sampler_name"),
    listNodeOptions("KSampler", "scheduler"),
    pipelineAvailability(),
  ]);
  return Response.json({
    online: samplers.length > 0,
    checkpoints,
    defaultCheckpoint: defaultCheckpoint(checkpoints),
    samplers,
    schedulers,
    missing: availability.missing,
    refineAvailable: availability.refineAvailable,
  });
}

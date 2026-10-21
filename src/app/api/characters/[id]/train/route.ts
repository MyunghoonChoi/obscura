import type { TrainingPreset } from "@/lib/characters/types";
import { errorResponse } from "@/lib/http";
import { getTrainingStatus, startTraining, stopTraining } from "@/lib/training/runner";

export const runtime = "nodejs";

/** POST /api/characters/:id/train  { preset, checkpoint } — starts a new LoRA version. */
export async function POST(req: Request, ctx: RouteContext<"/api/characters/[id]/train">) {
  const { id } = await ctx.params;
  try {
    const body = (await req.json()) as { preset?: TrainingPreset; checkpoint?: string };
    const status = await startTraining(id, { preset: body.preset ?? "standard", checkpoint: String(body.checkpoint ?? "") });
    return Response.json(status, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/characters/:id/train — stops this character's run. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/characters/[id]/train">) {
  const { id } = await ctx.params;
  try {
    if ((await getTrainingStatus())?.characterId === id) await stopTraining();
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

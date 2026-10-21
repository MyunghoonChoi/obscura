import { getCharacterDetail, trashCharacter, updateCharacter, ValidationError } from "@/lib/characters/store";
import { errorResponse } from "@/lib/http";
import { getTrainingStatus, listCheckpoints, trainerInstalled } from "@/lib/training/runner";

export const runtime = "nodejs";

/** GET /api/characters/:id — metadata, dataset images with captions, and this character's training status. */
export async function GET(_req: Request, ctx: RouteContext<"/api/characters/[id]">) {
  const { id } = await ctx.params;
  // Status first: it finalizes a just-finished run, so the new version shows up in the same response.
  const training = await getTrainingStatus();
  const [character, checkpoints, installed] = await Promise.all([getCharacterDetail(id), listCheckpoints(), trainerInstalled()]);
  if (!character) return Response.json({ error: "Character not found." }, { status: 404 });
  return Response.json({
    character,
    training: training?.characterId === id ? training : null,
    busy: !!training,
    checkpoints,
    trainerInstalled: installed,
  });
}

/** PATCH /api/characters/:id  { name?, loraStrength?, activeVersion? } */
export async function PATCH(req: Request, ctx: RouteContext<"/api/characters/[id]">) {
  const { id } = await ctx.params;
  try {
    return Response.json(await updateCharacter(id, await req.json()));
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/characters/:id — moves the folder and its trained LoRA files to characters/_trash. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/characters/[id]">) {
  const { id } = await ctx.params;
  try {
    if ((await getTrainingStatus())?.characterId === id) throw new ValidationError("Stop training before removing this character.");
    await trashCharacter(id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

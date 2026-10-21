import { createCharacter, listCharacters } from "@/lib/characters/store";
import { errorResponse } from "@/lib/http";
import { getTrainingStatus, trainerInstalled } from "@/lib/training/runner";

export const runtime = "nodejs";

/** GET /api/characters — the library, plus whatever is training right now. */
export async function GET() {
  try {
    const [training, characters, installed] = await Promise.all([getTrainingStatus(), listCharacters(), trainerInstalled()]);
    return Response.json({ characters, training, trainerInstalled: installed });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/characters  { name, trigger, classWord } */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { name?: string; trigger?: string; classWord?: string };
    const character = await createCharacter({
      name: String(body.name ?? ""),
      trigger: String(body.trigger ?? ""),
      classWord: String(body.classWord ?? "person"),
    });
    return Response.json(character, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

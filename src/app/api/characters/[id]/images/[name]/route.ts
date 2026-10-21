import fs from "node:fs/promises";
import path from "node:path";

import { imagePath, removeImage, updateImage } from "@/lib/characters/store";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

type Ctx = RouteContext<"/api/characters/[id]/images/[name]">;

/** GET — the dataset image file itself (names are unique, so it can be cached forever). */
export async function GET(_req: Request, ctx: Ctx) {
  const { id, name } = await ctx.params;
  const file = imagePath(id, decodeURIComponent(name));
  const bytes = file ? await fs.readFile(file).catch(() => null) : null;
  if (!bytes) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": MIME[path.extname(file!).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}

/** PATCH { caption?, starred? } */
export async function PATCH(req: Request, ctx: Ctx) {
  const { id, name } = await ctx.params;
  try {
    await updateImage(id, decodeURIComponent(name), await req.json());
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE — takes the image out of the dataset (moved to the character's removed/ folder). */
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id, name } = await ctx.params;
  try {
    await removeImage(id, decodeURIComponent(name));
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

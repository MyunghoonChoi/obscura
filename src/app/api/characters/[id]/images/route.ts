import path from "node:path";

import { addImage, ValidationError } from "@/lib/characters/store";
import { viewFile } from "@/lib/comfy/client";
import type { ComfyFileRef } from "@/lib/comfy/types";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";

const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPTED = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * POST /api/characters/:id/images
 *   multipart/form-data  files=<File>…                → upload reference photos
 *   application/json     { output: ComfyFileRef }     → copy a generated image from ComfyUI into the dataset
 */
export async function POST(req: Request, ctx: RouteContext<"/api/characters/[id]">) {
  const { id } = await ctx.params;
  try {
    if (req.headers.get("content-type")?.includes("application/json")) {
      const { output } = (await req.json()) as { output?: ComfyFileRef };
      if (!output?.filename || ![output.filename, output.subfolder ?? ""].every((s) => !s.includes("..")))
        throw new ValidationError("Missing output file.");
      const ext = path.extname(output.filename).slice(1);
      if (!/^(png|jpe?g|webp)$/i.test(ext)) throw new ValidationError("Only still images can be added to a dataset.");
      const res = await viewFile({ filename: output.filename, subfolder: output.subfolder ?? "", type: output.type ?? "output" });
      const image = await addImage(id, Buffer.from(await res.arrayBuffer()), "gen");
      return Response.json({ images: [image] }, { status: 201 });
    }

    const form = await req.formData();
    const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (!files.length) throw new ValidationError("No images received.");
    const images = [];
    for (const file of files) {
      if (!ACCEPTED.has(file.type)) throw new ValidationError(`${file.name}: only PNG, JPEG and WebP are supported.`);
      if (file.size > MAX_BYTES) throw new ValidationError(`${file.name} is over 25 MB.`);
      images.push(await addImage(id, Buffer.from(await file.arrayBuffer())));
    }
    return Response.json({ images }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

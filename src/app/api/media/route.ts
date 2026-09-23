import { viewFile } from "@/lib/comfy/client";
import type { ComfyFileRef } from "@/lib/comfy/types";

export const runtime = "nodejs";

const TYPES = new Set(["output", "temp", "input"]);
const PASSTHROUGH = ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"];

/** GET /api/media?filename=&subfolder=&type= — proxies ComfyUI /view (with Range support for video seeking). */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const filename = sp.get("filename") ?? "";
  const subfolder = sp.get("subfolder") ?? "";
  const type = sp.get("type") ?? "output";
  if (!filename || !TYPES.has(type) || [filename, subfolder].some((s) => s.includes(".."))) {
    return new Response("Bad request", { status: 400 });
  }

  try {
    const upstream = await viewFile({ filename, subfolder, type } as ComfyFileRef, req.headers.get("range"));
    const headers = new Headers({ "Cache-Control": "private, max-age=31536000, immutable" });
    for (const h of PASSTHROUGH) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

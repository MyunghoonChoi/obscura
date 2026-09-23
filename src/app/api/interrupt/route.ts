import { interrupt } from "@/lib/comfy/client";

export const runtime = "nodejs";

/** POST /api/interrupt — stops whatever ComfyUI is currently executing. */
export async function POST(req: Request) {
  try {
    const { promptId } = (await req.json().catch(() => ({}))) as { promptId?: string };
    await interrupt(promptId);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}

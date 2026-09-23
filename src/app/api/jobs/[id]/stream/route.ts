import { jobEventStream } from "@/lib/comfy/stream";

export const runtime = "nodejs";
export const maxDuration = 900; // long AnimateDiff renders on hosted platforms

/** GET /api/jobs/{promptId}/stream?clientId=… — Server-Sent Events of JobEvent. */
export async function GET(req: Request, ctx: RouteContext<"/api/jobs/[id]/stream">) {
  const { id } = await ctx.params;
  const clientId = new URL(req.url).searchParams.get("clientId");
  if (!clientId) return new Response("clientId is required", { status: 400 });

  return new Response(jobEventStream(id, clientId, req.signal), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering if you put one in front
    },
  });
}

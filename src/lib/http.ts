import "server-only";

import { NotFoundError, ValidationError } from "@/lib/characters/store";

/** Maps store errors to status codes: bad input → 400, missing → 404, anything else → 500. */
export function errorResponse(err: unknown): Response {
  const message = err instanceof Error ? err.message : "Unknown error";
  const status = err instanceof ValidationError ? 400 : err instanceof NotFoundError ? 404 : 500;
  return Response.json({ error: message }, { status });
}

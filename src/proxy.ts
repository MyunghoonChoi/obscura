import { NextResponse, type NextRequest } from "next/server";

/**
 * Optional HTTP Basic Auth gate. Set DASHBOARD_PASSWORD (and optionally
 * DASHBOARD_USER, default "admin") before exposing the dashboard beyond localhost —
 * anyone who can reach it can queue jobs on your GPU.
 */
export function proxy(req: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return NextResponse.next();

  const user = process.env.DASHBOARD_USER ?? "admin";
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const [u, ...rest] = atob(header.slice(6)).split(":");
    if (u === user && rest.join(":") === password) return NextResponse.next();
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Obscura"' },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

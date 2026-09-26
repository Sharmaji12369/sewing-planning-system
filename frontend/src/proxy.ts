import { NextResponse, type NextRequest } from "next/server";

// Sends anyone without a session cookie to the sign-in page. This is only the
// polite front door: the real check is the backend, which refuses every data
// request without a valid, signed session (backend/src/auth.ts).
export function proxy(request: NextRequest) {
  if (request.cookies.has("sp_session")) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  const url = new URL("/login", request.url);
  if (pathname !== "/") url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  // Every page except the sign-in page itself, the API and Next.js's own files.
  matcher: ["/((?!login|api|_next/static|_next/image|favicon.ico).*)"],
};

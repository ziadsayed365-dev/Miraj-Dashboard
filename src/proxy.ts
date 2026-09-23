import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, STAFF_ALLOWED_PATHS, verifySessionToken } from "@/lib/auth";

// Any page that must render while logged out (e.g. /login) belongs here,
// rather than in the matcher's exclusion list below. This follows Next's
// own auth guide (node_modules/next/dist/docs/01-app/02-guides/
// authentication.md, "Optimistic checks with Proxy"): run the proxy on
// every route and branch on the path inside the function, instead of
// trying to carve routes out of the matcher.
const PUBLIC_PATHS = ["/login"];

export function proxy(request: NextRequest) {
  if (PUBLIC_PATHS.includes(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const sessionSecret = process.env.SESSION_SECRET;

  // Fail closed: no signing secret configured means no access, ever.
  if (!sessionSecret) {
    return new NextResponse("App is not configured (SESSION_SECRET missing).", { status: 503 });
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const role = verifySessionToken(token, sessionSecret);

  if (!role) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (role === "staff" && !STAFF_ALLOWED_PATHS.includes(request.nextUrl.pathname)) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:jpg|jpeg|png|svg|gif|webp|ico)$).*)"],
};

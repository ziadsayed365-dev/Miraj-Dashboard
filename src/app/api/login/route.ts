import { NextRequest, NextResponse } from "next/server";
import { createSessionToken, resolveRole, SESSION_COOKIE_NAME } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const sessionSecret = process.env.SESSION_SECRET;
  const formData = await request.formData();
  const username = formData.get("username");
  const password = formData.get("password");

  // Fail closed: no signing secret configured means no access, ever.
  if (!sessionSecret || typeof username !== "string" || typeof password !== "string") {
    return NextResponse.redirect(new URL("/login?error=1", request.url), 303);
  }

  const role = await resolveRole(username, password);
  if (!role) {
    return NextResponse.redirect(new URL("/login?error=1", request.url), 303);
  }

  const token = createSessionToken(role, sessionSecret);
  const response = NextResponse.redirect(new URL("/", request.url), 303);
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return response;
}

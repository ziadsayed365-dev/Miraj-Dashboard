import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { createUser } from "@/lib/settings/users";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });
  }

  const body = await request.json();
  const { username, password, role: newUserRole } = body;

  if (
    typeof username !== "string" ||
    !username.trim() ||
    typeof password !== "string" ||
    !password ||
    (newUserRole !== "owner" && newUserRole !== "staff")
  ) {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }

  try {
    await createUser({ username, password, role: newUserRole });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}

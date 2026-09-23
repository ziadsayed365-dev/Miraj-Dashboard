import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { deleteUser, updateUser } from "@/lib/settings/users";

export const dynamic = "force-dynamic";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });
  }

  const { id } = await params;
  const userId = Number(id);
  if (!Number.isFinite(userId)) {
    return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
  }

  const body = await request.json();
  const { username, password, role: newUserRole } = body;

  if (newUserRole !== undefined && newUserRole !== "owner" && newUserRole !== "staff") {
    return NextResponse.json({ ok: false, error: "Invalid role" }, { status: 400 });
  }

  try {
    await updateUser(userId, {
      username: typeof username === "string" ? username : undefined,
      password: typeof password === "string" && password ? password : undefined,
      role: newUserRole,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const role = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);
  if (role !== "owner") {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 403 });
  }

  const { id } = await params;
  const userId = Number(id);
  if (!Number.isFinite(userId)) {
    return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
  }

  try {
    await deleteUser(userId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown error" }, { status: 500 });
  }
}

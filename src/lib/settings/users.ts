import "server-only";
import { supabase } from "@/lib/supabase";
import { hashPassword, type Role } from "@/lib/auth";

export type AppUser = {
  id: number;
  username: string;
  role: Role;
};

export async function getUsers(): Promise<AppUser[]> {
  const { data, error } = await supabase.from("users").select("id, username, role").order("username", { ascending: true });
  if (error) throw new Error(`Failed to load users: ${error.message}`);
  return data ?? [];
}

export type CreateUserInput = { username: string; password: string; role: Role };

export async function createUser(input: CreateUserInput): Promise<void> {
  if (!input.username.trim()) throw new Error("Username is required");
  if (!input.password) throw new Error("Password is required");

  const { error } = await supabase.from("users").insert({
    username: input.username.trim(),
    password_hash: hashPassword(input.password),
    role: input.role,
  });
  if (error) throw new Error(`Failed to create user: ${error.message}`);
}

export type UpdateUserInput = { username?: string; password?: string; role?: Role };

export async function updateUser(id: number, input: UpdateUserInput): Promise<void> {
  const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.username !== undefined) {
    if (!input.username.trim()) throw new Error("Username is required");
    values.username = input.username.trim();
  }
  if (input.password) values.password_hash = hashPassword(input.password);
  if (input.role !== undefined) values.role = input.role;

  const { error } = await supabase.from("users").update(values).eq("id", id);
  if (error) throw new Error(`Failed to update user: ${error.message}`);
}

export async function deleteUser(id: number): Promise<void> {
  const { count, error: countErr } = await supabase
    .from("users")
    .select("id", { count: "exact", head: true })
    .eq("role", "owner");
  if (countErr) throw new Error(`Failed to check owner count: ${countErr.message}`);

  const { data: target, error: targetErr } = await supabase.from("users").select("role").eq("id", id).maybeSingle();
  if (targetErr) throw new Error(`Failed to look up user: ${targetErr.message}`);

  if (target?.role === "owner" && (count ?? 0) <= 1) {
    throw new Error("Can't delete the last owner account");
  }

  const { error } = await supabase.from("users").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete user: ${error.message}`);
}

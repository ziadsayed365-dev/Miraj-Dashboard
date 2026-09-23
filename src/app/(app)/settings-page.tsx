"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AppUser } from "@/lib/settings/users";

export function SettingsPage({ users }: { users: AppUser[] }) {
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"owner" | "staff">("staff");
  const [userSubmitting, setUserSubmitting] = useState(false);
  const [userError, setUserError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editUsername, setEditUsername] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editRole, setEditRole] = useState<"owner" | "staff">("staff");
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const inputClass = "mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm";
  const editInputClass = "w-full rounded border border-gray-300 px-1.5 py-1 text-xs";

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    setUserError(null);
    if (!username.trim() || !password) {
      setUserError("Username and password are required.");
      return;
    }

    setUserSubmitting(true);
    try {
      const res = await fetch("/api/settings/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, role }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to add user");
      setUsername("");
      setPassword("");
      setRole("staff");
      router.refresh();
    } catch (err) {
      setUserError(err instanceof Error ? err.message : "Failed to add user");
    } finally {
      setUserSubmitting(false);
    }
  }

  function startEdit(u: AppUser) {
    setEditingId(u.id);
    setEditUsername(u.username);
    setEditPassword("");
    setEditRole(u.role);
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function saveEdit() {
    if (editingId === null) return;
    if (!editUsername.trim()) {
      setEditError("Username is required.");
      return;
    }

    setEditSubmitting(true);
    setEditError(null);
    try {
      const res = await fetch(`/api/settings/users/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: editUsername,
          password: editPassword || undefined,
          role: editRole,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to save");
      setEditingId(null);
      router.refresh();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setEditSubmitting(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Delete this user?")) return;

    setDeletingId(id);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/settings/users/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Failed to delete user");
      router.refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete user");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-gray-900">Users</h2>

        <form onSubmit={handleAddUser} className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4">
          <div>
            <label className="block text-xs font-medium text-gray-500">Username</label>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500">Role</label>
            <select value={role} onChange={(e) => setRole(e.target.value as "owner" | "staff")} className={inputClass}>
              <option value="staff">Staff</option>
              <option value="owner">Owner</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={userSubmitting}
            className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {userSubmitting ? "Adding…" : "Add user"}
          </button>
          {userError && <span className="text-xs text-red-600">{userError}</span>}
        </form>

        {deleteError && <div className="text-xs text-red-600">{deleteError}</div>}

        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="w-full table-fixed text-sm">
            <thead className="bg-gray-50 text-left text-xs font-medium uppercase text-gray-400">
              <tr>
                <th className="w-[36%] px-3 py-2">Username</th>
                <th className="w-[24%] px-3 py-2">Role</th>
                <th className="w-[40%] px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((u) => {
                if (editingId === u.id) {
                  return (
                    <tr key={u.id} className="bg-blue-50/40">
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={editUsername}
                          onChange={(e) => setEditUsername(e.target.value)}
                          className={editInputClass}
                        />
                        <input
                          type="text"
                          disabled
                          value="••••••••"
                          title="The actual password can't be shown - it's stored hashed, not in plain text"
                          className={`${editInputClass} mt-1 cursor-not-allowed bg-gray-100 text-gray-400`}
                        />
                        <input
                          type="password"
                          placeholder="New password (optional)"
                          value={editPassword}
                          onChange={(e) => setEditPassword(e.target.value)}
                          className={`${editInputClass} mt-1`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={editRole}
                          onChange={(e) => setEditRole(e.target.value as "owner" | "staff")}
                          className={editInputClass}
                        >
                          <option value="staff">Staff</option>
                          <option value="owner">Owner</option>
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-col gap-1">
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={saveEdit}
                              disabled={editSubmitting}
                              className="rounded bg-gray-900 px-2 py-0.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50"
                            >
                              {editSubmitting ? "…" : "Save"}
                            </button>
                            <button
                              type="button"
                              onClick={cancelEdit}
                              className="rounded border border-gray-300 px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-100"
                            >
                              Cancel
                            </button>
                          </div>
                          {editError && <span className="text-[11px] text-red-600">{editError}</span>}
                        </div>
                      </td>
                    </tr>
                  );
                }

                return (
                  <tr key={u.id} className="text-gray-700">
                    <td className="px-3 py-2">{u.username}</td>
                    <td className="px-3 py-2 capitalize">{u.role}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-2">
                        <button type="button" onClick={() => startEdit(u)} className="text-xs font-medium text-gray-600 hover:underline">
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(u.id)}
                          disabled={deletingId === u.id}
                          className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50"
                        >
                          {deletingId === u.id ? "Deleting…" : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-4 text-center text-gray-400">
                    No users yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_LINKS } from "./nav-links";
import { SyncButton } from "./sync-button";

export function MobileNav({ role }: { role: "owner" | "staff" | null }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const links =
    role === "owner"
      ? [
          ...NAV_LINKS,
          { href: "/purchasing", label: "Purchasing" },
          { href: "/product-list", label: "Product List" },
          { href: "/settings", label: "Settings" },
        ]
      : NAV_LINKS;

  return (
    <div className="sm:hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="font-semibold text-white">Miraj</span>
        <div className="flex items-center gap-1">
          {role === "owner" && <SyncButton />}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle menu"
            aria-expanded={open}
            className="rounded-md p-2 text-white hover:bg-white/10"
          >
            {open ? "✕" : "☰"}
          </button>
        </div>
      </div>
      {open && (
        <div className="space-y-1 border-t border-white/10 px-4 py-3">
          {links.map((link) => {
            const isActive = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className={`block rounded-md px-3 py-2 text-sm font-medium text-white ${
                  isActive ? "bg-white/20" : "hover:bg-white/10"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
          {role && (
            <form action="/api/logout" method="POST">
              <button type="submit" className="block w-full rounded-md px-3 py-2 text-left text-sm text-white/80 hover:bg-white/10">
                Sign out
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

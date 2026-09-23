"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const NAV_LINKS = [
  { href: "/", label: "Income Statement" },
  { href: "/products", label: "Analysis by Product" },
  { href: "/expense-analysis", label: "Expense Analysis" },
  { href: "/bosta", label: "Bosta" },
];

export function NavLinks({ role }: { role: "owner" | "staff" | null }) {
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
    <>
      {links.map((link) => {
        const isActive = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`rounded-md px-3 py-1.5 text-sm font-medium text-white ${
              isActive ? "bg-white/20" : "hover:bg-white/10"
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </>
  );
}

import { cookies } from "next/headers";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { NavLinks } from "./nav-links";
import { SyncButton } from "./sync-button";
import { MobileNav } from "./mobile-nav";
import { SyncFreshnessBanner } from "./sync-freshness-banner";

const BRAND_NAVY = "#050a30";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const role = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value, process.env.SESSION_SECRET);

  return (
    <div className="flex min-h-full flex-1 flex-col bg-gray-50 text-gray-900">
      <header style={{ backgroundColor: BRAND_NAVY }}>
        <MobileNav role={role} />
        <nav className="mx-auto hidden max-w-6xl items-center gap-1 px-4 py-3 sm:flex">
          <span className="mr-4 font-semibold text-white">Miraj</span>
          <NavLinks role={role} />
          {role === "owner" && <SyncButton className="ml-auto" />}
          {role && (
            <form action="/api/logout" method="POST" className={role === "owner" ? "" : "ml-auto"}>
              <button type="submit" className="rounded-md px-3 py-1.5 text-sm text-white/80 hover:bg-white/10">
                Sign out
              </button>
            </form>
          )}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {/* Staff read these figures too, so the disclosure is not owner-only. */}
        {role && <SyncFreshnessBanner />}
        {children}
      </main>
    </div>
  );
}

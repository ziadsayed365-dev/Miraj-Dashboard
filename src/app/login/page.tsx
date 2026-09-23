export const dynamic = "force-dynamic";

const BRAND_NAVY = "#050a30";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;

  return (
    <div className="flex flex-1 flex-col items-center px-4" style={{ backgroundColor: BRAND_NAVY }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- Next's image optimizer endpoint is broken in this environment; serve the static file directly */}
      <img src="/dark-logo.jpeg" alt="FinVisor" className="mt-10 h-auto w-72 sm:w-80" />

      <div className="flex w-full flex-1 items-center justify-center">
        <form
          action="/api/login"
          method="POST"
          className="w-full max-w-sm space-y-4 rounded-lg border border-white/20 bg-white/20 p-6 shadow-xl backdrop-blur-md"
        >
          {params.error && (
            <div className="rounded border border-red-300 bg-red-50/90 px-3 py-2 text-sm text-red-700">
              Wrong username or password. Try again.
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-white">Username</label>
            <input
              type="text"
              name="username"
              autoFocus
              required
              autoComplete="username"
              className="mt-1 w-full rounded border border-white/40 bg-white/70 px-3 py-2 text-sm text-black"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-white">Password</label>
            <input
              type="password"
              name="password"
              required
              autoComplete="current-password"
              className="mt-1 w-full rounded border border-white/40 bg-white/70 px-3 py-2 text-sm text-black"
            />
          </div>
          <button
            type="submit"
            className="w-full rounded px-3 py-2 text-sm font-medium text-white hover:opacity-90"
            style={{ backgroundColor: BRAND_NAVY }}
          >
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}

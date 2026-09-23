"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Status = "idle" | "loading" | "success" | "incomplete" | "error";

// Mirrors the step order in src/app/api/sync/run/route.ts - one request per
// step, since the combined runtime of all steps exceeds a single
// serverless function's budget but each step alone fits comfortably.
// NOTE: no "bosta" step here, unlike the nightly cron (src/app/api/cron/daily),
// which does sync the courier. Inherited from an upstream clone whose courier
// was not Bosta. Miraj's courier IS Bosta, so a manual sync refreshes orders and
// ad spend but NOT delivery outcomes -- those land on the next nightly run.
const STEPS = ["shopify", "shopify-products", "meta", "tiktok", "calibrate", "monthly-rate", "sku-monthly-rate", "margins"];

// Steps that checkpoint a cursor and self-cap on a time budget, so ONE request
// only clears PART of the backlog. They have to be called until they answer
// reachedEnd - a single pass is not a finished sync.
//
// This button used to fire each step exactly once and check only `ok`. A
// truncated pass returns `{ ok: true, reachedEnd: false }`, so Sync reported
// "Synced ✓" over a half-done pull. It showed up as a short day rather than as
// an error, because syncShopifyOrders walks orders by UPDATED_AT ASCENDING: a
// pass that runs out of budget lands the least-recently-updated orders and
// leaves the NEWEST ones - the ones being looked at - unsynced. (Observed
// 2026-08-20: Shopify had 101 orders for Aug 19, the dashboard showed 53.)
//
// Same pass caps as the nightly cron, which has always looped (see
// src/app/api/cron/daily/route.ts).
const MAX_PASSES: Record<string, number> = { shopify: 12, meta: 3, tiktok: 3 };

export function SyncButton({ className = "" }: { className?: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Resolves true when the step drained its backlog, false when it hit the pass
  // cap with work still queued. Throws on an actual failure.
  async function runStep(step: string, onPass: (pass: number) => void): Promise<boolean> {
    const maxPasses = MAX_PASSES[step] ?? 1;
    for (let pass = 1; pass <= maxPasses; pass++) {
      onPass(pass);
      const res = await fetch(`/api/sync/run?step=${step}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? `Sync failed at step "${step}"`);
      // Non-resumable steps do one pass and are done; they report no reachedEnd.
      if (maxPasses === 1 || data.reachedEnd) return true;
    }
    return false;
  }

  async function handleClick() {
    setStatus("loading");
    setMessage(null);
    // Tracked locally rather than read back off `status`: this closure captured
    // the state from the render that ran BEFORE setStatus, so `status` here is
    // stale and the finally block below would branch on the wrong value.
    let outcome: Status = "success";
    try {
      // A step that hits its cap does NOT abort the run: the steps after it
      // still need to fold in whatever did land, exactly as the nightly cron
      // carries on past an undrained order backlog.
      const unfinished: string[] = [];
      for (let i = 0; i < STEPS.length; i++) {
        const step = STEPS[i];
        const drained = await runStep(step, (pass) =>
          setProgress(`${i + 1}/${STEPS.length}${pass > 1 ? ` · pass ${pass}` : ""}`)
        );
        if (!drained) unfinished.push(step);
      }
      if (unfinished.length > 0) {
        outcome = "incomplete";
        setMessage(`Still behind on: ${unfinished.join(", ")}. The newest orders land last - click Sync again to keep catching up.`);
      }
      setStatus(outcome);
      router.refresh();
    } catch (err) {
      outcome = "error";
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setProgress(null);
      // An incomplete sync needs the user to click again, so it stays on screen;
      // the other end states need no follow-up and clear themselves.
      if (outcome !== "incomplete") setTimeout(() => setStatus("idle"), 4000);
    }
  }

  const label =
    status === "loading"
      ? `Syncing… ${progress ?? ""}`
      : status === "success"
        ? "Synced ✓"
        : status === "incomplete"
          ? "Partly synced — click again"
          : status === "error"
            ? "Sync failed"
            : "Sync";

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={status === "loading"}
      title={message ?? "Pull the latest Shopify, Bosta and Meta data and recompute margins"}
      className={`rounded-md px-3 py-1.5 text-sm font-medium text-white hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
    >
      {label}
    </button>
  );
}

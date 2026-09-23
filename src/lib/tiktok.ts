import "server-only";

// TikTok Marketing API (TikTok for Business). Same shape as the Meta pull: one
// row per CAMPAIGN per day, because Miraj runs one campaign per product and the
// campaign is what the allocation popup maps to a sub-category.
//
// Auth is a long-lived advertiser access token issued to our TikTok developer
// app (scripts/tiktok-get-token.mjs exchanges the one-off auth code for it). It
// does not expire on its own - only if the advertiser revokes the app.
const TIKTOK_API = "https://business-api.tiktok.com/open_api/v1.3";

export type TikTokCampaignDay = {
  campaign_id: string;
  campaign_name: string | null;
  date: string; // YYYY-MM-DD, in the advertiser account's own timezone
  spend: number;
};

export type TikTokAdvertiser = {
  id: string;
  name: string | null;
  currency: string | null;
  timezone: string | null;
};

export function getTikTokAdvertiserIds(): string[] {
  return (process.env.TIKTOK_ADVERTISER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// The sync switches on only once both are set. Until then TikTok stays on the
// hand-typed daily popup (src/lib/tiktok-spend.ts) exactly as before.
export function isTikTokApiConfigured(): boolean {
  return Boolean(process.env.TIKTOK_ACCESS_TOKEN) && getTikTokAdvertiserIds().length > 0;
}

async function tiktokGet<T>(path: string, params: Record<string, string>): Promise<T | undefined> {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  if (!token) throw new Error("Missing TIKTOK_ACCESS_TOKEN environment variable");

  const res = await fetch(`${TIKTOK_API}${path}?${new URLSearchParams(params).toString()}`, {
    headers: { "Access-Token": token },
  });
  const body: { code?: number; data?: T } | null = await res.json().catch(() => null);
  // TikTok answers most failures with HTTP 200 and a non-zero `code`, so the
  // body is the real status - checking res.ok alone lets errors through as
  // "no data".
  if (!res.ok || !body || body.code !== 0) {
    throw new Error(`TikTok ${path} failed: ${res.status} ${JSON.stringify(body ?? {})}`);
  }
  return body.data;
}

// Name, currency and timezone per advertiser. Currency and timezone are checked
// by the sync: every figure in the P&L is EGP on Egypt days, and TikTok reports
// in the account's own currency and day boundaries.
export async function fetchTikTokAdvertisers(ids: string[]): Promise<TikTokAdvertiser[]> {
  const data = await tiktokGet<{
    list?: { advertiser_id: string | number; name?: string; currency?: string; timezone?: string }[];
  }>("/advertiser/info/", {
    advertiser_ids: JSON.stringify(ids),
    fields: JSON.stringify(["advertiser_id", "name", "currency", "timezone"]),
  });
  return (data?.list ?? []).map((a) => ({
    id: String(a.advertiser_id),
    name: typeof a.name === "string" && a.name.trim() ? a.name.trim() : null,
    currency: a.currency ?? null,
    timezone: a.timezone ?? null,
  }));
}

// Daily campaign spend for one advertiser. TikTok caps a daily-breakdown report
// at 30 days per request, so the caller walks the range in chunks.
export async function fetchTikTokCampaignSpend(
  advertiserId: string,
  since: string,
  until: string
): Promise<TikTokCampaignDay[]> {
  const results: TikTokCampaignDay[] = [];
  let page = 1;

  for (;;) {
    const data = await tiktokGet<{
      list?: { dimensions: { campaign_id: string; stat_time_day: string }; metrics?: { spend?: string; campaign_name?: string } }[];
      page_info?: { total_page?: number };
    }>("/report/integrated/get/", {
      advertiser_id: advertiserId,
      report_type: "BASIC",
      data_level: "AUCTION_CAMPAIGN",
      dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
      metrics: JSON.stringify(["spend", "campaign_name"]),
      start_date: since,
      end_date: until,
      page: String(page),
      page_size: "1000",
    });

    for (const row of data?.list ?? []) {
      const spend = Number(row.metrics?.spend ?? 0);
      // The report lists every campaign that existed in the range, including
      // paused ones at 0 - they are not an allocation decision anyone needs.
      if (!Number.isFinite(spend) || spend <= 0) continue;
      results.push({
        campaign_id: String(row.dimensions.campaign_id),
        campaign_name: row.metrics?.campaign_name ?? null,
        // "2026-09-01 00:00:00" -> "2026-09-01"
        date: String(row.dimensions.stat_time_day).slice(0, 10),
        spend,
      });
    }

    const totalPages = Number(data?.page_info?.total_page ?? 1);
    if (page >= totalPages) break;
    page++;
  }

  return results;
}

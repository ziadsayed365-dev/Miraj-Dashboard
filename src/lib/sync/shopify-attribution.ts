import "server-only";
import { supabase } from "@/lib/supabase";
import { getShopifyAccessToken, shopifyGraphQL } from "@/lib/shopify";
import { egyptToday, addDays } from "@/lib/dates";
import { inBatches } from "@/lib/in-batches";

// Which Meta campaign brought each order in, for the Campaigns P&L.
//
// Shopify records the customer's visits before an order (customerJourneySummary)
// with the UTM parameters of each visit. An order is credited to its LAST AD
// CLICK within AD_CLICK_WINDOW_DAYS before it - the most recent visit that came
// from a paid ad - even when the customer came back some other way to buy (typed
// the address, Instagram bio). Each order goes to exactly one click, so the
// campaigns still add up. When that last click was a TikTok or Google ad, the
// order is that platform's, not Meta's.
//
// Meta ads are tagged in one of two ways, and both are read:
//   - utm_campaign={{campaign.id}} (utm_term={{adset.id}}, utm_content={{ad.id}}):
//     the campaign id is right there;
//   - utm_campaign=<a label> with utm_term={{adset.id}}: the ad set's campaign is
//     looked up once from Meta and remembered on the order.
// The result is stored in orders.meta_campaign_id / meta_adset_id. With no ad
// click in the window, the last visit's UTMs are stored as they are.
//
// Deliberately its own step rather than part of syncShopifyOrders: it only ever
// writes the utm_* / meta_* / attribution_synced_at columns, so it can re-read
// any window (including a historical backfill) without the risk a full order
// re-sync carries of restating validated revenue. It also has to run later than
// the order sync anyway: Shopify builds the journey asynchronously, so a fresh
// order often isn't `ready` yet - those are skipped and picked up on a later run
// while they are still inside the look-back window.

// 50 orders x up to 50 visits each stays inside Shopify's per-query cost limit.
const PAGE_SIZE = 50;
const MOMENTS_PER_ORDER = 50;
const LOOKBACK_DAYS = 3;
// Meta's own default click window.
const AD_CLICK_WINDOW_DAYS = 7;
const UPDATE_CONCURRENCY = 10;
// meta_campaign_id of a Meta click whose campaign can't be told (see resolveCampaigns).
export const UNKNOWN_META_CAMPAIGN = "unknown";
const LOOKUP_CONCURRENCY = 5;
const META_GRAPH = "https://graph.facebook.com/v21.0";

// Meta object ids are all digits.
const META_ID = /^\d{6,}$/;
const META_SOURCE = /^(fb|facebook|ig|instagram|meta|an|msg|messenger|threads)$/i;
const OTHER_AD_SOURCE = /tiktok|google|youtube|snap|bing|twitter|x\.com/i;
const PAID_MEDIUM = /paid|cpc|ppc|pmax|^ads?$/i;

type Utm = {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  content?: string | null;
  term?: string | null;
} | null;

type Visit = { occurredAt?: string | null; utmParameters?: Utm };

type JourneyNode = {
  id: string;
  createdAt: string;
  customerJourneySummary?: {
    ready?: boolean | null;
    lastVisit?: Visit | null;
    moments?: { edges?: { node: Visit }[] | null } | null;
  } | null;
};

type AttributionPage = {
  orders: { pageInfo: { hasNextPage: boolean }; edges: { cursor: string; node: JourneyNode }[] };
};

const QUERY = `
  query Attribution($cursor: String, $searchQuery: String) {
    orders(first: ${PAGE_SIZE}, after: $cursor, query: $searchQuery, sortKey: CREATED_AT) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node {
          id
          createdAt
          customerJourneySummary {
            ready
            lastVisit { occurredAt utmParameters { source medium campaign content term } }
            moments(first: ${MOMENTS_PER_ORDER}) {
              edges { node { occurredAt ... on CustomerVisit { utmParameters { source medium campaign content term } } } }
            }
          }
        }
      }
    }
  }
`;

type AttributionRow = {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  meta_campaign_id: string | null;
  meta_adset_id: string | null;
};

const FIELDS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "meta_campaign_id",
  "meta_adset_id",
] as const satisfies readonly (keyof AttributionRow)[];

function clean(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

function isAdVisit(u: Utm): boolean {
  if (!u) return false;
  return PAID_MEDIUM.test(u.medium?.trim() ?? "") || META_ID.test(u.campaign?.trim() ?? "") || META_ID.test(u.term?.trim() ?? "");
}

function isMetaVisit(u: Utm): boolean {
  if (!isAdVisit(u)) return false;
  const source = u?.source?.trim() ?? "";
  if (OTHER_AD_SOURCE.test(source)) return false;
  return META_SOURCE.test(source) || META_ID.test(u?.campaign?.trim() ?? "") || META_ID.test(u?.term?.trim() ?? "");
}

export type AttributionResult = {
  ok: boolean;
  ordersChecked: number;
  ordersUpdated: number;
  notReady: number;
  error?: string;
};

// Re-reads the journeys of orders created on Egypt days [from, to] (default: the
// last LOOKBACK_DAYS days through today) and stores each order's last ad click.
export async function syncShopifyAttribution(opts: { from?: string; to?: string } = {}): Promise<AttributionResult> {
  const today = egyptToday();
  const from = opts.from ?? addDays(today, -LOOKBACK_DAYS);
  const to = opts.to ?? today;

  try {
    const accessToken = await getShopifyAccessToken();
    // Egypt days are fixed UTC+3, the same rule orders.egypt_day is built on.
    const searchQuery = `created_at:>='${from}T00:00:00+03:00' AND created_at:<'${addDays(to, 1)}T00:00:00+03:00'`;

    const found = new Map<string, AttributionRow>();
    let notReady = 0;
    let cursor: string | null = null;
    while (true) {
      const data: AttributionPage = await shopifyGraphQL<AttributionPage>(accessToken, QUERY, { cursor, searchQuery });
      const edges = data.orders.edges;
      for (const { node } of edges) {
        const journey = node.customerJourneySummary;
        // No summary at all = an order with no online-store visit behind it
        // (draft, manual), which will never get one - stored as checked with no
        // UTMs. `ready: false` is a journey Shopify is still building.
        if (journey && !journey.ready) {
          notReady++;
          continue;
        }
        const click = journey ? lastAdClick(node.createdAt, journey) : null;
        const utm = click ?? journey?.lastVisit?.utmParameters ?? null;
        const meta = Boolean(click && isMetaVisit(click));
        const campaign = clean(utm?.campaign);
        const term = clean(utm?.term);
        found.set(node.id.split("/").pop()!, {
          utm_source: clean(utm?.source),
          utm_medium: clean(utm?.medium),
          utm_campaign: campaign,
          utm_content: clean(utm?.content),
          utm_term: term,
          // Meta clicks only; resolveCampaigns fills the ones without a campaign id.
          meta_campaign_id: meta ? (campaign && META_ID.test(campaign) ? campaign : UNKNOWN_META_CAMPAIGN) : null,
          meta_adset_id: meta && term && META_ID.test(term) ? term : null,
        });
      }
      if (!data.orders.pageInfo.hasNextPage || edges.length === 0) break;
      cursor = edges[edges.length - 1].cursor;
    }

    await resolveCampaigns([...found.values()]);

    // Only write what changed, so the daily run is a handful of updates rather
    // than one per order in the window.
    const ids = [...found.keys()];
    const stored = new Map<string, AttributionRow & { attribution_synced_at: string | null }>();
    for (const batch of inBatches(ids)) {
      const { data, error } = await supabase
        .from("orders")
        .select(`shopify_order_id, ${FIELDS.join(", ")}, attribution_synced_at`)
        .in("shopify_order_id", batch);
      if (error) throw new Error(`Failed to read stored attribution: ${error.message}`);
      for (const row of (data ?? []) as unknown as (AttributionRow & { shopify_order_id: string | number; attribution_synced_at: string | null })[]) {
        stored.set(String(row.shopify_order_id), row);
      }
    }

    const changed = ids.filter((id) => {
      const s = stored.get(id);
      if (!s) return false; // not synced into orders yet - the next run catches it
      const f = found.get(id)!;
      return s.attribution_synced_at === null || FIELDS.some((k) => s[k] !== f[k]);
    });

    const now = new Date().toISOString();
    for (const batch of inBatches(changed, UPDATE_CONCURRENCY)) {
      await Promise.all(
        batch.map(async (id) => {
          const { error } = await supabase
            .from("orders")
            .update({ ...found.get(id)!, attribution_synced_at: now })
            .eq("shopify_order_id", id);
          if (error) throw new Error(`Failed to store attribution for order ${id}: ${error.message}`);
        })
      );
    }

    return { ok: true, ordersChecked: found.size, ordersUpdated: changed.length, notReady };
  } catch (err) {
    return {
      ok: false,
      ordersChecked: 0,
      ordersUpdated: 0,
      notReady: 0,
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
}

// The UTMs of the most recent paid-ad visit before the order within
// AD_CLICK_WINDOW_DAYS, or null.
function lastAdClick(orderCreatedAt: string, journey: NonNullable<JourneyNode["customerJourneySummary"]>): Utm {
  const orderTime = Date.parse(orderCreatedAt);
  const earliest = orderTime - AD_CLICK_WINDOW_DAYS * 86_400_000;
  let best: { time: number; utm: Utm } | null = null;
  const visits = [...(journey.moments?.edges ?? []).map((e) => e.node), journey.lastVisit ?? {}];
  for (const v of visits) {
    if (!v.occurredAt || !isAdVisit(v.utmParameters ?? null)) continue;
    const time = Date.parse(v.occurredAt);
    if (time < earliest || time > orderTime) continue;
    if (!best || time > best.time) best = { time, utm: v.utmParameters ?? null };
  }
  return best?.utm ?? null;
}

// Fills meta_campaign_id for Meta clicks tagged with an ad set id but a label
// (not an id) in utm_campaign. An ad set never moves campaign, so an answer
// already stored on another order is reused; the rest are asked from Meta.
// One the token can't see (deleted, another account) stays UNKNOWN_META_CAMPAIGN,
// and the order shows under "Meta ad, campaign unknown" - as does a Meta click
// tagged with labels only, no ids.
async function resolveCampaigns(rows: AttributionRow[]): Promise<void> {
  const pending = rows.filter((r) => r.meta_campaign_id === UNKNOWN_META_CAMPAIGN && r.meta_adset_id !== null);
  if (pending.length === 0) return;
  const adsets = [...new Set(pending.map((r) => r.meta_adset_id!))];

  const campaignOf = new Map<string, string>();
  for (const batch of inBatches(adsets)) {
    const { data, error } = await supabase
      .from("orders")
      .select("meta_adset_id, meta_campaign_id")
      .in("meta_adset_id", batch)
      .not("meta_campaign_id", "is", null)
      .neq("meta_campaign_id", UNKNOWN_META_CAMPAIGN)
      .limit(1000);
    if (error) throw new Error(`Failed to read known ad sets: ${error.message}`);
    for (const row of data ?? []) campaignOf.set(row.meta_adset_id, row.meta_campaign_id);
  }

  const unknown = adsets.filter((id) => !campaignOf.has(id));
  for (const [id, campaign] of await fetchCampaignIds(unknown)) campaignOf.set(id, campaign);

  for (const r of pending) r.meta_campaign_id = campaignOf.get(r.meta_adset_id!) ?? UNKNOWN_META_CAMPAIGN;
}

// Ad set id -> campaign id, from Meta - one request per ad set (Graph no longer
// takes several ids in one read). An id the token can't read is left out.
async function fetchCampaignIds(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return out;
  for (const batch of inBatches(ids, LOOKUP_CONCURRENCY)) {
    await Promise.all(
      batch.map(async (id) => {
        const params = new URLSearchParams({ fields: "campaign_id", access_token: token });
        const res = await fetch(`${META_GRAPH}/${id}?${params.toString()}`).catch(() => null);
        const body = (await res?.json().catch(() => null)) as { campaign_id?: string } | null;
        if (res?.ok && body?.campaign_id) out.set(id, String(body.campaign_id));
      })
    );
  }
  return out;
}

import "server-only";

const META_API_VERSION = "v21.0";

// Miraj runs one CAMPAIGN per product, so ad spend is tracked at the
// campaign level (not ad/adset like izar). campaign_id is the key mapped to a
// product/model.
//
// Every call takes the ad account explicitly: Miraj has several accounts (see
// src/lib/meta-accounts.ts) and the caller is the only thing that knows which
// segment the results belong to.
export type MetaAdInsight = {
  campaign_id: string;
  campaign_name?: string;
  spend: string;
  date_start: string;
};

// The exception: a campaign listed in ADSET_LEVEL_CAMPAIGNS (an ABO test rig
// whose ad sets each push a DIFFERENT product) is pulled one level deeper, so
// each ad set can be allocated to its own model. See fetchMetaAdsetInsights.
export type MetaAdsetInsight = MetaAdInsight & {
  adset_id: string;
  adset_name?: string;
};

// Display names for the ad accounts, keyed by bare account id. Best-effort: a
// name is a label in the allocation popup, never a figure, so a failed lookup
// returns an empty map rather than failing the whole spend sync behind it.
export async function fetchAdAccountNames(adAccountIds: string[]): Promise<Map<string, string>> {
  const token = process.env.META_ACCESS_TOKEN;
  const names = new Map<string, string>();
  if (!token) return names;

  await Promise.all(
    adAccountIds.map(async (id) => {
      try {
        const res = await fetch(
          `https://graph.facebook.com/${META_API_VERSION}/act_${id}?fields=name&access_token=${encodeURIComponent(token)}`
        );
        if (!res.ok) return;
        const body = await res.json();
        if (typeof body?.name === "string" && body.name.trim()) names.set(id, body.name.trim());
      } catch {
        // Leave this account unnamed; the popup falls back to a placeholder.
      }
    })
  );

  return names;
}

export async function fetchMetaAdInsights(
  adAccountId: string,
  since: string,
  until: string
): Promise<MetaAdInsight[]> {
  return metaInsights<MetaAdInsight>({
    adAccountId,
    since,
    until,
    level: "campaign",
    fields: "campaign_id,campaign_name,spend",
  });
}

// Ad-set-level spend for specific campaigns only. Filtered server-side by Meta
// so the payload stays small - the rest of the account keeps coming back at
// campaign level from fetchMetaAdInsights.
export async function fetchMetaAdsetInsights(
  adAccountId: string,
  since: string,
  until: string,
  campaignIds: string[]
): Promise<MetaAdsetInsight[]> {
  if (campaignIds.length === 0) return [];
  return metaInsights<MetaAdsetInsight>({
    adAccountId,
    since,
    until,
    level: "adset",
    fields: "campaign_id,campaign_name,adset_id,adset_name,spend",
    filtering: JSON.stringify([{ field: "campaign.id", operator: "IN", value: campaignIds }]),
  });
}

async function metaInsights<T>(opts: {
  adAccountId: string;
  since: string;
  until: string;
  level: string;
  fields: string;
  filtering?: string;
}): Promise<T[]> {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    throw new Error("Missing META_ACCESS_TOKEN environment variable");
  }

  const params = new URLSearchParams({
    level: opts.level,
    fields: opts.fields,
    time_range: JSON.stringify({ since: opts.since, until: opts.until }),
    time_increment: "1",
    limit: "200",
    access_token: token,
  });
  if (opts.filtering) params.set("filtering", opts.filtering);

  let url: string | null = `https://graph.facebook.com/${META_API_VERSION}/act_${opts.adAccountId}/insights?${params.toString()}`;
  const results: T[] = [];

  while (url) {
    // Explicit annotations break a circular type-inference error TS otherwise
    // raises here: res's inferred type would depend on url's narrowed type,
    // which (via the reassignment below) depends back on res/body.
    const res: Response = await fetch(url);
    const body: any = await res.json();
    if (!res.ok || body.error) {
      // Name the account - with several in play, "which one?" is the first
      // question a failure raises.
      throw new Error(
        `Meta insights request failed for act_${opts.adAccountId}: ${res.status} ${JSON.stringify(body.error ?? body)}`
      );
    }
    results.push(...(body.data ?? []));
    url = body.paging?.next ?? null;
  }

  return results;
}

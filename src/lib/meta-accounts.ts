import "server-only";
import type { AdSegment } from "@/lib/ad-segment";

export type { AdSegment };

// Miraj runs several Meta ad accounts. Which SEGMENT a spend row belongs to is
// decided purely by which account it came from: the retail accounts pool into
// one retail number, the wholesale account is reported on its own.
//
// Configured as two comma-separated env lists so accounts can be added or moved
// between segments without a deploy-time code change:
//
//   META_RETAIL_AD_ACCOUNT_IDS=111111111111111,222222222222222,333333333333333
//   META_WHOLESALE_AD_ACCOUNT_IDS=444444444444444

export type MetaAdAccount = {
  id: string; // bare numeric id, no "act_" prefix
  segment: AdSegment;
};

// Meta ids are numeric, but the Ads Manager UI and URL both show them as
// "act_<id>" - so a prefixed value gets pasted into .env.local sooner or later.
// meta.ts builds the URL as act_${id}, which would make that act_act_<id> and
// 400 every request. Normalise rather than throw: a cron failing at 3am over a
// copy-paste artifact helps nobody.
function parseIds(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("act_") ? s.slice(4) : s));
}

export function getMetaAdAccounts(): MetaAdAccount[] {
  const retail = parseIds(process.env.META_RETAIL_AD_ACCOUNT_IDS);
  const wholesale = parseIds(process.env.META_WHOLESALE_AD_ACCOUNT_IDS);

  if (retail.length === 0 && wholesale.length === 0) {
    throw new Error(
      "No Meta ad accounts configured - set META_RETAIL_AD_ACCOUNT_IDS and/or META_WHOLESALE_AD_ACCOUNT_IDS"
    );
  }

  const bad = [...retail, ...wholesale].filter((id) => !/^\d+$/.test(id));
  if (bad.length > 0) {
    throw new Error(`Meta ad account ids must be numeric, got: ${bad.join(", ")}`);
  }

  // The same account in both lists would be synced twice, and the second pass
  // would overwrite the first's segment - silently moving spend between
  // segments on every run. Fail loudly instead.
  const overlap = retail.filter((id) => wholesale.includes(id));
  if (overlap.length > 0) {
    throw new Error(
      `Meta ad account(s) listed as BOTH retail and wholesale: ${overlap.join(", ")}`
    );
  }

  const duplicates = [...retail, ...wholesale].filter((id, i, all) => all.indexOf(id) !== i);
  if (duplicates.length > 0) {
    throw new Error(`Meta ad account id listed twice: ${[...new Set(duplicates)].join(", ")}`);
  }

  return [
    ...retail.map((id): MetaAdAccount => ({ id, segment: "retail" })),
    ...wholesale.map((id): MetaAdAccount => ({ id, segment: "wholesale" })),
  ];
}

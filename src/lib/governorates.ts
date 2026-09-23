// Shopify and Bosta each spell governorate names differently from each other
// and from our canonical list (seeded in governorate_fees). This maps every
// variant actually observed in real data back to the canonical name.
const ALIASES: Record<string, string> = {
  // Shopify spellings
  "al sharqia": "Sharqia",
  "kafr el-sheikh": "Kafr El Sheikh",
  "6th of october": "Giza", // satellite city within Giza governorate - same rate as Giza
  // Helwan is a district of Cairo but Bosta prices it as its own zone (108 vs
  // Cairo's 93 on the 2026-08-04 card), so it stays canonical rather than
  // folding into Cairo. In practice this rarely fires: Bosta's own
  // outcome_governorate reports these addresses as "Cairo" and wins over the
  // Shopify spelling, so only orders with no Bosta outcome yet land on Helwan.
  // Bosta spellings
  assuit: "Asyut",
  "bani suif": "Beni Suef",
  behira: "Beheira",
  "el kalioubia": "Qalyubia",
  fayoum: "Faiyum",
  "kafr alsheikh": "Kafr El Sheikh",
  menya: "Minya",
};

export function normalizeGovernorate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const alias = ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  return trimmed; // assume it's already canonical (exact matches need no mapping)
}

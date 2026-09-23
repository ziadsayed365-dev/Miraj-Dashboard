// Which side of the business a row belongs to. Miraj runs a retail operation
// and a separate wholesale one; they share a product catalogue but are reported
// independently (their own ad spend, and their own sales).
//
// Plain module (no "server-only") so the eventual segment toggle in the UI can
// import the same type the sync and the reports use.
export type AdSegment = "retail" | "wholesale";

export const AD_SEGMENTS: readonly AdSegment[] = ["retail", "wholesale"] as const;

export const AD_SEGMENT_LABELS: Record<AdSegment, string> = {
  retail: "Retail",
  wholesale: "Wholesale",
};

// Every existing report is a RETAIL report. Wholesale spend is ingested from
// day one (so no history is lost) but deliberately excluded from these numbers,
// because a wholesale P&L needs wholesale SALES to sit against - and those are
// still hand-recorded, not built yet.
//
// Without this filter, adding the wholesale ad account to .env.local would
// quietly inflate the retail cost lines and nothing would look broken.
//
// When the global Retail/Wholesale/All toggle lands, this constant is what the
// reports stop hardcoding and start taking as a parameter.
export const REPORTED_AD_SEGMENT: AdSegment = "retail";

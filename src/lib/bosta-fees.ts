import "server-only";
import { supabase } from "@/lib/supabase";

// Bosta's price list, read as-of a given day.
//
// Every fee here is effective-dated (see 0053): Bosta re-priced on 2026-08-04
// and closed the open-package fee, and a rate change must never rewrite margins
// that were already reported - margin.ts recomputes a rolling window, so a flat
// "current rate" table would silently restate the previous months every night.
//
// Note this is deliberately unlike product costs, which 0050 keeps flat: a
// built cost is a live BOM rollup and cannot honestly be dated, whereas a
// courier rate card genuinely changes on a date.
//
// Lives here rather than in either caller because margin.ts (realized) and
// reports/open-month-projection.ts (projected) both need the identical lookup,
// and the two drifting apart would put the open month on a different price list
// from the closed ones.

export type FeeColumn = "deliver" | "exchange" | "return_pickup" | "return_to_origin";
export type ZoneFees = Record<FeeColumn, number>;

export type BostaFeeBook = {
  /** Canonical governorate -> fee-matrix zone. Null when the governorate is unknown. */
  zoneFor(governorate: string | null): string | null;
  /** The zone's rates in force on `day`, or null if the zone has no row yet. */
  feesFor(zone: string | null, shipmentSize: string, day: string): ZoneFees | null;
  /** Flat per-shipment open-package fee on `day`, VAT included. Zero from 2026-08-04. */
  openPackageFeeTotal(day: string): number;
  /** "Next Day" cash-settlement fee on `day`, as a fraction of COD collected. */
  codCashFeePct(day: string): number;
};

type Timeline<T> = Array<{ effectiveFrom: string; value: T }>;

// Rows arrive sorted ascending, so the last entry that has already taken effect
// on `day` wins. Dates are ISO 'YYYY-MM-DD' on both sides, where string order
// is date order.
function asOf<T>(timeline: Timeline<T> | undefined, day: string): T | null {
  if (!timeline) return null;
  let result: T | null = null;
  for (const entry of timeline) {
    if (entry.effectiveFrom <= day) result = entry.value;
    else break;
  }
  return result;
}

export async function loadBostaFeeBook(): Promise<BostaFeeBook> {
  const [matrixRes, periodRes, govRes] = await Promise.all([
    supabase
      .from("bosta_fee_matrix")
      .select("zone, shipment_size, effective_from, deliver, exchange, return_pickup, return_to_origin")
      .order("effective_from", { ascending: true }),
    supabase
      .from("bosta_fee_periods")
      .select("effective_from, open_package_fee, open_package_vat_pct, cod_cash_fee_pct")
      .order("effective_from", { ascending: true }),
    supabase.from("governorate_fees").select("governorate, zone"),
  ]);

  if (matrixRes.error) throw new Error(`Failed to load fee matrix: ${matrixRes.error.message}`);
  if (periodRes.error) throw new Error(`Failed to load fee periods: ${periodRes.error.message}`);
  if (govRes.error) throw new Error(`Failed to load governorate zones: ${govRes.error.message}`);

  const matrix = new Map<string, Timeline<ZoneFees>>();
  for (const row of matrixRes.data ?? []) {
    const key = `${row.zone}::${row.shipment_size}`;
    const timeline = matrix.get(key) ?? [];
    timeline.push({
      effectiveFrom: row.effective_from,
      value: {
        deliver: Number(row.deliver),
        exchange: Number(row.exchange),
        return_pickup: Number(row.return_pickup),
        return_to_origin: Number(row.return_to_origin),
      },
    });
    matrix.set(key, timeline);
  }

  // The open-package fee is stored ex-VAT (the matrix rates are already
  // VAT-inclusive), so it gets grossed up once here rather than at each use.
  const periods: Timeline<{ openPackageFeeTotal: number; codCashFeePct: number }> = (periodRes.data ?? []).map(
    (row) => ({
      effectiveFrom: row.effective_from,
      value: {
        openPackageFeeTotal: Number(row.open_package_fee) * (1 + Number(row.open_package_vat_pct)),
        codCashFeePct: Number(row.cod_cash_fee_pct),
      },
    })
  );

  const zones = new Map((govRes.data ?? []).map((r) => [r.governorate, r.zone as string | null]));

  return {
    zoneFor: (governorate) => (governorate ? zones.get(governorate) ?? null : null),
    feesFor: (zone, shipmentSize, day) => (zone ? asOf(matrix.get(`${zone}::${shipmentSize}`), day) : null),
    openPackageFeeTotal: (day) => asOf(periods, day)?.openPackageFeeTotal ?? 0,
    codCashFeePct: (day) => asOf(periods, day)?.codCashFeePct ?? 0,
  };
}

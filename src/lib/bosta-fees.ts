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
  /**
   * The courier rates actually in force on `day`: J&T's card from the day it
   * takes effect (2026-10-24, migration 0088), Bosta's before - and Bosta's
   * after too for a parcel that still went with Bosta (`withBosta`, see
   * shippedWithBosta). Null if the zone has no row yet.
   */
  feesFor(zone: string | null, shipmentSize: string, day: string, withBosta?: boolean): ZoneFees | null;
  /**
   * J&T's COD fee for one shipment collecting `codAmount` on `day`: 1% of the
   * whole amount once it is above 1,500 EGP, nothing below (migration 0088).
   * Owed only on delivery, when the cash is collected. Zero on Bosta parcels and
   * on days before the switch - Bosta's cash fee is the separate Next Day line.
   */
  courierCodFee(zone: string | null, day: string, codAmount: number, withBosta?: boolean): number;
  /** Flat per-shipment open-package fee on `day`, VAT included. Zero from 2026-08-04. */
  openPackageFeeTotal(day: string): number;
  /** "Next Day" cash-settlement fee on `day`, as a fraction of COD collected. Zero from 2026-10-24 (moved to J&T). */
  codCashFeePct(day: string): number;
};

// The switch to J&T is by tracking number, not date alone: a parcel still
// booked through Bosta carries a Bosta tracking number (all digits), while
// J&T's start "JEG". That decides which card prices it, so a stray Bosta parcel
// on or after the switch day is still billed on Bosta's card. Same rule O
// Garage uses.
export function shippedWithBosta(trackingNumber: string | null | undefined): boolean {
  return !!trackingNumber && /^\d+$/.test(trackingNumber.trim());
}

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
  const [matrixRes, periodRes, govRes, jtRes] = await Promise.all([
    supabase
      .from("bosta_fee_matrix")
      .select("zone, shipment_size, effective_from, deliver, exchange, return_pickup, return_to_origin")
      .order("effective_from", { ascending: true }),
    supabase
      .from("bosta_fee_periods")
      .select("effective_from, open_package_fee, open_package_vat_pct, cod_cash_fee_pct")
      .order("effective_from", { ascending: true }),
    supabase.from("governorate_fees").select("governorate, zone"),
    supabase
      .from("jt_fee_matrix")
      .select("zone, effective_from, deliver, exchange, return_pickup, return_to_origin, cod_fee_pct, cod_fee_threshold")
      .order("effective_from", { ascending: true }),
  ]);

  if (matrixRes.error) throw new Error(`Failed to load fee matrix: ${matrixRes.error.message}`);
  if (periodRes.error) throw new Error(`Failed to load fee periods: ${periodRes.error.message}`);
  if (govRes.error) throw new Error(`Failed to load governorate zones: ${govRes.error.message}`);
  if (jtRes.error) throw new Error(`Failed to load J&T fee matrix: ${jtRes.error.message}`);

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

  // J&T quotes one rate per zone up to 1 kg, so there is no size dimension -
  // every Miraj parcel is inside that band. Stored all-in (quote x 1.254), the
  // same VAT-inclusive basis as the Bosta rows.
  const jt = new Map<string, Timeline<ZoneFees>>();
  const jtCod = new Map<string, Timeline<{ pct: number; threshold: number }>>();
  for (const row of jtRes.data ?? []) {
    const timeline = jt.get(row.zone) ?? [];
    timeline.push({
      effectiveFrom: row.effective_from,
      value: {
        deliver: Number(row.deliver),
        exchange: Number(row.exchange),
        return_pickup: Number(row.return_pickup),
        return_to_origin: Number(row.return_to_origin),
      },
    });
    jt.set(row.zone, timeline);
    const codTimeline = jtCod.get(row.zone) ?? [];
    codTimeline.push({
      effectiveFrom: row.effective_from,
      value: { pct: Number(row.cod_fee_pct), threshold: Number(row.cod_fee_threshold) },
    });
    jtCod.set(row.zone, codTimeline);
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

  const bostaFeesFor = (zone: string | null, shipmentSize: string, day: string) =>
    zone ? asOf(matrix.get(`${zone}::${shipmentSize}`), day) : null;

  return {
    zoneFor: (governorate) => (governorate ? zones.get(governorate) ?? null : null),
    // J&T's card as-of `day` for a J&T parcel, Bosta's otherwise (and as the
    // fallback before the switch, when the J&T timeline has no row yet).
    feesFor: (zone, shipmentSize, day, withBosta = false) =>
      (zone && !withBosta ? asOf(jt.get(zone), day) : null) ?? bostaFeesFor(zone, shipmentSize, day),
    courierCodFee: (zone, day, codAmount, withBosta = false) => {
      const cod = zone && !withBosta ? asOf(jtCod.get(zone), day) : null;
      return cod && codAmount > cod.threshold ? codAmount * cod.pct : 0;
    },
    openPackageFeeTotal: (day) => asOf(periods, day)?.openPackageFeeTotal ?? 0,
    codCashFeePct: (day) => asOf(periods, day)?.codCashFeePct ?? 0,
  };
}

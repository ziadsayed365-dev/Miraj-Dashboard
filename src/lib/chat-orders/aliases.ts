import "server-only";
import { supabase } from "@/lib/supabase";
import { extractQuantity, type ProductAlias } from "./whatsapp";
import { optionKey, parseOptionKey } from "./shared";

// Every learned Arabic name, handed to the Chat Orders tab so the paste box can
// match entirely in the browser.
export async function listProductAliases(): Promise<ProductAlias[]> {
  const { data, error } = await supabase.from("product_aliases").select("alias_norm, product_id, variant_id");
  // Table not created yet -> the paste box still works, it just matches nothing
  // but catalog names until the migration is applied.
  if (error) return [];
  return (data ?? []).map((row) => ({
    alias: String(row.alias_norm),
    key: optionKey({ productId: Number(row.product_id), variantId: row.variant_id === null ? null : Number(row.variant_id) }),
  }));
}

export type LearnedAlias = { alias: string; key: string };

export function parseAliasBody(body: unknown): LearnedAlias[] {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(b.aliases) ? b.aliases : [];
  return raw.map((entry) => {
    const a = (entry ?? {}) as Record<string, unknown>;
    return { alias: String(a.alias ?? ""), key: String(a.key ?? "") };
  });
}

// Teaches phrases seen in a paste. Upsert on alias_norm: re-teaching a phrase
// repoints it at the newly chosen option, which is what correcting a bad match
// should do. Deduped within the batch because one paste can resolve the same
// phrase on several orders, and Postgres rejects a single statement that hits the
// same conflict key twice.
export async function learnProductAliases(entries: LearnedAlias[]): Promise<number> {
  const rows = new Map<string, { product_id: number; variant_id: number | null; alias_norm: string; alias_text: string; updated_at: string }>();
  for (const entry of entries) {
    // Same key the matcher builds: the quantity marker is dropped, so a line sent
    // as "زيت ارجان ×٢" is learned as "زيت ارجان" and matches at any quantity.
    const alias_norm = extractQuantity(entry.alias).name;
    // Too short to be a product name - matching on it would misfire everywhere.
    if (alias_norm.length < 3) continue;
    const ref = parseOptionKey(entry.key);
    if (!ref || !Number.isFinite(ref.productId)) continue;
    if (ref.variantId !== null && !Number.isFinite(ref.variantId)) continue;
    rows.set(alias_norm, {
      product_id: ref.productId,
      variant_id: ref.variantId,
      alias_norm,
      alias_text: entry.alias.trim().slice(0, 300),
      updated_at: new Date().toISOString(),
    });
  }
  if (rows.size === 0) return 0;

  const { error } = await supabase.from("product_aliases").upsert([...rows.values()], { onConflict: "alias_norm" });
  if (error) throw new Error(`Failed to save product aliases: ${error.message}`);
  return rows.size;
}

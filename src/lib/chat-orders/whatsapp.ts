// Turns pasted WhatsApp order messages into reviewable chat-order drafts.
//
// Client-safe (no supabase / server-only imports) - the Chat Orders tab runs this
// in the browser as the owner types, so a paste of 10-20 messages resolves with no
// round trip. Nothing here writes: every parse is a *proposal* the owner confirms
// in the review step before it becomes an order.
//
// Only two things are taken from each message: the product lines and the total
// BEFORE shipping. Name, phone and address are deliberately dropped - the chat
// order model has nowhere to put them - and the after-shipping total is ignored
// because shipping is not Miraj's revenue.
//
// Ported from Laurel. The only change: a match resolves to an option KEY
// (product + optional variant) rather than a bare product id, because Miraj
// costs multi-variant products per variant.

import type { ChatOrderProduct } from "./shared";

// A single alias→option pair as the matcher needs it. Built server-side from
// product_aliases; alias is expected pre-normalized.
export type ProductAlias = { alias: string; key: string };

export type ParsedLine = {
  raw: string; // the message line as written, shown next to the row in review
  quantity: number;
  key: string | null; // null = no alias matched, owner picks it by hand
};

export type ParsedOrder = {
  lines: ParsedLine[];
  revenue: number | null; // the "قبل الشحن" figure; null when the message lacks one
  notes: string[]; // things the owner should look at before submitting
};

const ARABIC_INDIC = /[٠-٩۰-۹]/g;
const DIACRITICS = /[ً-ْٰـ]/g;

// Folds the many ways the same Arabic word gets typed into one comparable key:
// Arabic-Indic digits to ASCII, diacritics and tatweel dropped, the alef/yeh/teh
// variants unified, and every punctuation run flattened to a single space. Must
// stay in lockstep with the alias_norm column (see 0049_product_aliases.sql).
// ٦٣٢ -> 632. Split out from normalizeArabic because quantity markers ("×٢") must
// be read while the punctuation around them still exists.
function foldDigits(input: string): string {
  return input.replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) & 0xf));
}

export function normalizeArabic(input: string): string {
  return foldDigits(input)
    .replace(DIACRITICS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[ىی]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

// Lines that carry customer/delivery detail rather than an order line. Matched on
// the normalized text, so "الإسم" and "الاسم" both land here.
const METADATA_PREFIXES = [
  "الاسم",
  "اسم",
  "الاسم بالكامل",
  "رقم التلفون",
  "رقم التليفون",
  "رقم الهاتف",
  "الرقم",
  "رقم",
  "تليفون",
  "تلفون",
  "موبايل",
  "العنوان",
  "عنوان",
  "المحافظه",
  "محافظه",
  "ملاحظات",
];

// "الإجمالي قبل الشحن : ٦٣٢جنيه" - the figure we bank.
const BEFORE_SHIPPING = /قبل\s*الشحن/;
// "بعد الشحن ٦٧٥.٤٠" and bare shipping-fee lines - read past, never a product.
const AFTER_SHIPPING = /بعد\s*الشحن|^الشحن\b|^شحن\b|^مصاريف\s*الشحن/;

function isMetadata(norm: string): boolean {
  if (norm === "") return true;
  // A line that is nothing but a phone number (no label) is still metadata.
  if (/^\+?\d[\d\s]{6,}$/.test(norm)) return true;
  return METADATA_PREFIXES.some((p) => norm === p || norm.startsWith(p + " "));
}

// Last number in the line: "الإجمالي قبل الشحن : 632جنيه" -> 632. Last rather than
// first because the label can itself contain a digit.
function lastNumber(norm: string): number | null {
  const matches = norm.match(/\d+(?:[.,]\d+)?/g);
  if (!matches) return null;
  const value = Number(matches[matches.length - 1].replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

// Quantity is only read from an explicit marker - "×2", "x 2", "*2", "عدد 2", or a
// count leading the line ("2 صابون"). A bare trailing number is left alone: on a
// product line it is far more often a price than a count, and inventing a quantity
// of 632 is worse than defaulting to 1 and letting the owner fix it.
const QTY_PATTERNS: RegExp[] = [
  /[×*x]\s*(\d{1,3})\b/,
  /\bعدد\s*(\d{1,3})\b/,
  /^(\d{1,3})\s+(?=\D)/,
];

// Runs on the raw line (digits folded, punctuation intact) and returns the name
// with the quantity marker removed, normalized ready for matching.
export function extractQuantity(raw: string): { quantity: number; name: string } {
  const folded = foldDigits(raw);
  for (const pattern of QTY_PATTERNS) {
    const match = folded.match(pattern);
    if (match) {
      const quantity = Number(match[1]);
      if (quantity > 0) return { quantity, name: normalizeArabic(folded.replace(pattern, " ")) };
    }
  }
  return { quantity: 1, name: normalizeArabic(folded) };
}

// Alias hit first, then either direction of containment - the message often adds
// words around a known name, and sometimes drops them. Longest alias wins so the
// most specific name beats a generic one that happens to be a substring of it.
function matchProduct(norm: string, aliases: ProductAlias[], byName: ProductAlias[]): string | null {
  const candidates = [...aliases, ...byName];
  const exact = candidates.find((a) => a.alias === norm);
  if (exact) return exact.key;

  const contained = candidates
    .filter((a) => a.alias.length >= 3 && (norm.includes(a.alias) || a.alias.includes(norm)))
    .sort((a, b) => b.alias.length - a.alias.length)[0];
  return contained?.key ?? null;
}

// One WhatsApp message -> one draft order. Returns null for a block with nothing
// order-shaped in it (a stray "تمام" between pasted messages).
function parseBlock(block: string, aliases: ProductAlias[], byName: ProductAlias[]): ParsedOrder | null {
  const lines: ParsedLine[] = [];
  const notes: string[] = [];
  let revenue: number | null = null;

  for (const rawLine of block.split(/\r?\n/)) {
    const raw = rawLine.trim();
    if (raw === "") continue;
    const norm = normalizeArabic(raw);

    if (BEFORE_SHIPPING.test(norm)) {
      revenue = lastNumber(norm);
      continue;
    }
    if (AFTER_SHIPPING.test(norm)) continue;
    if (isMetadata(norm)) continue;

    const { quantity, name } = extractQuantity(raw);
    lines.push({ raw, quantity, key: matchProduct(name, aliases, byName) });
  }

  if (lines.length === 0 && revenue === null) return null;

  if (revenue === null) notes.push("No “قبل الشحن” total found — type the revenue by hand.");
  if (lines.length === 0) notes.push("No product lines found.");
  const unmatched = lines.filter((l) => l.key === null).length;
  if (unmatched > 0) notes.push(`${unmatched} line${unmatched === 1 ? "" : "s"} didn’t match a product — pick below and it’s remembered.`);

  // Two lines resolving to the same option would fail validate() on save (an
  // option may only appear once per order), so flag it here instead.
  const keys = lines.map((l) => l.key).filter((k): k is string => k !== null);
  if (new Set(keys).size !== keys.length) notes.push("The same product matched twice — merge the rows.");

  return { lines, revenue, notes };
}

// Splits the paste on blank lines - one WhatsApp message per block - and parses
// each. Options are matched against their catalog name too (including the
// variant title), so a line typed the same way as the catalog resolves without
// anyone teaching it an alias first.
export function parseWhatsAppOrders(text: string, aliases: ProductAlias[], products: ChatOrderProduct[]): ParsedOrder[] {
  const byName: ProductAlias[] = products
    .filter((p) => p.isActive)
    .map((p) => ({ alias: normalizeArabic(p.label), key: p.key }));

  return text
    .split(/\r?\n\s*\r?\n/)
    .map((block) => parseBlock(block, aliases, byName))
    .filter((order): order is ParsedOrder => order !== null);
}

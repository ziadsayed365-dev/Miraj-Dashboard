import "server-only";
import { supabase } from "@/lib/supabase";
import { runNightlyAudit, type NightlyAudit } from "@/lib/reports/nightly-audit";
import { dropReportCache } from "@/lib/reports/cache";
import { getDailyPnl } from "@/lib/reports/daily-pnl";
import { getPerProductReport } from "@/lib/reports/per-product";
import { egyptToday, addDays } from "@/lib/dates";
import { computeMargins } from "@/lib/engine/margin";
import { listAllocationCategories } from "@/lib/products/catalog";
import { applyAgentActions, type AgentAction } from "@/lib/agent/actions";
import { renderReportPdf, reportFileName } from "@/lib/report-pdf";
import { sendText, sendPoll, stopPoll, sendDocument } from "@/lib/telegram";

// AI MIRAJ's questions on Telegram. Everything the report is waiting on goes
// out as its own message - one per TikTok day, one per product with no cost,
// one poll per unallocated campaign - and the owner answers each whenever it
// suits them: a reply with the number, or a tap on the poll. The webhook
// (/api/agent/webhook) hands every answer here, it is recorded at once, and
// when nothing is left open the day's report goes out with its PDF.

type Kind = "tiktok" | "cost" | "allocation";

// One poll of an allocation request. step: "category" (pick categories),
// "groups" (pick groups directly, when they all fit in one poll) or
// "sub:<category>" (pick groups inside one chosen category).
type PollEntry = { pollId: string; messageId: number; step: string; options: string[]; answer: number[] | null };

type RequestRow = {
  id: number;
  kind: Kind | "report";
  item_key: string;
  day: string;
  status: "open" | "done";
  message_id: number | null;
  polls: PollEntry[];
  // A test question (sendTestRequests): answered like a real one, records nothing.
  test: boolean;
  label: string | null;
};

// Telegram's limit on poll options.
const MAX_POLL_OPTIONS = 12;
const GENERAL = "General (all products)";
const ALL_OF = "All of ";
const ALL_TIME_START = "2000-01-01";

const egp = (n: number) => `${Math.round(n).toLocaleString("en-US")} EGP`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${Math.round(n * 100)}%`;
const fmtDay = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function origin(fallback: string): string {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return host ? `https://${host}` : fallback;
}

// "3500", "3,500", "3.5k", "٣٥٠٠", "3500 EGP" -> 3500. Null when it isn't a number.
export function parseAmount(text: string): number | null {
  const western = text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫]/g, ".")
    .replace(/[,٬\s]/g, "")
    .replace(/(egp|le|جنيه|ج\.?م?)$/i, "");
  const m = western.match(/^(\d+(?:\.\d+)?)(k)?$/i);
  if (!m) return null;
  return Number(m[1]) * (m[2] ? 1000 : 1);
}

// --- asking -----------------------------------------------------------------

// Opens the request, then sends its question. Opening first means two runs
// racing over the same item can't both ask: the second insert hits the
// one-open-request-per-item index and is skipped.
type Asking = { test: boolean; label: string };

async function open(kind: Kind, itemKey: string, day: string, asking: Asking, send: () => Promise<Partial<RequestRow>>): Promise<boolean> {
  const { data, error } = await supabase
    .from("agent_requests")
    // A test never shares a key with a real question, so it can't block one.
    .insert({ kind, item_key: asking.test ? `test:${itemKey}` : itemKey, day, test: asking.test, label: asking.label })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return false; // already asked and still open
    throw new Error(`Failed to open request: ${error.message}`);
  }
  try {
    const sent = await send();
    await supabase.from("agent_requests").update(sent).eq("id", data.id);
    return true;
  } catch (err) {
    await supabase.from("agent_requests").delete().eq("id", data.id);
    throw err;
  }
}

const testTag = (test: boolean) => (test ? "[TEST - nothing will be saved]\n" : "");

async function askTikTok(date: string, day: string, test = false) {
  return open("tiktok", date, day, { test, label: `TikTok spend for ${fmtDay(date)}` }, async () => ({
    message_id: await sendText(`${testTag(test)}TikTok spend for ${fmtDay(date)}?\n\nReply to this message with the amount in EGP (0 if there was none).`),
  }));
}

async function askCost(p: NightlyAudit["missingCostProducts"][number], day: string, test = false) {
  return open("cost", String(p.productId), day, { test, label: `the unit cost of ${p.name}` }, async () => ({
    message_id: await sendText(
      `${testTag(test)}Cost missing: ${p.name}\n${p.group} - ${p.unitsSold} sold\n\nReply to this message with its unit cost in EGP.`
    ),
  }));
}

async function allocationPoll(question: string, step: string, options: string[]): Promise<PollEntry> {
  const { pollId, messageId } = await sendPoll(question, options);
  return { pollId, messageId, step, options, answer: null };
}

async function askAllocation(c: NightlyAudit["unallocatedCampaigns"][number], day: string, test = false) {
  const categories = await listAllocationCategories();
  const groups = categories.flatMap((cat) => cat.groups);
  const question =
    `${test ? "[TEST] " : ""}Which products is this ad for?\n${c.campaignName ?? c.campaignId}` +
    `${c.adAccountName ? `\n${c.adAccountName}` : ""}\nLast spend ${egp(c.spend)} on ${fmtDay(c.date)}`;
  return open("allocation", c.campaignId, day, { test, label: c.campaignName ?? c.campaignId }, async () => {
    // Every group fits in one poll: pick them directly. Otherwise category
    // first, then a second poll inside each category that has groups.
    const poll =
      groups.length + 1 <= MAX_POLL_OPTIONS
        ? await allocationPoll(question, "groups", [...groups, GENERAL])
        : await allocationPoll(question, "category", [...categories.map((cat) => cat.category), GENERAL].slice(0, MAX_POLL_OPTIONS));
    return { polls: [poll] };
  });
}

// Asks for everything the day's report is waiting on that hasn't been asked
// yet. When nothing is outstanding and nothing is still open, sends the report.
export async function askOrReport(day: string, fallbackOrigin: string): Promise<{ asked: number; reported: boolean }> {
  const audit = await runNightlyAudit(day);
  let asked = 0;
  for (const date of audit.tiktokMissingDays) if (await askTikTok(date, day)) asked++;
  for (const p of audit.missingCostProducts) if (await askCost(p, day)) asked++;
  for (const c of audit.unallocatedCampaigns) if (await askAllocation(c, day)) asked++;

  if (outstanding(audit) > 0 || (await openCount()) > 0) return { asked, reported: false };
  return { asked, reported: await sendReport(audit, fallbackOrigin) };
}

// One of each question, about real items - a product, the latest Meta
// campaign, the real category list - so the whole flow can be tried on
// Telegram. Answers are checked and confirmed but nothing is saved.
export async function sendTestRequests(day: string): Promise<{ asked: number }> {
  const { data: product, error: productErr } = await supabase
    .from("products")
    .select("id, name, category, sub_category")
    .not("category", "is", null)
    .limit(1)
    .single();
  if (productErr) throw new Error(`Failed to pick a product: ${productErr.message}`);
  const { data: ad, error: adErr } = await supabase
    .from("ad_spend")
    .select("campaign_id, campaign_name, ad_account_name, date, spend")
    .eq("source", "meta")
    .not("campaign_id", "is", null)
    .order("date", { ascending: false })
    .order("spend", { ascending: false })
    .limit(1)
    .single();
  if (adErr) throw new Error(`Failed to pick a campaign: ${adErr.message}`);

  let asked = 0;
  if (await askTikTok(day, day, true)) asked++;
  const group = product.sub_category ?? product.category ?? "";
  if (await askCost({ productId: product.id, name: product.name, group, unitsSold: 0 }, day, true)) asked++;
  const campaign = {
    campaignId: ad.campaign_id!,
    campaignName: ad.campaign_name,
    adAccountName: ad.ad_account_name,
    date: String(ad.date).slice(0, 10),
    spend: Number(ad.spend),
  };
  if (await askAllocation(campaign, day, true)) asked++;
  return { asked };
}

async function openCount(): Promise<number> {
  const { count, error } = await supabase
    .from("agent_requests")
    .select("id", { count: "exact", head: true })
    .eq("status", "open")
    .eq("test", false); // an unanswered test never holds up the report
  if (error) throw new Error(`Failed to count open requests: ${error.message}`);
  return count ?? 0;
}

// --- the report ---------------------------------------------------------------

function reportText(a: NightlyAudit): string {
  const { day, average } = a.comparison;
  const vs = (now: number, avg: number) => (avg ? ` (avg ${egp(avg)}, ${pct((now - avg) / Math.abs(avg))})` : "");
  const roas = (n: number | null) => (n === null ? "-" : n.toFixed(1));
  const lines = [
    `AI MIRAJ: ${fmtDay(a.day)} report - ${outstanding(a) ? `${outstanding(a)} item(s) still missing` : "all checks passed"}`,
    "",
    `Contribution profit: ${egp(day.contributionProfit)}${vs(day.contributionProfit, average.contributionProfit)}`,
    `Orders: ${day.ordersPlaced} (avg ${Math.round(average.ordersPlaced)}) - Revenue ${egp(day.revenue)}`,
    `Ad spend: ${egp(day.adSpend)} - ROAS ${roas(day.roas)} (avg ${roas(average.roas)})${day.cpa !== null ? ` - ${egp(day.cpa)} per order` : ""}`,
  ];
  // The groups that moved most against their own average.
  const movers = a.comparison.products
    .map((p) => ({ p, delta: p.day.contributionProfit - p.average.contributionProfit }))
    .filter(({ p, delta }) => Math.abs(delta) > Math.max(500, Math.abs(p.average.contributionProfit) * 0.1))
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
    .slice(0, 3);
  if (movers.length) {
    lines.push("", "Biggest moves vs average:");
    for (const { p } of movers) {
      lines.push(`- ${p.name}: ${egp(p.day.contributionProfit)} contribution (avg ${egp(p.average.contributionProfit)}), ROAS ${roas(p.day.roas)}`);
    }
  }
  const gaps = a.ties.flatMap((t) =>
    (["revenue", "cogs", "adSpend"] as const)
      .filter((line) => !t[line].ok)
      .map((line) => `- ${t.mode} ${line}: Income Statement ${egp(t[line].incomeStatement)} vs by product ${egp(t[line].byProduct)}`)
  );
  if (gaps.length) lines.push("", "Check on the dashboard - the two reports disagree:", ...gaps);
  return lines.join("\n");
}

const outstanding = (a: NightlyAudit) =>
  a.tiktokMissingDays.length + a.missingCostProducts.length + a.unallocatedCampaigns.length;

const PDF_ATTEMPTS = 3;

// The report (with the Campaigns P&L as its last two pages) never goes out
// without its PDF. If it can't be made, the owner is
// told and can reply "pdf" to try again (handleText).
async function sendReport(audit: NightlyAudit, fallbackOrigin: string, opts: { force?: boolean } = {}): Promise<boolean> {
  // Claimed first, so the report goes out once however many answers land at
  // once. A "pdf" request skips the claim: it was asked for.
  if (!opts.force) {
    const { error } = await supabase
      .from("agent_requests")
      .insert({ kind: "report", item_key: audit.day, day: audit.day, status: "done", resolved_at: new Date().toISOString() });
    if (error) {
      if (error.code === "23505") return false;
      throw new Error(`Failed to claim the report: ${error.message}`);
    }
  }
  const release = () =>
    opts.force ? Promise.resolve() : supabase.from("agent_requests").delete().eq("kind", "report").eq("item_key", audit.day).then(() => {});

  // The print page is built from the whole P&L history; computing it here
  // first leaves it in the shared report cache, so the page renders well inside
  // its timeout instead of computing it all from cold.
  await Promise.all([
    getDailyPnl(ALL_TIME_START, audit.day, "performance"),
    getPerProductReport(audit.day, audit.day, "performance"),
  ]).catch(() => {});

  let pdf: Buffer | null = null;
  let lastError = "";
  for (let attempt = 1; attempt <= PDF_ATTEMPTS && !pdf; attempt++) {
    try {
      pdf = await renderReportPdf(origin(fallbackOrigin), audit.day);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`report PDF attempt ${attempt} failed:`, err);
    }
  }
  try {
    if (!pdf) {
      await release();
      await sendText(
        `AI MIRAJ: ${fmtDay(audit.day)} report is ready, but the PDF didn't come out (${lastError.slice(0, 200)}).

Reply "pdf" to try again.`
      );
      return false;
    }
    await sendDocument(reportText(audit), pdf, reportFileName(audit.day));
    return true;
  } catch (err) {
    // Not sent: release the claim so the next answer or run tries again.
    await release();
    throw err;
  }
}

// --- answers ---------------------------------------------------------------------

async function close(id: number): Promise<void> {
  await supabase.from("agent_requests").update({ status: "done", resolved_at: new Date().toISOString() }).eq("id", id);
}

// What to do once an answer is recorded - runs after the webhook has answered
// Telegram, since the report can take a minute to render.
// pdf: the owner asked for the report ("pdf"), sent whatever else is open.
export type FollowUp = { day: string; recomputeMargins: boolean; pdf?: boolean } | null;

export async function followUp(f: FollowUp, fallbackOrigin: string): Promise<void> {
  if (!f) return;
  if (f.pdf) {
    await sendReport(await runNightlyAudit(f.day), fallbackOrigin, { force: true });
    return;
  }
  if (f.recomputeMargins) {
    // A new cost only reaches the margins on their next recompute - the same
    // step Sync runs.
    await computeMargins();
    dropReportCache();
  }
  if ((await openCount()) === 0) await askOrReport(f.day, fallbackOrigin);
}

// A text message: the number answering a TikTok or cost question.
export async function handleText(text: string, messageId: number, replyTo: number | null): Promise<FollowUp> {
  // "pdf", "report", "redo", "resend"... (optionally with a day): send that
  // day's report now.
  const ask = text.trim().match(/^(pdf|report|redo|resend|again|send|تقرير|اعاده|اعادة|إعادة)(?:\s+(\d{4}-\d{2}-\d{2}))?$/i);
  if (ask) {
    const day = ask[2] ?? addDays(egyptToday(), -1);
    await sendText(`Making the ${fmtDay(day)} report...`, messageId);
    return { day, recomputeMargins: false, pdf: true };
  }
  let request: RequestRow | null = null;
  if (replyTo) {
    const { data } = await supabase.from("agent_requests").select("*").eq("message_id", replyTo).maybeSingle();
    request = data as RequestRow | null;
    if (request?.status === "done") {
      await sendText("That one is already recorded. To change it, use the dashboard.", messageId);
      return null;
    }
  }
  if (!request) {
    // Not a reply: fine when only one question is waiting for a number.
    const { data } = await supabase.from("agent_requests").select("*").eq("status", "open").in("kind", ["tiktok", "cost"]);
    const waiting = (data ?? []) as RequestRow[];
    if (waiting.length !== 1) {
      await sendText(
        waiting.length
          ? "Reply to the question you're answering (swipe left on it), with just the number."
          : 'Nothing is waiting for an answer right now. Send "pdf" to get yesterday\'s report again.',
        messageId
      );
      return null;
    }
    request = waiting[0];
  }
  if (request.kind !== "tiktok" && request.kind !== "cost") {
    await sendText("Answer that one by tapping the poll.", messageId);
    return null;
  }

  const amount = parseAmount(text.trim());
  if (amount === null || (request.kind === "cost" && amount <= 0)) {
    await sendText(request.kind === "cost" ? "Send just the unit cost, e.g. 120" : "Send just the amount, e.g. 3500 (0 if none)", messageId);
    return null;
  }

  if (request.test) {
    await close(request.id);
    await sendText(`Test OK - would record ${request.label}: ${amount.toLocaleString("en-US")} EGP. Nothing was saved.`, messageId);
    return null;
  }

  const action: AgentAction =
    request.kind === "tiktok"
      ? { type: "set_tiktok_spend", date: request.item_key, amount }
      : { type: "set_product_cost", productId: Number(request.item_key), unitCost: amount };
  const [result] = await applyAgentActions([action]);
  if (result.ok || /already/i.test(result.detail)) {
    if (result.ok) dropReportCache();
    await close(request.id);
    await sendText(result.ok ? `Recorded - ${result.detail}` : result.detail, messageId);
    return { day: request.day, recomputeMargins: result.ok && request.kind === "cost" };
  }
  await sendText(`Couldn't record it: ${result.detail}`, messageId);
  return null;
}

// A vote on one of the allocation polls.
export async function handlePollAnswer(pollId: string, optionIds: number[]): Promise<FollowUp> {
  if (optionIds.length === 0) return null; // vote withdrawn
  const { data } = await supabase
    .from("agent_requests")
    .select("*")
    .eq("kind", "allocation")
    .eq("status", "open")
    // jsonb containment; .contains() would send an array as a Postgres array.
    .filter("polls", "cs", JSON.stringify([{ pollId }]));
  const request = (data?.[0] ?? null) as RequestRow | null;
  if (!request) return null;

  const polls = request.polls;
  const poll = polls.find((p) => p.pollId === pollId)!;
  if (poll.answer) return null;
  poll.answer = optionIds;
  await stopPoll(poll.messageId);
  const picked = optionIds.map((i) => poll.options[i]);

  // Category step: a category with groups of its own asks again, inside it.
  if (poll.step === "category" && !picked.includes(GENERAL)) {
    const categories = await listAllocationCategories();
    for (const name of picked) {
      const cat = categories.find((c) => c.category === name);
      if (!cat?.hasSubCategories) continue;
      polls.push(
        await allocationPoll(`${name}: which of these?`, `sub:${name}`, [`${ALL_OF}${name}`, ...cat.groups].slice(0, MAX_POLL_OPTIONS))
      );
    }
  }
  await supabase.from("agent_requests").update({ polls }).eq("id", request.id);
  if (polls.some((p) => !p.answer)) return null;

  // Every poll answered: put the picks together.
  const subCategories: string[] = [];
  const categories: string[] = [];
  let general = false;
  for (const p of polls) {
    const choices = p.answer!.map((i) => p.options[i]);
    if (choices.includes(GENERAL)) general = true;
    for (const choice of choices.filter((c) => c !== GENERAL)) {
      if (p.step === "groups") subCategories.push(choice);
      else if (p.step.startsWith("sub:")) {
        if (choice.startsWith(ALL_OF)) categories.push(p.step.slice(4));
        else subCategories.push(choice);
      } else if (!polls.some((q) => q.step === `sub:${choice}`)) {
        categories.push(choice); // a category with no groups of its own
      }
    }
  }
  // "All of X" covers any group of X also ticked.
  const all = await listAllocationCategories();
  const covered = new Set(all.filter((c) => categories.includes(c.category)).flatMap((c) => c.groups));
  const subs = subCategories.filter((s) => !covered.has(s));

  if (request.test) {
    const would = general ? GENERAL : [...subs, ...categories.map((c) => `all of ${c}`)].join(", ");
    await close(request.id);
    await sendText(`Test OK - would allocate ${request.label} to ${would}. Nothing was saved.`, polls[0].messageId);
    return null;
  }

  const [result] = await applyAgentActions([
    general
      ? { type: "allocate_campaign", campaignId: request.item_key, subCategories: [], categories: [], general: true }
      : { type: "allocate_campaign", campaignId: request.item_key, subCategories: subs, categories, general: false },
  ]);
  const target = general ? "General (all products)" : [...subs, ...categories.map((c) => `all of ${c}`)].join(", ");
  if (result.ok || /already/i.test(result.detail)) {
    if (result.ok) dropReportCache();
    await close(request.id);
    await sendText(result.ok ? `Allocated to ${target}.` : result.detail, polls[0].messageId);
    return { day: request.day, recomputeMargins: false };
  }
  // Not saved: reopen it from the top.
  await sendText(`Couldn't allocate it: ${result.detail}`, polls[0].messageId);
  await supabase.from("agent_requests").delete().eq("id", request.id);
  return { day: request.day, recomputeMargins: false };
}

import { NextRequest, NextResponse, after } from "next/server";
import { handleText, handlePollAnswer, followUp, type FollowUp } from "@/lib/agent/requests";
import { TELEGRAM_API, telegramConfig, telegramError, webhookSecret } from "@/lib/telegram";

// Long enough for the report PDF that may follow the last answer.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Telegram pushes each of the owner's answers here the moment it is sent - a
// reply with a number, or a tap on an allocation poll - so it is recorded at
// once rather than on the next scheduled run (src/lib/agent/requests.ts).
//   POST   - Telegram's webhook call
//   PUT    - point the bot's webhook at this route (CRON_SECRET)
//   DELETE - remove the webhook (CRON_SECRET)
//
// While the webhook is set Telegram hands nothing to getUpdates, so
// GET /api/agent/telegram reads no replies.

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat?: { id: number };
    reply_to_message?: { message_id: number };
  };
  poll_answer?: { poll_id: string; user?: { id: number }; option_ids: number[] };
};

function cronAuthorized(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  return !!cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function POST(request: NextRequest) {
  const secret = webhookSecret();
  if (!secret || request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const cfg = telegramConfig();
  if (!cfg) return NextResponse.json({ ok: true });
  const update: TelegramUpdate = await request.json();

  // The answer itself is recorded before Telegram is answered. The webhook is
  // set to one connection at a time, so answers are handled strictly in order
  // and two taps can never edit the same request at once. Whatever follows
  // (margins, the report) runs after, since it can take a minute.
  let next: FollowUp = null;
  try {
    const msg = update.message;
    const vote = update.poll_answer;
    // Only the owner's chat - in a private chat that is also the owner's user id.
    if (msg && String(msg.chat?.id) === cfg.chatId && msg.text?.trim()) {
      next = await handleText(msg.text, msg.message_id, msg.reply_to_message?.message_id ?? null);
    } else if (vote && String(vote.user?.id) === cfg.chatId) {
      next = await handlePollAnswer(vote.poll_id, vote.option_ids);
    }
  } catch (err) {
    // Acknowledged anyway: a retry would hit the same error.
    console.error("AI MIRAJ answer failed:", err);
  }
  if (next) {
    const origin = request.nextUrl.origin;
    after(() => followUp(next, origin).catch((err) => console.error("AI MIRAJ follow-up failed:", err)));
  }
  return NextResponse.json({ ok: true });
}

export async function PUT(request: NextRequest) {
  if (!cronAuthorized(request)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const cfg = telegramConfig();
  const secret = webhookSecret();
  if (!cfg || !secret) return NextResponse.json({ ok: false, error: "Telegram not configured" }, { status: 503 });

  const url = `${request.nextUrl.origin}/api/agent/webhook`;
  const res = await fetch(`${TELEGRAM_API}/bot${cfg.token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, secret_token: secret, allowed_updates: ["message", "poll_answer"], max_connections: 1 }),
  });
  if (!res.ok) return NextResponse.json({ ok: false, error: await telegramError(res, "setWebhook") }, { status: 502 });
  return NextResponse.json({ ok: true, url });
}

export async function DELETE(request: NextRequest) {
  if (!cronAuthorized(request)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const cfg = telegramConfig();
  if (!cfg) return NextResponse.json({ ok: false, error: "Telegram not configured" }, { status: 503 });
  const res = await fetch(`${TELEGRAM_API}/bot${cfg.token}/deleteWebhook`, { method: "POST" });
  if (!res.ok) return NextResponse.json({ ok: false, error: await telegramError(res, "deleteWebhook") }, { status: 502 });
  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from "next/server";
import { TELEGRAM_API as API, telegramConfig as config, telegramError, chunks, toEach, isOwnerChat } from "@/lib/telegram";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// AI MIRAJ's only channel with the owner, both ways. It is relayed from here
// because the cloud sandbox it runs in only allows requests to
// hosts it can reach over HTTPS, and keeping the bot token here means the agent
// never holds it.
//   POST - send a message, optionally with the report PDF attached
//   GET  - read the owner's replies since the last read
//
// Reads are confirmed back to Telegram as they are handed over, so each reply
// is returned once. TELEGRAM_CHAT_ID pins the conversations (a comma-separated
// list, see src/lib/telegram.ts): messages from any other chat are ignored, so
// a stranger who finds the bot cannot instruct it.

type TelegramUpdate = {
  update_id: number;
  message?: { message_id: number; date: number; text?: string; chat?: { id: number } };
};

function authorized(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  return !!cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const cfg = config();
  if (!cfg) return NextResponse.json({ ok: false, error: "Telegram not configured" }, { status: 503 });

  const { text, pdfBase64, filename } = await request.json();
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ ok: false, error: "text is required" }, { status: 400 });
  }

  // Telegram is the owner's only channel, so a long report is split rather than
  // cut: a message holds 4,096 characters and a PDF caption only 1,024, so a
  // caption that would not fit goes out as its own message ahead of the PDF.
  const hasPdf = typeof pdfBase64 === "string" && !!pdfBase64;
  const captioned = hasPdf && text.length <= 1024;

  try {
    // Every chat on TELEGRAM_CHAT_ID gets it; one that fails doesn't stop the rest.
    const sent = await toEach(cfg.chatIds, async (chat) => {
      if (!captioned) {
        for (const chunk of chunks(text, 4096)) {
          const res = await fetch(`${API}/bot${cfg.token}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chat, text: chunk }),
          });
          if (!res.ok) throw new Error(await telegramError(res, "sendMessage"));
        }
      }
      if (hasPdf) {
        const form = new FormData();
        form.append("chat_id", chat);
        if (captioned) form.append("caption", text);
        form.append(
          "document",
          new Blob([new Uint8Array(Buffer.from(pdfBase64, "base64"))], { type: "application/pdf" }),
          typeof filename === "string" && filename ? filename : "izar-report.pdf"
        );
        const res = await fetch(`${API}/bot${cfg.token}/sendDocument`, { method: "POST", body: form });
        if (!res.ok) throw new Error(await telegramError(res, "sendDocument"));
      }
    });
    const missed = cfg.chatIds.filter((chat) => !sent.some((s) => s.chat === chat));
    return NextResponse.json({ ok: true, ...(missed.length ? { missed } : {}) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "send failed" }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const cfg = config();
  if (!cfg) return NextResponse.json({ ok: false, error: "Telegram not configured" }, { status: 503 });

  try {
    const res = await fetch(`${API}/bot${cfg.token}/getUpdates?timeout=0&allowed_updates=["message"]`);
    const data = await res.json();
    // 409: the webhook is set, so Telegram hands every answer to
    // /api/agent/webhook, which has already recorded it. Nothing is waiting here.
    if (res.status === 409) return NextResponse.json({ ok: true, replies: [], liveChat: true });
    if (!res.ok || !data.ok) throw new Error(data.description ?? `getUpdates failed (HTTP ${res.status})`);

    const updates: TelegramUpdate[] = data.result ?? [];
    const replies = updates
      .filter((u) => u.message?.text && isOwnerChat(u.message.chat?.id))
      .map((u) => ({ at: new Date(u.message!.date * 1000).toISOString(), text: u.message!.text as string }));

    // Confirm everything handed over, so the next read starts after it.
    const lastId = updates.length > 0 ? updates[updates.length - 1].update_id : null;
    if (lastId !== null) {
      await fetch(`${API}/bot${cfg.token}/getUpdates?offset=${lastId + 1}&timeout=0`);
    }

    return NextResponse.json({ ok: true, replies });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "read failed" }, { status: 502 });
  }
}

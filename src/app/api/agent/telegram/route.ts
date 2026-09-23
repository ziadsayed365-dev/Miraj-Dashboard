import { NextRequest, NextResponse } from "next/server";

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
// is returned once. TELEGRAM_CHAT_ID pins the conversation: messages from any
// other chat are ignored, so a stranger who finds the bot cannot instruct it.

const API = "https://api.telegram.org";

type TelegramUpdate = {
  update_id: number;
  message?: { message_id: number; date: number; text?: string; chat?: { id: number } };
};

function config() {
  // Trimmed: a value pasted into Vercel can carry a stray space or line break,
  // which Telegram rejects.
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  return token && chatId ? { token, chatId } : null;
}

// Telegram says why it refused (e.g. "chat not found" when the owner never
// pressed Start on the bot) - pass that on rather than a bare status code.
async function telegramError(res: Response, call: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return `${call} failed (HTTP ${res.status})${body?.description ? `: ${body.description}` : ""}`;
}

// Splits on line breaks where it can, so a list item is never broken in two.
function chunks(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf("\n", max);
    const at = cut > 0 ? cut : max;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  if (rest.trim()) out.push(rest);
  return out;
}

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
    if (!captioned) {
      for (const chunk of chunks(text, 4096)) {
        const res = await fetch(`${API}/bot${cfg.token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: cfg.chatId, text: chunk }),
        });
        if (!res.ok) throw new Error(await telegramError(res, "sendMessage"));
      }
    }
    if (hasPdf) {
      const form = new FormData();
      form.append("chat_id", cfg.chatId);
      if (captioned) form.append("caption", text);
      form.append(
        "document",
        new Blob([new Uint8Array(Buffer.from(pdfBase64, "base64"))], { type: "application/pdf" }),
        typeof filename === "string" && filename ? filename : "izar-report.pdf"
      );
      const res = await fetch(`${API}/bot${cfg.token}/sendDocument`, { method: "POST", body: form });
      if (!res.ok) throw new Error(await telegramError(res, "sendDocument"));
    }
    return NextResponse.json({ ok: true });
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
    if (!res.ok || !data.ok) throw new Error(data.description ?? `getUpdates failed (HTTP ${res.status})`);

    const updates: TelegramUpdate[] = data.result ?? [];
    const replies = updates
      .filter((u) => u.message?.text && String(u.message.chat?.id) === cfg.chatId)
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

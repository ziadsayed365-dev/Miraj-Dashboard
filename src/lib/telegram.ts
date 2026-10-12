import "server-only";
import { createHash } from "node:crypto";

// The one bot conversation AI MIRAJ has with the owner. TELEGRAM_CHAT_ID pins
// it: anything from another chat is ignored, so a stranger who finds the bot
// cannot instruct it.

export const TELEGRAM_API = "https://api.telegram.org";

export function telegramConfig() {
  // Trimmed: a value pasted into Vercel can carry a stray space or line break,
  // which Telegram rejects.
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  return token && chatId ? { token, chatId } : null;
}

// What Telegram echoes back in X-Telegram-Bot-Api-Secret-Token on every webhook
// call, derived from CRON_SECRET so there is no extra env var to keep in step.
export function webhookSecret(): string | null {
  const cronSecret = process.env.CRON_SECRET;
  return cronSecret ? createHash("sha256").update(`telegram-webhook:${cronSecret}`).digest("hex") : null;
}

// Telegram says why it refused (e.g. "chat not found" when the owner never
// pressed Start on the bot) - pass that on rather than a bare status code.
export async function telegramError(res: Response, call: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return `${call} failed (HTTP ${res.status})${body?.description ? `: ${body.description}` : ""}`;
}

// Splits on line breaks where it can, so a list item is never broken in two.
export function chunks(text: string, max: number): string[] {
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

async function call<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const cfg = telegramConfig();
  if (!cfg) throw new Error("Telegram not configured");
  const res = await fetch(`${TELEGRAM_API}/bot${cfg.token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.chatId, ...body }),
  });
  if (!res.ok) throw new Error(await telegramError(res, method));
  return (await res.json()).result as T;
}

type SentMessage = { message_id: number; poll?: { id: string } };

// Returns the id of the (last) message sent, so a reply to it can be matched.
export async function sendText(text: string, replyTo?: number): Promise<number> {
  let id = 0;
  for (const chunk of chunks(text, 4096)) {
    const sent = await call<SentMessage>("sendMessage", {
      text: chunk,
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });
    id = sent.message_id;
  }
  return id;
}

// A non-anonymous poll, so each vote reaches the webhook as a poll_answer.
// Telegram allows 1-12 options of up to 100 characters, and a 300-character
// question.
export async function sendPoll(question: string, options: string[]): Promise<{ pollId: string; messageId: number }> {
  const sent = await call<SentMessage>("sendPoll", {
    question: question.length > 300 ? `${question.slice(0, 297)}...` : question,
    options: options.map((text) => ({ text: text.slice(0, 100) })),
    is_anonymous: false,
    allows_multiple_answers: true,
  });
  return { pollId: sent.poll!.id, messageId: sent.message_id };
}

// Closes a poll once its answer is recorded, so a later tap can't look like a
// change that never happened.
export async function stopPoll(messageId: number): Promise<void> {
  await call("stopPoll", { message_id: messageId }).catch(() => {});
}

export async function sendDocument(caption: string, pdf: Buffer, filename: string): Promise<void> {
  const cfg = telegramConfig();
  if (!cfg) throw new Error("Telegram not configured");
  // A PDF caption holds only 1,024 characters; a longer one goes ahead of it.
  const captioned = caption.length <= 1024;
  if (!captioned) await sendText(caption);
  const form = new FormData();
  form.append("chat_id", cfg.chatId);
  if (captioned) form.append("caption", caption);
  form.append("document", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), filename);
  const res = await fetch(`${TELEGRAM_API}/bot${cfg.token}/sendDocument`, { method: "POST", body: form });
  if (!res.ok) throw new Error(await telegramError(res, "sendDocument"));
}

import "server-only";
import { createHash } from "node:crypto";

// AI MIRAJ's bot conversations with the owner. TELEGRAM_CHAT_ID pins them: a
// comma-separated list of chats, the owner's first. Every chat on it gets every
// question and report, and any of them can answer; anything from another chat
// is ignored, so a stranger who finds the bot cannot instruct it.

export const TELEGRAM_API = "https://api.telegram.org";

export function telegramConfig() {
  // Trimmed: a value pasted into Vercel can carry a stray space or line break,
  // which Telegram rejects.
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatIds = (process.env.TELEGRAM_CHAT_ID ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return token && chatIds.length ? { token, chatIds } : null;
}

// In a private chat the chat id is also the user's id, so this covers votes too.
export function isOwnerChat(id: number | string | undefined | null): boolean {
  return id != null && !!telegramConfig()?.chatIds.includes(String(id));
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

// Runs a send for each chat in turn. One chat failing (say, someone who never
// pressed Start) doesn't stop the others; it only throws when none got it.
export async function toEach<T>(chats: string[], send: (chat: string) => Promise<T>): Promise<{ chat: string; result: T }[]> {
  const done: { chat: string; result: T }[] = [];
  let firstError: unknown = null;
  for (const chat of chats) {
    try {
      done.push({ chat, result: await send(chat) });
    } catch (err) {
      console.error(`Telegram send to ${chat} failed:`, err);
      firstError ??= err;
    }
  }
  if (!done.length && firstError) throw firstError;
  return done;
}

async function call<T>(method: string, chat: string, body: Record<string, unknown>): Promise<T> {
  const cfg = telegramConfig();
  if (!cfg) throw new Error("Telegram not configured");
  const res = await fetch(`${TELEGRAM_API}/bot${cfg.token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, ...body }),
  });
  if (!res.ok) throw new Error(await telegramError(res, method));
  return (await res.json()).result as T;
}

function chats(): string[] {
  const cfg = telegramConfig();
  if (!cfg) throw new Error("Telegram not configured");
  return cfg.chatIds;
}

type SentMessage = { message_id: number; poll?: { id: string } };

// A message as it landed in one chat - message ids are only unique per chat.
export type Sent = { chat: string; id: number };

// Where an answer goes: one chat, optionally as a reply to one of its messages.
export type To = { chat: string; replyTo?: number };

// Sends to every chat, or to just one when answering someone. Returns the
// (last) message sent in each chat, so a reply to it can be matched.
export async function sendText(text: string, to?: To): Promise<Sent[]> {
  const sent = await toEach(to ? [to.chat] : chats(), async (chat) => {
    let id = 0;
    for (const chunk of chunks(text, 4096)) {
      const msg = await call<SentMessage>("sendMessage", chat, {
        text: chunk,
        ...(to?.replyTo ? { reply_parameters: { message_id: to.replyTo, allow_sending_without_reply: true } } : {}),
      });
      id = msg.message_id;
    }
    return id;
  });
  return sent.map(({ chat, result }) => ({ chat, id: result }));
}

// A non-anonymous poll, so each vote reaches the webhook as a poll_answer.
// Sent once and forwarded to the other chats: a forward is the same poll, so a
// vote from any chat lands on it and closing it closes every copy.
// Telegram allows 1-12 options of up to 100 characters, and a 300-character
// question.
export async function sendPoll(question: string, options: string[]): Promise<{ pollId: string; messageId: number; chat: string }> {
  const all = chats();
  let original: { chat: string; sent: SentMessage } | null = null;
  let firstError: unknown = null;
  for (const chat of all) {
    try {
      const sent = await call<SentMessage>("sendPoll", chat, {
        question: question.length > 300 ? `${question.slice(0, 297)}...` : question,
        options: options.map((text) => ({ text: text.slice(0, 100) })),
        is_anonymous: false,
        allows_multiple_answers: true,
      });
      original = { chat, sent };
      break;
    } catch (err) {
      console.error(`Telegram poll to ${chat} failed:`, err);
      firstError ??= err;
    }
  }
  if (!original) throw firstError ?? new Error("Telegram not configured");
  const { chat, sent } = original;
  const others = all.filter((c) => c !== chat);
  if (others.length) {
    await toEach(others, (to) => call("forwardMessage", to, { from_chat_id: chat, message_id: sent.message_id })).catch(() => {});
  }
  return { pollId: sent.poll!.id, messageId: sent.message_id, chat };
}

// Closes a poll once its answer is recorded, so a later tap can't look like a
// change that never happened. chat: where it was first sent (the owner's chat
// for polls from before there was more than one).
export async function stopPoll(messageId: number, chat?: string): Promise<void> {
  await call("stopPoll", chat ?? chats()[0], { message_id: messageId }).catch(() => {});
}

// The report, to every chat.
export async function sendDocument(caption: string, pdf: Buffer, filename: string): Promise<void> {
  const cfg = telegramConfig();
  if (!cfg) throw new Error("Telegram not configured");
  await toEach(cfg.chatIds, async (to) => {
    // A PDF caption holds only 1,024 characters; a longer one goes ahead of it.
    const captioned = caption.length <= 1024;
    if (!captioned) await sendText(caption, { chat: to });
    const form = new FormData();
    form.append("chat_id", to);
    if (captioned) form.append("caption", caption);
    form.append("document", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), filename);
    const res = await fetch(`${TELEGRAM_API}/bot${cfg.token}/sendDocument`, { method: "POST", body: form });
    if (!res.ok) throw new Error(await telegramError(res, "sendDocument"));
  });
}

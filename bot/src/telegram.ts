export type Button = { text: string; callback_data?: string; url?: string };
export type Keyboard = Button[][];

export class Telegram {
  constructor(private token: string) {}

  async call<T = any>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
    return data.result;
  }

  send(chatId: number, text: string, keyboard?: Keyboard, extra: Record<string, unknown> = {}) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text: clip(text, 4000),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      ...extra,
    });
  }

  edit(chatId: number, messageId: number, text: string, keyboard?: Keyboard) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: clip(text, 4000),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: keyboard ?? [] },
    }).catch(() => undefined);
  }

  answer(callbackId: string, text?: string) {
    return this.call("answerCallbackQuery", { callback_query_id: callbackId, text }).catch(() => undefined);
  }

  /** Message on behalf of the owner's account in a Telegram Business chat. */
  sendAsOwner(connectionId: string, chatId: number, text: string) {
    return this.call("sendMessage", {
      business_connection_id: connectionId,
      chat_id: chatId,
      text: clip(text, 4000),
    });
  }

  sendDocumentAsOwner(connectionId: string, chatId: number, url: string, caption?: string) {
    return this.call("sendDocument", {
      business_connection_id: connectionId,
      chat_id: chatId,
      document: url,
      caption,
    });
  }

  sendDocument(chatId: number, url: string, caption?: string) {
    return this.call("sendDocument", { chat_id: chatId, document: url, caption });
  }

  typing(chatId: number) {
    return this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => undefined);
  }
}

export function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Telegram webhook secret derived from the bot token, so no extra secret has to be configured. */
export async function webhookSecret(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("webhook:" + token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

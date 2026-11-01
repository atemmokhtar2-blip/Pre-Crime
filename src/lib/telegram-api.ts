import type {
  BotApi,
  ChatMemberInfo,
  InlineKeyboardMarkup,
  ForceReplyMarkup,
} from "./types";

// Thin typed wrapper around the Telegram Bot API. Deliberately dependency-free
// (uses global fetch) so it works identically on Vercel and in tests.
export function createTelegramApi(token: string, fetchImpl: typeof fetch = fetch): BotApi {
  async function call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    const json = (await response.json()) as { ok?: boolean; result?: T; description?: string };
    if (!response.ok || json.ok !== true || json.result === undefined) {
      throw new Error(`telegram_${method}_failed${json.description ? `: ${json.description}` : ""}`);
    }
    return json.result;
  }

  return {
    async getMe() {
      return call<{ id: number; username?: string; first_name?: string }>("getMe");
    },
    async sendMessage(chatId, text, opts) {
      const body: Record<string, unknown> = { chat_id: chatId, text, disable_web_page_preview: true };
      if (opts?.reply_markup) body.reply_markup = opts.reply_markup;
      if (opts?.reply_to_message_id) body.reply_to_message_id = opts.reply_to_message_id;
      return call<{ message_id: number }>("sendMessage", body);
    },
    async editMessageText(chatId, messageId, text, opts) {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: true,
      };
      if (opts?.reply_markup) body.reply_markup = opts.reply_markup;
      return call<unknown>("editMessageText", body);
    },
    async answerCallbackQuery(callbackQueryId, opts) {
      return call<unknown>("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: opts?.text,
        show_alert: opts?.show_alert ?? false,
      });
    },
    async deleteMessage(chatId, messageId) {
      return call<unknown>("deleteMessage", { chat_id: chatId, message_id: messageId });
    },
    async getChat(chatId) {
      return call<{ id: number; title?: string; username?: string; type: string }>("getChat", { chat_id: chatId });
    },
    async getChatMember(chatId, userId) {
      return call<ChatMemberInfo>("getChatMember", { chat_id: chatId, user_id: userId });
    },
    async getChatMemberCount(chatId) {
      return call<number>("getChatMemberCount", { chat_id: chatId });
    },
    async getChatAdministrators(chatId) {
      return call<Array<{ user: { id: number }; status: string }>>("getChatAdministrators", { chat_id: chatId });
    },
    async restrictChatMember(chatId, userId, canSendMessages, opts) {
      const permissions = canSendMessages
        ? {
            can_send_messages: true,
            can_send_media_messages: true,
            can_send_polls: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true,
            can_change_info: false,
            can_invite_users: false,
            can_pin_messages: false,
          }
        : {
            can_send_messages: false,
            can_send_media_messages: false,
            can_send_polls: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
            can_change_info: false,
            can_invite_users: false,
            can_pin_messages: false,
          };
      const body: Record<string, unknown> = { chat_id: chatId, user_id: userId, permissions };
      if (opts?.until_date) body.until_date = opts.until_date;
      return call<unknown>("restrictChatMember", body);
    },
    async banChatMember(chatId, userId) {
      return call<unknown>("banChatMember", { chat_id: chatId, user_id: userId });
    },
    async unbanChatMember(chatId, userId) {
      return call<unknown>("unbanChatMember", { chat_id: chatId, user_id: userId });
    },
  };
}

export type { InlineKeyboardMarkup, ForceReplyMarkup };

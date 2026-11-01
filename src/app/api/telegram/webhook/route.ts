import { timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TelegramUpdate = {
  update_id?: number;
  message?: {
    text?: string;
    chat?: { id?: number; type?: string; title?: string };
    from?: { first_name?: string };
  };
  my_chat_member?: {
    chat?: { id?: number; type?: string; title?: string };
    old_chat_member?: { status?: string };
    new_chat_member?: { status?: string; user?: { is_bot?: boolean } };
  };
  [key: string]: unknown;
};

function safeSecretMatch(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function telegram<T>(token: string, method: string, body?: object): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json() as { ok?: boolean; result?: T; description?: string };
  if (!response.ok || result.ok !== true || result.result === undefined) {
    throw new Error(`telegram_${method}_failed`);
  }
  return result.result;
}

export async function POST(request: Request) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expectedSecret || !safeSecretMatch(
    request.headers.get("x-telegram-bot-api-secret-token"),
    expectedSecret,
  )) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json() as TelegramUpdate;
  } catch {
    return Response.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  if (!Number.isSafeInteger(update.update_id) || (update.update_id as number) < 0) {
    return Response.json({ ok: false, error: "invalid_update_id" }, { status: 400 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const databaseUrl = process.env.DATABASE_URL;
  if (!token || !databaseUrl) {
    return Response.json({ ok: false, error: "server_configuration_missing" }, { status: 503 });
  }

  try {
    const sql = neon(databaseUrl);
    await sql`
      CREATE TABLE IF NOT EXISTS telegram_updates (
        update_id BIGINT PRIMARY KEY,
        update_type TEXT NOT NULL,
        chat_id BIGINT,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'received'
          CHECK (status IN ('received','processing','processed','failed')),
        error_code TEXT
      )
    `;
    const updateType = Object.keys(update).find((key) => key !== "update_id") ?? "unknown";
    const chatId = update.message?.chat?.id ?? update.my_chat_member?.chat?.id ?? null;

    // A failed delivery can be retried; successful updates remain idempotent.
    const claimed = await sql`
      INSERT INTO telegram_updates (update_id, update_type, chat_id, status)
      VALUES (${update.update_id as number}, ${updateType}, ${chatId}, 'processing')
      ON CONFLICT (update_id) DO UPDATE
        SET status = 'processing', error_code = NULL
        WHERE telegram_updates.status = 'failed'
      RETURNING update_id
    `;

    if (claimed.length === 0) {
      return Response.json({ ok: true, duplicate: true });
    }

    try {
      const text = update.message?.text?.trim() ?? "";
      if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text) && update.message?.chat?.id) {
        const me = await telegram<{ username?: string }>(token, "getMe");
        if (!me.username) throw new Error("bot_username_unavailable");

        const firstName = update.message.from?.first_name?.trim();
        const greeting = firstName ? `أهلاً ${firstName} 👋\n\n` : "أهلاً بيك 👋\n\n";
        const message =
          greeting +
          "أنا PRE-CRIME، مساعدك لإدارة وحماية مجموعات تيليجرام.\n\n" +
          "اضغط الزر بالأسفل لإضافتي إلى مجموعتك، وبعد الإضافة امنحني صلاحيات الإدارة المطلوبة حتى أقدر أحمي المجموعة وأديرها.";
        await telegram(token, "sendMessage", {
          chat_id: update.message.chat.id,
          text: message,
          reply_markup: {
            inline_keyboard: [[{
              text: "➕ إضافة البوت إلى مجموعة",
              url: `https://t.me/${me.username}?startgroup=true`,
            }]],
          },
          disable_web_page_preview: true,
        });
      }

      const membership = update.my_chat_member;
      const newStatus = membership?.new_chat_member?.status;
      const oldStatus = membership?.old_chat_member?.status;
      const addedToGroup =
        membership?.chat?.id &&
        (membership.chat.type === "group" || membership.chat.type === "supergroup") &&
        (newStatus === "member" || newStatus === "administrator") &&
        (oldStatus === "left" || oldStatus === "kicked");

      if (addedToGroup && membership?.chat?.id) {
        const groupName = membership.chat.title?.trim();
        const groupGreeting = groupName
          ? `أهلاً بأعضاء مجموعة ${groupName} 👋\\n\\n`
          : "أهلاً يا جماعة 👋\\n\\n";
        console.info("telegram_bot_added_to_group", {
          chatId: membership.chat.id,
          chatType: membership.chat.type,
          oldStatus,
          newStatus,
        });
        await telegram(token, "sendMessage", {
          chat_id: membership.chat.id,
          text:
            groupGreeting +
            "أنا PRE-CRIME، مساعدكم لإدارة وحماية المجموعة 🤖\\n" +
            "تمت إضافتي بنجاح. ارفعوني مشرفًا وفعّلوا صلاحيات حذف الرسائل وحظر الأعضاء وإدارة المجموعة، وبعدها هأكد لكم إنّي جاهز للعمل.",
          disable_web_page_preview: true,
        });
      }

      await sql`
        UPDATE telegram_updates
        SET status = 'processed', processed_at = NOW(), error_code = NULL
        WHERE update_id = ${update.update_id as number}
      `;
      return Response.json({ ok: true, processed: true });
    } catch (error) {
      console.error("telegram_update_handler_failed", {
        updateId: update.update_id,
        updateType,
        error: error instanceof Error ? error.message : String(error),
      });
      await sql`
        UPDATE telegram_updates
        SET status = 'failed', error_code = 'handler_failed'
        WHERE update_id = ${update.update_id as number}
      `;
      return Response.json({ ok: false, error: "update_processing_failed" }, { status: 503 });
    }
  } catch {
    return Response.json({ ok: false, error: "temporary_persistence_failure" }, { status: 503 });
  }
}

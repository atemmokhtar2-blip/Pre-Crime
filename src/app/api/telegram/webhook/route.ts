import { timingSafeEqual } from "node:crypto";
import { neon } from "@neondatabase/serverless";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TelegramUpdate = {
  update_id?: number;
  [key: string]: unknown;
};

function safeSecretMatch(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer);
}

function getUpdateType(update: TelegramUpdate): string {
  return Object.keys(update).find((key) => key !== "update_id") ?? "unknown";
}

function getChatId(update: TelegramUpdate): number | null {
  const candidates = [
    update.message,
    update.edited_message,
    update.channel_post,
    update.edited_channel_post,
    update.my_chat_member,
    update.chat_member,
    update.chat_join_request,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      const chat = (candidate as { chat?: { id?: unknown } }).chat;
      if (chat && typeof chat.id === "number") return chat.id;
    }
  }
  return null;
}

export async function POST(request: Request) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expectedSecret) {
    return Response.json({ ok: false, error: "webhook_not_configured" }, { status: 503 });
  }

  const suppliedSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!safeSecretMatch(suppliedSecret, expectedSecret)) {
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

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return Response.json({ ok: false, error: "database_not_configured" }, { status: 503 });
  }

  try {
    const sql = neon(databaseUrl);
    const updateType = getUpdateType(update);
    const chatId = getChatId(update);
    const inserted = await sql`
      INSERT INTO telegram_updates (update_id, update_type, chat_id, status)
      VALUES (${update.update_id as number}, ${updateType}, ${chatId}, 'received')
      ON CONFLICT (update_id) DO NOTHING
      RETURNING update_id
    `;

    // Duplicate deliveries are acknowledged safely. Domain dispatch is added in Phase 1.
    return Response.json({
      ok: true,
      accepted: inserted.length === 1,
      duplicate: inserted.length === 0,
    });
  } catch {
    // Do not acknowledge an update that was not durably stored; Telegram can retry it.
    return Response.json({ ok: false, error: "temporary_persistence_failure" }, { status: 503 });
  }
}

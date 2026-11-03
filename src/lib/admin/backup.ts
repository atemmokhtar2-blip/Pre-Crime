// System recovery: full JSON backup export + restore from a backup file.
// Used by the Emergency → System recovery screen. Both operations run against
// the real database through the admin store.

import type { BotApi } from "../types";

export interface BackupStore {
  exportBackup(): Promise<Record<string, unknown>>;
  importBackup(data: Record<string, unknown>): Promise<string[]>;
}

export function backupFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `pre-crime-backup-${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}.json`;
}

// Exports every admin/system table and sends it to the admin as a JSON document.
export async function runBackup(store: BackupStore, bot: BotApi, chatId: number): Promise<string> {
  const data = await store.exportBackup();
  const tables = (data.tables ?? {}) as Record<string, unknown[]>;
  const totalRows = Object.values(tables).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
  const filename = backupFileName();
  await bot.sendDocument(
    chatId,
    filename,
    JSON.stringify(data, null, 2),
    `📥 نسخة احتياطية كاملة — ${totalRows} سجل عبر ${Object.keys(tables).length} جدولًا.`,
  );
  return filename;
}

export interface RestoreResult {
  ok: boolean;
  restored: string[];
  error?: string;
}

// Downloads a previously exported backup document and restores its tables.
export async function restoreBackup(
  store: BackupStore,
  bot: BotApi,
  document: { file_id: string; file_name?: string; file_size?: number },
): Promise<RestoreResult> {
  if (document.file_size != null && document.file_size > 20 * 1024 * 1024) {
    return { ok: false, restored: [], error: "الملف أكبر من 20 ميجابايت — الحد الأقصى لملفات النسخ الاحتياطية." };
  }
  const file = await bot.getFile(document.file_id);
  if (!file.file_path) return { ok: false, restored: [], error: "تعذر الوصول إلى الملف على خوادم تيليجرام." };
  const content = await bot.downloadFile(file.file_path);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return { ok: false, restored: [], error: "الملف ليس JSON صالحًا." };
  }
  if (parsed.app !== "pre-crime" || typeof parsed.tables !== "object" || parsed.tables == null) {
    return { ok: false, restored: [], error: "هذا الملف ليس نسخة احتياطية صادرة عن هذا النظام." };
  }
  const restored = await store.importBackup(parsed);
  return { ok: true, restored };
}

import type { TelegramMessage } from "../types";

export type FileSignal = {
  hasFile: boolean;
  fileName: string | null;
  mimeType: string | null;
  fileSize: number | null;
  warnings: string[];
};

// Local structural inspection of Telegram document metadata; no file is downloaded.
export function inspectFile(message: TelegramMessage): FileSignal {
  const document = message.document as { file_name?: string; mime_type?: string; file_size?: number } | undefined;
  if (!document) return { hasFile: false, fileName: null, mimeType: null, fileSize: null, warnings: [] };
  const warnings: string[] = [];
  if (!document.file_name) warnings.push("missing_filename");
  if (document.file_size != null && document.file_size <= 0) warnings.push("invalid_file_size");
  return {
    hasFile: true,
    fileName: document.file_name ?? null,
    mimeType: document.mime_type ?? null,
    fileSize: document.file_size ?? null,
    warnings,
  };
}

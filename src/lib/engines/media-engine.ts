import type { TelegramMessage } from "../types";

export type MediaSignal = { hasMedia: boolean; hasFile: boolean; };

// Media and file detection are deliberately separate categories.
export function inspectMedia(message: TelegramMessage): MediaSignal {
  return {
    hasMedia: Boolean(message.photo || message.video || message.animation || message.sticker || message.voice || message.audio || message.video_note || message.paid_media),
    hasFile: Boolean(message.document),
  };
}

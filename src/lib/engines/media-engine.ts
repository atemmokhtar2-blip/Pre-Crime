import type { TelegramMessage } from "../types";

export type MediaSignal = {
  hasPhoto: boolean;
  hasVideo: boolean;
  hasAnimation: boolean;
  hasSticker: boolean;
  hasAudio: boolean;
  hasVideoNote: boolean;
  hasPaidMedia: boolean;
  hasMedia: boolean;
  hasFile: boolean;
  kind: string[];
  hasCaption: boolean;
};

// Keep image moderation deliberately narrow. A photo with a caption or
// accompanying text is treated as intentional content and is never auto-deleted
// by the image-only toggle. Other media types are classified separately.
export function inspectMedia(message: TelegramMessage): MediaSignal {
  const hasPhoto = Boolean(message.photo);
  const hasVideo = Boolean(message.video);
  const hasAnimation = Boolean(message.animation);
  const hasSticker = Boolean(message.sticker);
  const hasAudio = Boolean(message.voice || message.audio);
  const hasVideoNote = Boolean(message.video_note);
  const hasPaidMedia = Boolean(message.paid_media);
  const kind = [hasPhoto && "photo", hasVideo && "video", hasAnimation && "animation", hasSticker && "sticker", hasAudio && "audio", hasVideoNote && "video_note", hasPaidMedia && "paid_media"].filter(Boolean) as string[];
  return {
    kind,
    hasCaption: Boolean((message.caption ?? message.text ?? "").trim()),
    hasPhoto,
    hasVideo,
    hasAnimation,
    hasSticker,
    hasAudio,
    hasVideoNote,
    hasPaidMedia,
    hasMedia: hasPhoto || hasVideo || hasAnimation || hasSticker || hasAudio || hasVideoNote || hasPaidMedia,
    hasFile: Boolean(message.document),
  };
}

export function shouldDeleteImage(message: TelegramMessage): boolean {
  const signal = inspectMedia(message);
  // Mixed attachments and captioned photos are never removed by the image-only rule.
  return signal.kind.length === 1 && signal.kind[0] === "photo" && !signal.hasCaption;
}

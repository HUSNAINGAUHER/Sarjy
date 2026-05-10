"use client";

import type { VoiceAttachedImageView } from "@/hooks/useVoiceAssistant";
import { useCallback, useRef } from "react";

interface VoiceImageAttachmentsProps {
  attachedImages: VoiceAttachedImageView[];
  isAttachingImage: boolean;
  imageAttachError: string | null;
  isSessionActive: boolean;
  onAttach: (file: File) => Promise<void>;
  onRemove: (id: string) => void;
  onClearAll: () => void;
}

const SUPPORTED_ACCEPT = "image/jpeg,image/png,image/webp,image/gif";

/**
 * Compact image attachment shelf shown beneath the orb during a voice
 * session. The user can drop or pick images that the assistant will see on
 * the next turn. Thumbnails are rendered from local data URLs (no roundtrip).
 */
export function VoiceImageAttachments({
  attachedImages,
  isAttachingImage,
  imageAttachError,
  isSessionActive,
  onAttach,
  onRemove,
  onClearAll,
}: VoiceImageAttachmentsProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handlePickClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      for (const file of list) {
        await onAttach(file);
      }
    },
    [onAttach],
  );

  const handleInputChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) return;
      await handleFiles(files);
      event.target.value = "";
    },
    [handleFiles],
  );

  const hasImages = attachedImages.length > 0;

  if (!isSessionActive && !hasImages && !imageAttachError) {
    // Hide the whole shelf until the user starts a session — keeps the orb
    // hero clean. The drop-zone at the page level is also gated.
    return null;
  }

  return (
    <div className="w-full max-w-lg flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-medium uppercase tracking-widest text-slate-600">
          Images for Sarjy
        </p>
        <div className="flex items-center gap-2">
          {hasImages && (
            <button
              type="button"
              onClick={onClearAll}
              className="rounded-md border border-white/10 px-2 py-1 text-[10px] uppercase tracking-wider text-slate-400 hover:bg-white/5 hover:text-slate-200"
            >
              Clear all
            </button>
          )}
          <button
            type="button"
            onClick={handlePickClick}
            disabled={!isSessionActive || isAttachingImage}
            className="rounded-md border border-white/10 px-2 py-1 text-[10px] uppercase tracking-wider text-teal-200 hover:bg-teal-300/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isAttachingImage ? "Uploading…" : "+ Add"}
          </button>
        </div>
      </div>

      {hasImages && (
        <div className="flex flex-wrap gap-2">
          {attachedImages.map((img) => (
            <ImageThumbnail key={img.id} image={img} onRemove={onRemove} />
          ))}
        </div>
      )}

      {!hasImages && isSessionActive && (
        <p className="text-[11px] text-slate-600">
          Drop a picture anywhere on the page or tap <span className="text-teal-300">+ Add</span>.
          Sarjy will see it on the next thing you say.
        </p>
      )}

      {imageAttachError && (
        <p
          className="rounded-lg border px-3 py-2 text-[11px]"
          style={{
            background: "rgba(239,68,68,0.08)",
            borderColor: "rgba(239,68,68,0.2)",
            color: "rgb(252,165,165)",
          }}
        >
          {imageAttachError}
        </p>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={SUPPORTED_ACCEPT}
        multiple
        onChange={handleInputChange}
        className="hidden"
      />
    </div>
  );
}

function ImageThumbnail({
  image,
  onRemove,
}: {
  image: VoiceAttachedImageView;
  onRemove: (id: string) => void;
}) {
  const sizeKb = Math.max(1, Math.round(image.byteSize / 1024));
  return (
    <div
      className="group relative h-16 w-16 overflow-hidden rounded-lg border border-white/10 bg-black/30"
      title={`${image.mediaType} · ${sizeKb} KB${image.caption ? ` · ${image.caption}` : ""}`}
    >
      {image.thumbDataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image.thumbDataUrl}
          alt={image.caption ?? "Attached image"}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[10px] uppercase tracking-wider text-slate-500">
          IMG
        </div>
      )}
      <button
        type="button"
        onClick={() => onRemove(image.id)}
        aria-label={`Remove image (${sizeKb} KB)`}
        className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
      >
        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={1.6}>
          <path strokeLinecap="round" d="M3 3l6 6M9 3l-6 6" />
        </svg>
      </button>
      <span className="pointer-events-none absolute bottom-0 left-0 right-0 truncate bg-black/60 px-1 py-0.5 text-[9px] text-slate-300">
        {sizeKb} KB
      </span>
    </div>
  );
}

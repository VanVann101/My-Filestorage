export interface Policy {
  /** https://storage.yandexcloud.net/<bucket> — цель POST-запроса */
  endpoint: string;
  /** Префикс ключа, разрешённый политикой */
  prefix: string;
  eventTitle: string;
  maxBytes: number;
  expiresAt: string;
  /** Поля формы, покрытые подписью. Уходят в FormData как есть. */
  fields: Record<string, string>;
}

/** Служебный файл в бакете (без папки гостя) со списком скрытых guestSlug —
 *  пишет админка, читает галерея. Вынесен сюда одной константой, чтобы
 *  два независимых модуля не могли разъехаться по имени файла. */
export const HIDDEN_GUESTS_FILE = 'hidden-guests.json';

export type ItemStatus = 'pending' | 'uploading' | 'done' | 'error';

export interface UploadItem {
  id: string;
  file: File;
  status: ItemStatus;
  /** 0..1 */
  progress: number;
  error?: string;
  attempts: number;
}

/** Один объект из ответа ListObjectsV2. */
export interface S3Object {
  key: string;
  size: number;
  /** ISO8601, как отдаёт ListObjectsV2. */
  lastModified: string;
}

export type GalleryKind = 'image' | 'video' | 'other';

/** S3Object, разобранный для отображения в галерее. */
export interface GalleryItem {
  key: string;
  url: string;
  size: number;
  lastModified: string;
  fileName: string;
  guestSlug: string;
  kind: GalleryKind;
}

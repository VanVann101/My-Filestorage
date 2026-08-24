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

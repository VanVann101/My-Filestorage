import type { Policy, UploadItem } from './types';

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Кириллица в ключах объектов работает, но превращает пути в мусор
 *  при выкачке на Windows — поэтому имя гостя транслитерируем. */
export function slugify(input: string): string {
  const lower = input.toLowerCase().trim();
  let out = '';
  for (const ch of lower) {
    out += TRANSLIT[ch] ?? ch;
  }
  return out.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'guest';
}

function uuid(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function safeFileName(name: string): string {
  return name.replace(/[^\w.\-]+/g, '_').slice(-80);
}

export function buildKey(policy: Policy, guest: string, file: File): string {
  return `${policy.prefix}${slugify(guest)}/${uuid()}_${safeFileName(file.name)}`;
}

class UploadError extends Error {
  constructor(message: string, readonly retriable: boolean) {
    super(message);
  }
}

function postOnce(
  policy: Policy,
  guest: string,
  item: UploadItem,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('key', buildKey(policy, guest, item.file));
    for (const [name, value] of Object.entries(policy.fields)) {
      form.append(name, value);
    }
    // Без явного Content-Type хранилище отдаст файл как octet-stream,
    // и превью не откроется ни в браузере, ни в консоли.
    form.append('Content-Type', item.file.type || 'application/octet-stream');
    form.append('x-amz-meta-guest', encodeURIComponent(guest));
    // Поле file обязано быть последним: всё после него игнорируется.
    form.append('file', item.file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', policy.endpoint, true);
    xhr.timeout = 3 * 60 * 60 * 1000; // мобильная загрузка 2 ГБ может растянуться на час с лишним

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
      } else if (xhr.status >= 500) {
        reject(new UploadError(`Хранилище ответило ${xhr.status}`, true));
      } else {
        // 400-е — это протухшая политика, превышение размера, кривые поля.
        // Повторять бессмысленно, ответ не изменится.
        const code = xhr.responseText.match(/<Code>([^<]+)<\/Code>/)?.[1];
        reject(new UploadError(describe(xhr.status, code), false));
      }
    };
    xhr.onerror = () => reject(new UploadError('Нет связи с хранилищем', true));
    xhr.ontimeout = () => reject(new UploadError('Загрузка слишком долгая', true));
    xhr.onabort = () => reject(new UploadError('Загрузка прервана', true));

    xhr.send(form);
  });
}

function describe(status: number, code?: string): string {
  switch (code) {
    case 'EntityTooLarge':
      return 'Файл слишком большой';
    case 'AccessDenied':
    case 'ExpiredToken':
      return 'Срок приёма файлов истёк';
    default:
      return `Ошибка ${status}${code ? ` (${code})` : ''}`;
  }
}

const MAX_ATTEMPTS = 3;

export async function uploadItem(
  policy: Policy,
  guest: string,
  item: UploadItem,
  onChange: () => void,
): Promise<void> {
  item.status = 'uploading';
  item.error = undefined;
  item.progress = 0;
  onChange();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    item.attempts++;
    try {
      await postOnce(policy, guest, item, (fraction) => {
        item.progress = fraction;
        onChange();
      });
      item.status = 'done';
      onChange();
      return;
    } catch (err) {
      const uploadErr = err instanceof UploadError ? err : new UploadError('Неизвестная ошибка', true);
      const lastTry = attempt === MAX_ATTEMPTS || !uploadErr.retriable;
      if (lastTry) {
        item.status = 'error';
        item.error = uploadErr.message;
        item.progress = 0;
        onChange();
        return;
      }
      item.progress = 0;
      onChange();
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
}

/** Больше трёх параллельных аплоадов на мобильной сети душат друг друга. */
const CONCURRENCY = 2;

export async function runQueue(
  policy: Policy,
  guest: string,
  items: UploadItem[],
  onChange: () => void,
): Promise<void> {
  const queue = items.filter((i) => i.status === 'pending' || i.status === 'error');
  let cursor = 0;

  const worker = async () => {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      await uploadItem(policy, guest, item, onChange);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
}

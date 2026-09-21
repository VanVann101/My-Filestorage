import type { S3Object } from './types';

class ListError extends Error {}

const MAX_PAGES = 50;

/** Публичный неподписанный ListObjectsV2 — требует, чтобы бакет разрешал
 *  анонимное чтение (bucket policy на s3:ListBucket, см. README). */
export async function listAllObjects(endpoint: string, prefix: string): Promise<S3Object[]> {
  const objects: S3Object[] = [];
  let continuationToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ 'list-type': '2', 'max-keys': '1000', prefix });
    if (continuationToken) params.set('continuation-token', continuationToken);

    const res = await fetch(`${endpoint}?${params}`, { cache: 'no-store' });
    const text = await res.text();
    if (!res.ok) {
      const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
      throw new ListError(describe(res.status, code));
    }

    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) {
      throw new ListError('Хранилище прислало нечитаемый ответ');
    }

    for (const node of doc.getElementsByTagName('Contents')) {
      const key = node.getElementsByTagName('Key')[0]?.textContent ?? '';
      if (!key || key.endsWith('/')) continue;
      objects.push({
        key,
        size: Number(node.getElementsByTagName('Size')[0]?.textContent ?? 0),
        lastModified: node.getElementsByTagName('LastModified')[0]?.textContent ?? '',
      });
    }

    const truncated = doc.getElementsByTagName('IsTruncated')[0]?.textContent === 'true';
    if (!truncated) break;
    continuationToken = doc.getElementsByTagName('NextContinuationToken')[0]?.textContent ?? undefined;
    if (!continuationToken) break;
  }

  return objects;
}

function describe(status: number, code?: string): string {
  switch (code) {
    case 'AccessDenied':
      return 'Доступ к бакету закрыт — обратитесь к организатору';
    case 'NoSuchBucket':
      return 'Бакет не найден';
    default:
      return `Ошибка ${status}${code ? ` (${code})` : ''}`;
  }
}

import './style.css';
import { HIDDEN_GUESTS_FILE, type GalleryItem, type GalleryKind, type Policy, type S3Object } from './types';
import { listAllObjects } from './s3-list';

const app = document.getElementById('app') as HTMLElement;

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'm4v', 'avi', 'mkv']);

type SortMode = 'new' | 'old' | 'guest';

const SORT_LABELS: Record<SortMode, string> = {
  new: 'Сначала новые',
  old: 'Сначала старые',
  guest: 'По имени гостя (А-Я)',
};

const SORT_COMPARATORS: Record<SortMode, (a: GalleryItem, b: GalleryItem) => number> = {
  new: (a, b) => b.lastModified.localeCompare(a.lastModified),
  old: (a, b) => a.lastModified.localeCompare(b.lastModified),
  guest: (a, b) => a.guestSlug.localeCompare(b.guestSlug) || b.lastModified.localeCompare(a.lastModified),
};

let policy: Policy;
let items: GalleryItem[] = [];
let loading = false;
let errorText: string | null = null;
let sortMode: SortMode = 'new';

async function boot() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}policy.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    policy = await res.json();
  } catch {
    return renderMessage('Страница не настроена', 'Не удалось загрузить параметры доступа.');
  }

  await load();
}

async function load() {
  loading = true;
  errorText = null;
  render();

  try {
    const [objects, hidden] = await Promise.all([
      listAllObjects(policy.endpoint, policy.prefix),
      loadHiddenGuests(),
    ]);
    items = objects
      // Файлы без папки гостя (например hidden-guests.json из админки) — не фото/видео.
      .filter((obj) => obj.key.slice(policy.prefix.length).includes('/'))
      .map(toGalleryItem)
      .filter((item) => !hidden.has(item.guestSlug));
  } catch (err) {
    errorText = err instanceof Error ? err.message : 'Неизвестная ошибка';
  } finally {
    loading = false;
    render();
  }
}

/** Список скрытых из админки гостей — необязательный файл, его отсутствие
 *  или ошибка чтения не должны ломать галерею, просто ничего не прячем. */
async function loadHiddenGuests(): Promise<Set<string>> {
  try {
    const res = await fetch(`${policy.endpoint}/${policy.prefix}${HIDDEN_GUESTS_FILE}`, { cache: 'no-store' });
    if (!res.ok) return new Set();
    const data = await res.json();
    return new Set(Array.isArray(data.hidden) ? data.hidden : []);
  } catch {
    return new Set();
  }
}

function toGalleryItem(obj: S3Object): GalleryItem {
  const rest = obj.key.slice(policy.prefix.length);
  const slashIdx = rest.indexOf('/');
  const guestSlug = slashIdx === -1 ? '' : rest.slice(0, slashIdx);
  const tail = slashIdx === -1 ? rest : rest.slice(slashIdx + 1);
  const underscoreIdx = tail.indexOf('_');
  const fileName = underscoreIdx === -1 ? tail : tail.slice(underscoreIdx + 1);

  const url = `${policy.endpoint}/${obj.key.split('/').map(encodeURIComponent).join('/')}`;

  return { key: obj.key, url, size: obj.size, lastModified: obj.lastModified, fileName, guestSlug, kind: kindOf(fileName) };
}

function kindOf(fileName: string): GalleryKind {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'other';
}

// --- отрисовка ---

function renderMessage(title: string, text: string) {
  app.replaceChildren(el('h1', 'title', title), el('p', 'lead', text), renderUploadLink());
}

function render() {
  app.replaceChildren();
  app.append(el('h1', 'title', policy.eventTitle), renderUploadLink());

  if (loading) {
    app.append(el('p', 'loading', 'Загружаем…'));
    return;
  }

  if (errorText) {
    app.append(el('p', 'lead warn', errorText));
    return;
  }

  app.append(el('p', 'hint', `Файлов: ${items.length}`));

  if (!items.length) {
    app.append(el('p', 'lead', 'Пока никто ничего не загрузил.'));
    return;
  }

  app.append(renderSortSelect(), renderGrid());
}

function renderSortSelect(): HTMLElement {
  const select = document.createElement('select');
  select.className = 'input';
  for (const mode of Object.keys(SORT_LABELS) as SortMode[]) {
    const option = document.createElement('option');
    option.value = mode;
    option.textContent = SORT_LABELS[mode];
    select.append(option);
  }
  select.value = sortMode;
  select.addEventListener('change', () => {
    sortMode = select.value as SortMode;
    render();
  });
  return select;
}

function renderUploadLink(): HTMLElement {
  const a = document.createElement('a');
  a.className = 'btn btn-secondary';
  a.href = `${import.meta.env.BASE_URL}`;
  a.textContent = '← Загрузить свои файлы';
  return a;
}

function renderGrid(): HTMLElement {
  const grid = el('div', 'gallery-grid');
  for (const item of items.slice().sort(SORT_COMPARATORS[sortMode])) grid.append(renderTile(item));
  return grid;
}

function renderTile(item: GalleryItem): HTMLElement {
  const tile = el('div', `tile tile-${item.kind}`);

  if (item.kind === 'image') {
    const link = document.createElement('a');
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noopener';

    const img = document.createElement('img');
    img.src = item.url;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = item.fileName;
    img.addEventListener('error', () => {
      img.replaceWith(el('span', 'tile-placeholder', 'нет предпросмотра'));
    });

    link.append(img);
    tile.append(link);
  } else if (item.kind === 'video') {
    // Тап по плитке открывает файл в новой вкладке — так же, как у фото:
    // без обёртки <a> клик по <video> просто переключал бы play/pause на месте.
    const link = document.createElement('a');
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noopener';

    const video = document.createElement('video');
    video.src = item.url;
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    // preload="metadata" даёт длительность/размеры, но не кадр — без play()
    // многие браузеры (особенно Safari) рисуют пустоту. Перемотка на долю
    // секунды после загрузки метаданных заставляет декодировать и
    // отрисовать кадр, не запуская само воспроизведение.
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = Math.min(0.1, video.duration || 0.1);
    });

    const playIcon = el('span', 'tile-play', '▶');
    // Кодек, которого нет у браузера (например HEVC .mov вне Safari/iOS),
    // не даёт ни кадра, ни ошибки на уровне <img> — но событие error есть и тут.
    video.addEventListener('error', () => {
      video.replaceWith(el('span', 'tile-placeholder', 'нет предпросмотра'));
      playIcon.remove();
    });

    link.append(video, playIcon);
    tile.append(link);
  } else {
    const link = document.createElement('a');
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.append(el('span', 'tile-placeholder', item.fileName));
    tile.append(link);
  }

  const caption = el('div', 'tile-caption');
  caption.append(el('span', 'tile-guest', item.guestSlug));

  const download = document.createElement('a');
  download.className = 'link';
  download.href = item.url;
  download.download = item.fileName;
  download.target = '_blank';
  download.rel = 'noopener';
  download.textContent = 'Скачать';
  caption.append(download);

  tile.append(caption);
  return tile;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

boot();

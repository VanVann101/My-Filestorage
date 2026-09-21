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
/** Список в текущем порядке сортировки — лайтбокс листает именно по нему,
 *  чтобы «следующее» совпадало с тем, что гость видит в сетке. */
let visibleItems: GalleryItem[] = [];
let lightboxIndex: number | null = null;

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
  visibleItems = items.slice().sort(SORT_COMPARATORS[sortMode]);
  const grid = el('div', 'gallery-grid');
  visibleItems.forEach((item, index) => grid.append(renderTile(item, index)));
  return grid;
}

function renderTile(item: GalleryItem, index: number): HTMLElement {
  const tile = el('div', `tile tile-${item.kind}`);

  if (item.kind === 'image') {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'tile-open';
    open.addEventListener('click', () => openLightbox(index));

    const img = document.createElement('img');
    img.src = item.url;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = item.fileName;
    img.addEventListener('error', () => {
      img.replaceWith(el('span', 'tile-placeholder', 'нет предпросмотра'));
    });

    open.append(img);
    tile.append(open);
  } else if (item.kind === 'video') {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'tile-open';
    open.addEventListener('click', () => openLightbox(index));

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

    open.append(video, playIcon);
    tile.append(open);
  } else {
    // Превью показать нечем — сразу отдаём файл по прямой ссылке, лайтбоксу тут нечего открывать.
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

// --- лайтбокс: полноэкранный просмотр с перелистыванием ---
// Создаётся один раз и живёт вне app, поэтому его не задевает render() сетки.

let lightbox: HTMLElement;
let lightboxContent: HTMLElement;
let lightboxGuest: HTMLElement;
let lightboxDownload: HTMLAnchorElement;

function buildLightbox() {
  lightbox = el('div', 'lightbox');
  lightbox.hidden = true;

  const close = el('button', 'lightbox-close', '×') as HTMLButtonElement;
  close.type = 'button';
  close.setAttribute('aria-label', 'Закрыть');
  close.addEventListener('click', closeLightbox);

  const prev = el('button', 'lightbox-nav lightbox-prev', '‹') as HTMLButtonElement;
  prev.type = 'button';
  prev.setAttribute('aria-label', 'Предыдущее');
  prev.addEventListener('click', () => showDelta(-1));

  const next = el('button', 'lightbox-nav lightbox-next', '›') as HTMLButtonElement;
  next.type = 'button';
  next.setAttribute('aria-label', 'Следующее');
  next.addEventListener('click', () => showDelta(1));

  lightboxContent = el('div', 'lightbox-content');

  lightboxGuest = el('span', 'hint');
  lightboxDownload = document.createElement('a');
  lightboxDownload.className = 'link';
  lightboxDownload.target = '_blank';
  lightboxDownload.rel = 'noopener';
  lightboxDownload.textContent = 'Скачать';
  const footer = el('div', 'lightbox-footer');
  footer.append(lightboxGuest, lightboxDownload);

  // Закрытие по тапу на тёмный фон — но не когда тап пришёлся на сам контент.
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) closeLightbox();
  });

  let touchStartX = 0;
  lightbox.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
  });
  lightbox.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 50) showDelta(dx < 0 ? 1 : -1);
  });

  document.addEventListener('keydown', (e) => {
    if (lightbox.hidden) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') showDelta(-1);
    else if (e.key === 'ArrowRight') showDelta(1);
  });

  lightbox.append(close, prev, lightboxContent, next, footer);
  document.body.append(lightbox);
}

function openLightbox(index: number) {
  if (!lightbox) buildLightbox();
  lightboxIndex = index;
  renderLightboxItem();
  lightbox.hidden = false;
}

function closeLightbox() {
  lightbox.hidden = true;
  lightboxIndex = null;
  lightboxContent.replaceChildren();
}

function showDelta(delta: number) {
  if (lightboxIndex === null || !visibleItems.length) return;
  lightboxIndex = (lightboxIndex + delta + visibleItems.length) % visibleItems.length;
  renderLightboxItem();
}

function renderLightboxItem() {
  if (lightboxIndex === null) return;
  const item = visibleItems[lightboxIndex];
  lightboxContent.replaceChildren();

  if (item.kind === 'image') {
    const img = document.createElement('img');
    img.src = item.url;
    img.alt = item.fileName;
    img.addEventListener('error', () => {
      img.replaceWith(el('p', 'lead', 'Не удалось загрузить превью'));
    });
    lightboxContent.append(img);
  } else if (item.kind === 'video') {
    const video = document.createElement('video');
    video.src = item.url;
    video.controls = true;
    video.playsInline = true;
    lightboxContent.append(video);
  } else {
    lightboxContent.append(el('p', 'lead', item.fileName));
  }

  lightboxGuest.textContent = item.guestSlug;
  lightboxDownload.href = item.url;
  lightboxDownload.download = item.fileName;
}

boot();

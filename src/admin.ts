import './style.css';
import JSZip from 'jszip';
import { HIDDEN_GUESTS_FILE, type Policy, type S3Object } from './types';
import { listAllObjects } from './s3-list';

const app = document.getElementById('app') as HTMLElement;

const UNLOCK_KEY = 'admin-unlocked';
// Архив крупнее — предупреждаем: он собирается в памяти вкладки браузера,
// на большом объёме она может зависнуть или упасть. Для таких объёмов
// надёжнее `npm run archive` — он пишет файлы на диск по одному, без лимита.
const WARN_ARCHIVE_BYTES = 1.5 * 1024 * 1024 * 1024;

interface GuestGroup {
  slug: string;
  objects: S3Object[];
  totalSize: number;
}

let policy: Policy;
let guests: GuestGroup[] = [];
let hidden = new Set<string>();
let loading = false;
let errorText: string | null = null;
let saving = false;
let saveError: string | null = null;
let savedJustNow = false;
let downloadingSlug: string | null = null;
let downloadProgress = '';
let downloadError: string | null = null;
let lastDownloadSlug: string | null = null;

async function boot() {
  if (!import.meta.env.VITE_ADMIN_PASSWORD) {
    return renderMessage('Панель недоступна', 'При сборке не задан VITE_ADMIN_PASSWORD.');
  }
  if (sessionStorage.getItem(UNLOCK_KEY) === '1') {
    await loadPolicyAndData();
  } else {
    renderLogin();
  }
}

function renderLogin(wrongPassword = false) {
  const form = document.createElement('form');
  form.className = 'card';

  const input = document.createElement('input');
  input.className = 'input';
  input.type = 'password';
  input.placeholder = 'Пароль';
  input.autocomplete = 'current-password';
  input.required = true;

  const button = el('button', 'btn btn-primary', 'Войти') as HTMLButtonElement;
  button.type = 'submit';

  form.append(el('h1', 'title', 'Админ-панель'), input, button);
  if (wrongPassword) form.append(el('p', 'lead warn', 'Неверный пароль'));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (input.value === import.meta.env.VITE_ADMIN_PASSWORD) {
      sessionStorage.setItem(UNLOCK_KEY, '1');
      void loadPolicyAndData();
    } else {
      renderLogin(true);
    }
  });

  app.replaceChildren(form);
  queueMicrotask(() => input.focus());
}

async function loadPolicyAndData() {
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
    const [objects, hiddenList] = await Promise.all([
      listAllObjects(policy.endpoint, policy.prefix),
      loadHidden(),
    ]);
    hidden = hiddenList;
    guests = groupByGuest(objects);
  } catch (err) {
    errorText = err instanceof Error ? err.message : 'Неизвестная ошибка';
  } finally {
    loading = false;
    render();
  }
}

async function loadHidden(): Promise<Set<string>> {
  try {
    const res = await fetch(`${policy.endpoint}/${policy.prefix}${HIDDEN_GUESTS_FILE}`, { cache: 'no-store' });
    if (!res.ok) return new Set();
    const data = await res.json();
    return new Set(Array.isArray(data.hidden) ? data.hidden : []);
  } catch {
    return new Set();
  }
}

function groupByGuest(objects: S3Object[]): GuestGroup[] {
  const bySlug = new Map<string, S3Object[]>();
  for (const obj of objects) {
    const rest = obj.key.slice(policy.prefix.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) continue; // системный файл вроде hidden-guests.json, не фото гостя
    const slug = rest.slice(0, slashIdx);
    const list = bySlug.get(slug);
    if (list) list.push(obj);
    else bySlug.set(slug, [obj]);
  }
  return [...bySlug.entries()]
    .map(([slug, list]) => ({ slug, objects: list, totalSize: list.reduce((sum, o) => sum + o.size, 0) }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** uuid никогда не содержит "_", поэтому надёжно отделяет исходное имя файла
 *  от служебного префикса ключа — та же логика, что и в gallery.ts. */
function recoverFileName(key: string): string {
  const tail = key.slice(key.lastIndexOf('/') + 1);
  const underscoreIdx = tail.indexOf('_');
  return underscoreIdx === -1 ? tail : tail.slice(underscoreIdx + 1);
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} ГБ` : `${Math.round(mb)} МБ`;
}

// --- отрисовка ---

function renderMessage(title: string, text: string) {
  app.replaceChildren(el('h1', 'title', title), el('p', 'lead', text));
}

function render() {
  app.replaceChildren();
  app.append(el('h1', 'title', 'Админ-панель'), el('p', 'hint', policy.eventTitle));

  if (loading) {
    app.append(el('p', 'loading', 'Загружаем…'));
    return;
  }

  if (errorText) {
    app.append(el('p', 'lead warn', errorText));
    return;
  }

  if (!guests.length) {
    app.append(el('p', 'lead', 'Пока никто ничего не загрузил.'));
    return;
  }

  app.append(
    el('p', 'hint', 'Снимите галочку, чтобы скрыть все файлы гостя из общей галереи.'),
    renderGuestList(),
    renderSaveButton(),
  );

  if (saveError) app.append(el('p', 'lead warn', saveError));
  else if (savedJustNow) app.append(el('p', 'lead ok', 'Сохранено'));
}

function renderGuestList(): HTMLElement {
  const list = el('ul', 'list');
  for (const guest of guests) {
    const li = el('li', 'row admin-guest-row');
    const label = document.createElement('label');
    label.className = 'admin-toggle';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !hidden.has(guest.slug);
    // Пока идёт сохранение — блокируем: иначе тумблер, переключённый во время
    // запроса, попадёт в визуальный «Сохранено», не попав в реальный снимок,
    // который уже ушёл на сервер.
    checkbox.disabled = saving;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) hidden.delete(guest.slug);
      else hidden.add(guest.slug);
    });

    label.append(
      checkbox,
      document.createTextNode(`${guest.slug} (${guest.objects.length}, ${formatBytes(guest.totalSize)})`),
    );
    li.append(label, renderDownloadButton(guest));

    if (downloadingSlug === guest.slug) {
      li.append(el('p', 'hint admin-guest-info', downloadProgress));
    } else if (downloadError && downloadingSlug === null && guest.slug === lastDownloadSlug) {
      li.append(el('p', 'lead warn admin-guest-info', downloadError));
    }

    list.append(li);
  }
  return list;
}

function renderDownloadButton(guest: GuestGroup): HTMLElement {
  const busy = downloadingSlug === guest.slug;
  const btn = el('button', 'link', busy ? 'Собираю…' : 'Скачать архивом') as HTMLButtonElement;
  btn.type = 'button';
  btn.disabled = downloadingSlug !== null;
  btn.addEventListener('click', () => void downloadGuestArchive(guest));
  return btn;
}

function renderSaveButton(): HTMLElement {
  const btn = el('button', 'btn btn-primary', saving ? 'Сохраняем…' : 'Сохранить') as HTMLButtonElement;
  btn.type = 'button';
  btn.disabled = saving;
  btn.addEventListener('click', () => void save());
  return btn;
}

async function save() {
  saving = true;
  saveError = null;
  savedJustNow = false;
  render();

  try {
    await saveHidden([...hidden]);
    savedJustNow = true;
  } catch (err) {
    saveError = err instanceof Error ? err.message : 'Не удалось сохранить';
  } finally {
    saving = false;
    render();
  }
}

async function saveHidden(list: string[]): Promise<void> {
  const form = new FormData();
  form.append('key', `${policy.prefix}${HIDDEN_GUESTS_FILE}`);
  for (const [name, value] of Object.entries(policy.fields)) form.append(name, value);
  form.append('Content-Type', 'application/json');
  // Поле обязательно по условиям политики (starts-with ''), содержимое не важно.
  form.append('x-amz-meta-guest', 'admin');
  form.append('file', new Blob([JSON.stringify({ hidden: list })], { type: 'application/json' }), HIDDEN_GUESTS_FILE);

  const res = await fetch(policy.endpoint, { method: 'POST', body: form });
  if (!res.ok) {
    const text = await res.text();
    const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
    throw new Error(`Ошибка сохранения ${res.status}${code ? ` (${code})` : ''}`);
  }
}

async function downloadGuestArchive(guest: GuestGroup) {
  if (guest.totalSize > WARN_ARCHIVE_BYTES) {
    const ok = confirm(
      `Архив «${guest.slug}» весит ${formatBytes(guest.totalSize)} — он собирается в памяти вкладки ` +
        'и на таком объёме браузер может зависнуть или упасть. Для больших объёмов надёжнее ' +
        '`npm run archive` с компьютера. Всё равно попробовать через браузер?',
    );
    if (!ok) return;
  }

  downloadingSlug = guest.slug;
  lastDownloadSlug = guest.slug;
  downloadError = null;
  render();

  const zip = new JSZip();
  const usedNames = new Map<string, number>();
  let done = 0;
  let failed = 0;

  for (const obj of guest.objects) {
    downloadProgress = `Скачиваю файлы: ${done}/${guest.objects.length}${failed ? ` (${failed} не удалось)` : ''}`;
    render();

    try {
      const url = `${policy.endpoint}/${obj.key.split('/').map(encodeURIComponent).join('/')}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();

      let name = recoverFileName(obj.key);
      const uses = usedNames.get(name) ?? 0;
      usedNames.set(name, uses + 1);
      if (uses > 0) {
        const dotIdx = name.lastIndexOf('.');
        name = dotIdx === -1 ? `${name} (${uses + 1})` : `${name.slice(0, dotIdx)} (${uses + 1})${name.slice(dotIdx)}`;
      }
      zip.file(name, blob);
    } catch {
      failed++;
    }
    done++;
  }

  downloadProgress = 'Упаковываю архив…';
  render();

  try {
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${guest.slug}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    downloadError = failed ? `Готово, но ${failed} из ${guest.objects.length} файлов не удалось скачать` : null;
  } catch (err) {
    downloadError = err instanceof Error ? err.message : 'Не удалось собрать архив';
  } finally {
    downloadingSlug = null;
    render();
  }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

boot();

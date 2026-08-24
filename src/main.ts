import './style.css';
import type { Policy, UploadItem } from './types';
import { runQueue } from './upload';

const app = document.getElementById('app') as HTMLElement;

const GUEST_KEY = 'guest-name';
let policy: Policy;
let guest = localStorage.getItem(GUEST_KEY) ?? '';
let items: UploadItem[] = [];
let busy = false;
let wakeLock: WakeLockSentinel | null = null;

/** Ссылки на живые узлы строк: прогресс приходит десятками раз в секунду,
 *  перерисовывать ради него весь экран нельзя. */
const rows = new Map<string, { li: HTMLElement; state: HTMLElement; fill: HTMLElement }>();
let summaryNode: HTMLElement | null = null;
let frame = 0;

// --- запуск ---

async function boot() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}policy.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    policy = await res.json();
  } catch {
    return renderMessage('Страница не настроена', 'Не удалось загрузить параметры доступа.');
  }

  if (new Date(policy.expiresAt).getTime() < Date.now()) {
    return renderMessage(
      'Приём файлов завершён',
      'Спасибо! Загрузка для этого события уже закрыта.',
    );
  }

  render();
}

// --- полная отрисовка: только когда меняется структура экрана ---

function renderMessage(title: string, text: string) {
  app.replaceChildren(el('h1', 'title', title), el('p', 'lead', text));
}

function render() {
  rows.clear();
  summaryNode = null;
  app.replaceChildren();
  app.append(el('h1', 'title', policy.eventTitle));

  if (!guest) {
    app.append(renderNameForm());
    return;
  }

  app.append(
    el('p', 'lead', `${guest}, выберите фото и видео — они уйдут прямо в наш архив.`),
    renderPicker(),
  );

  if (items.length) {
    app.append(renderList());
    summaryNode = renderSummary();
    app.append(summaryNode);
  }

  app.append(renderFooter());
}

function renderNameForm(): HTMLElement {
  const form = document.createElement('form');
  form.className = 'card';

  const input = document.createElement('input');
  input.className = 'input';
  input.type = 'text';
  input.placeholder = 'Как вас зовут?';
  input.autocomplete = 'name';
  input.required = true;
  input.maxLength = 60;

  const button = el('button', 'btn btn-primary', 'Продолжить') as HTMLButtonElement;
  button.type = 'submit';

  form.append(el('p', 'hint', 'Имя нужно, чтобы мы знали, чьи это снимки.'), input, button);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    guest = value;
    localStorage.setItem(GUEST_KEY, guest);
    render();
  });

  queueMicrotask(() => input.focus());
  return form;
}

function renderPicker(): HTMLElement {
  const wrap = el('div', 'card');

  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'image/*,video/*';
  input.className = 'file-input';
  input.id = 'file-input';

  const label = document.createElement('label');
  label.className = 'btn btn-primary';
  label.htmlFor = 'file-input';
  label.textContent = items.length ? 'Добавить ещё' : 'Выбрать фото и видео';

  input.addEventListener('change', () => {
    if (input.files) addFiles(Array.from(input.files));
    input.value = '';
  });

  wrap.append(
    input,
    label,
    el('p', 'hint', `До ${formatMaxSize(policy.maxBytes)} на файл`),
  );
  return wrap;
}

function renderList(): HTMLElement {
  const list = el('ul', 'list');
  for (const item of items) {
    const li = el('li', `row row-${item.status}`);
    const state = el('span', 'row-state', stateLabel(item));
    const bar = el('div', 'bar');
    const fill = el('div', 'bar-fill');
    fill.style.width = `${Math.round(item.progress * 100)}%`;

    bar.append(fill);
    li.append(el('span', 'row-name', item.file.name), state, bar);
    list.append(li);
    rows.set(item.id, { li, state, fill });
  }
  return list;
}

function renderSummary(): HTMLElement {
  const wrap = el('div', 'card summary');
  fillSummary(wrap);
  return wrap;
}

function fillSummary(wrap: HTMLElement) {
  const done = items.filter((i) => i.status === 'done').length;
  const failed = items.filter((i) => i.status === 'error').length;
  wrap.replaceChildren();

  if (busy) {
    wrap.append(
      el('p', 'lead', `Загружено ${done} из ${items.length}`),
      el('p', 'hint warn', 'Не закрывайте страницу и не блокируйте экран.'),
    );
    return;
  }

  if (failed) {
    const retry = el('button', 'btn btn-primary', `Повторить (${failed})`) as HTMLButtonElement;
    retry.addEventListener('click', () => start());
    wrap.append(el('p', 'lead', `Не удалось отправить ${failed}. Обычно помогает повтор.`), retry);
    return;
  }

  wrap.append(el('p', 'lead ok', `Спасибо! Отправлено файлов: ${done}.`));
}

function renderFooter(): HTMLElement {
  const footer = el('p', 'hint');
  const change = el('button', 'link', 'это не я');
  change.addEventListener('click', () => {
    if (busy) return;
    localStorage.removeItem(GUEST_KEY);
    guest = '';
    items = [];
    render();
  });
  footer.append(document.createTextNode(`Вы отправляете как ${guest} — `), change);
  return footer;
}

// --- точечное обновление во время загрузки ---

function scheduleUpdate() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const item of items) {
      const row = rows.get(item.id);
      if (!row) continue;
      row.li.className = `row row-${item.status}`;
      row.state.textContent = stateLabel(item);
      row.fill.style.width = `${Math.round(item.progress * 100)}%`;
    }
    if (summaryNode) fillSummary(summaryNode);
  });
}

function stateLabel(item: UploadItem): string {
  switch (item.status) {
    case 'done':
      return 'готово';
    case 'error':
      return item.error ?? 'ошибка';
    case 'uploading':
      return `${Math.round(item.progress * 100)}%`;
    default:
      return 'в очереди';
  }
}

// --- действия ---

function addFiles(files: File[]) {
  for (const file of files) {
    const id = `${file.name}:${file.size}:${file.lastModified}`;
    // Один и тот же файл легко выбрать дважды — второй раз он не нужен.
    if (items.some((i) => i.id === id)) continue;

    const item: UploadItem = { id, file, status: 'pending', progress: 0, attempts: 0 };
    if (file.size > policy.maxBytes) {
      item.status = 'error';
      item.error = 'Больше допустимого размера';
    }
    items.push(item);
  }
  render();
  start();
}

async function start() {
  if (busy) return;
  const pending = items.filter((i) => i.status === 'pending' || i.status === 'error');
  if (!pending.length) return;

  busy = true;
  await acquireWakeLock();
  render();

  try {
    await runQueue(policy, guest, items, scheduleUpdate);
  } finally {
    busy = false;
    releaseWakeLock();
    render();
  }
}

// --- мелочи, без которых загрузка обрывается на телефоне ---

async function acquireWakeLock() {
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    // Не поддерживается или запрещено — не повод останавливать загрузку.
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && busy && !wakeLock) void acquireWakeLock();
});

window.addEventListener('beforeunload', (e) => {
  if (!busy) return;
  e.preventDefault();
  e.returnValue = '';
});

// --- утилита ---

function formatMaxSize(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1).replace('.0', '')} ГБ` : `${Math.round(mb)} МБ`;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

boot();

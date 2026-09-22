#!/usr/bin/env node
// Скачивает все объекты бакета в одну плоскую папку в Downloads — без
// архивации и без подпапок по гостям. Имена файлов восстановлены (без
// служебного uuid), с префиксом гостя — чтобы не путать чужие IMG_1234.
//
// Запуск: node scripts/download-all.mjs   (или npm run download)

import { createHash, createHmac } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const envPath = resolve(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Не задана переменная ${name}. Смотри .env.example`);
    process.exit(1);
  }
  return v;
}

const ak = required('YC_ACCESS_KEY_ID');
const sk = required('YC_SECRET_ACCESS_KEY');
const bucket = required('YC_BUCKET');
const region = process.env.YC_REGION || 'ru-central1';
const host = (process.env.YC_ENDPOINT || 'https://storage.yandexcloud.net').replace(/^https?:\/\//, '');

// Имя папки назначения — намеренно захардкожено, не параметризуем.
const destDir = join(homedir(), 'Downloads', 'event-photos');

function sign(method, path, query, payloadHash) {
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const canonical = [
    method,
    path,
    query,
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    '',
    'host;x-amz-content-sha256;x-amz-date',
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonical).digest('hex'),
  ].join('\n');
  const hmac = (k, d) => createHmac('sha256', k).update(d, 'utf8').digest();
  const signingKey = ['AWS4' + sk, dateStamp, region, 's3', 'aws4_request'].reduce(hmac);
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
}

const emptyHash = createHash('sha256').update('').digest('hex');

// Список объектов постранично: список из 1000+ файлов сервер отдаёт по частям,
// без учёта continuation-token часть файлов тихо потерялась бы.
async function listAllKeys() {
  const keys = [];
  let token = '';
  for (;;) {
    const query = token ? `list-type=2&continuation-token=${encodeURIComponent(token)}` : 'list-type=2';
    const res = await fetch(`https://${host}/${bucket}?${query}`, {
      headers: sign('GET', `/${bucket}`, query, emptyHash),
    });
    if (!res.ok) {
      console.error(`Не удалось получить список объектов: HTTP ${res.status}`);
      console.error(await res.text());
      process.exit(1);
    }
    const xml = await res.text();
    keys.push(...[...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]));
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
    token = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1];
    if (!token) break;
  }
  return keys;
}

// Ключ вида <EVENT_ID>/<guest-slug>/<uuid>_<имя>.ext — uuid никогда не
// содержит "_", поэтому по первому "_" в последнем сегменте надёжно
// отделяется исходное имя файла.
function guestAndFileName(key) {
  const segments = key.split('/');
  const guestSlug = segments[1] ?? '';
  const tail = segments[segments.length - 1];
  const underscoreIdx = tail.indexOf('_');
  const fileName = underscoreIdx === -1 ? tail : tail.slice(underscoreIdx + 1);
  return { guestSlug, fileName };
}

const keys = await listAllKeys();
console.log(`Объектов в бакете «${bucket}»: ${keys.length}\n`);

if (!keys.length) {
  console.log('Бакет пуст — скачивать нечего.');
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });

let totalBytes = 0;
const usedNames = new Map();
for (let i = 0; i < keys.length; i++) {
  const key = keys[i];
  const path = `/${bucket}/${key}`;
  const res = await fetch(`https://${host}${path}`, { headers: sign('GET', path, '', emptyHash) });
  if (!res.ok) {
    console.error(`  [${i + 1}/${keys.length}] ! ${key} -> HTTP ${res.status}`);
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());

  const { guestSlug, fileName } = guestAndFileName(key);
  let name = guestSlug ? `${guestSlug}_${fileName}` : fileName;
  // Все файлы в одной папке — совпадения по имени (два гостя с IMG_1234)
  // разруливаем суффиксом, а не тихой перезаписью.
  const uses = usedNames.get(name) ?? 0;
  usedNames.set(name, uses + 1);
  if (uses > 0) {
    const dotIdx = name.lastIndexOf('.');
    name = dotIdx === -1 ? `${name} (${uses + 1})` : `${name.slice(0, dotIdx)} (${uses + 1})${name.slice(dotIdx)}`;
  }

  writeFileSync(join(destDir, name), buf);
  totalBytes += buf.length;
  console.log(`  [${i + 1}/${keys.length}] ${name}  (${(buf.length / 1024).toFixed(0)} КБ)`);
}

console.log(`\nГотово: ${keys.length} файлов, ${(totalBytes / 1024 / 1024).toFixed(1)} МБ`);
console.log(`Папка: ${destDir}`);

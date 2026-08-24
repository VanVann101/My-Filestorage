#!/usr/bin/env node
// Генерирует подписанную POST-политику для Yandex Object Storage.
// Результат кладётся в public/policy.json и попадает в сборку как статика.
//
// Секретный ключ здесь НЕ публикуется: в policy.json уходит только подпись,
// ограниченная бакетом, префиксом ключа, размером файла и сроком действия.
//
// Запуск: node scripts/gen-policy.mjs   (переменные берутся из .env или окружения)

import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// --- мини-загрузчик .env, чтобы не тащить зависимость ---
const envPath = resolve(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
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

const accessKeyId = required('YC_ACCESS_KEY_ID');
const secretAccessKey = required('YC_SECRET_ACCESS_KEY');
const bucket = required('YC_BUCKET');
const region = process.env.YC_REGION || 'ru-central1';
const endpoint = process.env.YC_ENDPOINT || 'https://storage.yandexcloud.net';
const eventId = process.env.EVENT_ID || 'event';
const eventTitle = process.env.EVENT_TITLE || 'Наше событие';
const days = Number(process.env.POLICY_DAYS || 7);
const maxFileMb = Number(process.env.MAX_FILE_MB || 512);

const maxBytes = Math.round(maxFileMb * 1024 * 1024);
const prefix = `${eventId}/`;

const now = new Date();
const expiration = new Date(now.getTime() + days * 86400_000);

const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateStamp = amzDate.slice(0, 8);
const credential = `${accessKeyId}/${dateStamp}/${region}/s3/aws4_request`;

// Каждое поле формы (кроме file, policy и самих x-amz-signature/credential/
// algorithm/date) обязано быть описано в политике, иначе хранилище отвергнет POST.
const policy = {
  expiration: expiration.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  conditions: [
    { bucket },
    ['starts-with', '$key', prefix],
    { 'x-amz-algorithm': 'AWS4-HMAC-SHA256' },
    { 'x-amz-credential': credential },
    { 'x-amz-date': amzDate },
    { success_action_status: '201' },
    ['starts-with', '$Content-Type', ''],
    ['starts-with', '$x-amz-meta-guest', ''],
    ['content-length-range', 1, maxBytes],
  ],
};

const policyB64 = Buffer.from(JSON.stringify(policy), 'utf8').toString('base64');

const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();
const signingKey = ['AWS4' + secretAccessKey, dateStamp, region, 's3', 'aws4_request'].reduce(
  (key, part) => hmac(key, part),
);
const signature = createHmac('sha256', signingKey).update(policyB64, 'utf8').digest('hex');

const out = {
  endpoint: `${endpoint}/${bucket}`,
  prefix,
  eventTitle,
  maxBytes,
  expiresAt: policy.expiration,
  fields: {
    'x-amz-algorithm': 'AWS4-HMAC-SHA256',
    'x-amz-credential': credential,
    'x-amz-date': amzDate,
    policy: policyB64,
    'x-amz-signature': signature,
    success_action_status: '201',
  },
};

mkdirSync(resolve(root, 'public'), { recursive: true });
writeFileSync(resolve(root, 'public/policy.json'), JSON.stringify(out, null, 2) + '\n');

console.log('public/policy.json записан');
console.log(`  бакет:        ${bucket}`);
console.log(`  префикс:      ${prefix}`);
console.log(`  макс. файл:   ${maxFileMb} МБ`);
console.log(`  действует до: ${out.expiresAt}`);

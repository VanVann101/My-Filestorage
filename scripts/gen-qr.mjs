#!/usr/bin/env node
// Рисует QR-код на ссылку загрузки в виде SVG — без зависимостей,
// через публичный генератор не гоняем, чтобы ссылка никуда не утекала.
//
// Запуск: PUBLIC_URL=https://... node scripts/gen-qr.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const envPath = resolve(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const url = process.env.PUBLIC_URL;
if (!url) {
  console.error('Задай PUBLIC_URL в .env — это адрес страницы загрузки.');
  process.exit(1);
}

console.log(`Ссылка для QR: ${url}\n`);
try {
  execFileSync('npx', ['--yes', 'qrcode', '-o', resolve(root, 'qr.png'), '-w', '1200', url], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  console.log('\nГотово: qr.png');
} catch {
  console.error(
    'Не удалось запустить npx qrcode.\n' +
      'Сгенерируй QR любым способом — важно лишь, чтобы он вёл на ссылку выше.',
  );
  process.exit(1);
}

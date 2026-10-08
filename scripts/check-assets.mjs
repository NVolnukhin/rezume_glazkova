#!/usr/bin/env node
/**
 * Предполётная проверка перед деплоем.
 *
 * Сайт статический, собирать нечего — поэтому единственный реальный риск
 * это «висящая» ссылка на файл, которого нет в репозитории. Скрипт импортирует
 * тот же data.js, что и страница, и проверяет каждый путь.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const checked = new Set();

function must(relPath, what) {
  const clean = relPath.split(/[?#]/)[0];
  if (!clean || /^(https?:)?\/\//.test(clean) || clean.startsWith('data:')) return;
  if (checked.has(clean)) return;
  checked.add(clean);
  if (!existsSync(join(ROOT, clean))) errors.push(`${what}: нет файла ${clean}`);
}

/* 1. Портфолио — обложки и PDF из data.js */
const { PROJECTS, TOTAL_SHEETS } = await import(join(ROOT, 'assets/js/data.js'));

if (!Array.isArray(PROJECTS) || PROJECTS.length === 0) {
  errors.push('data.js: список PROJECTS пуст');
}

let sheets = 0;
for (const project of PROJECTS) {
  must(project.cover, `проект «${project.title}», обложка`);
  if (!project.sheets?.length) errors.push(`проект «${project.title}»: нет листов`);
  for (const sheet of project.sheets ?? []) {
    must(sheet.file, `проект «${project.title}», лист «${sheet.title}»`);
    if (!Number.isInteger(sheet.pages) || sheet.pages < 1) {
      errors.push(`проект «${project.title}», лист «${sheet.title}»: некорректное число страниц`);
    }
    sheets += sheet.pages ?? 0;
  }
}
if (sheets !== TOTAL_SHEETS) {
  errors.push(`TOTAL_SHEETS = ${TOTAL_SHEETS}, а по листам выходит ${sheets}`);
}

/* 2. Ссылки на ресурсы из index.html */
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
  if (m[1].startsWith('#') || m[1].startsWith('tel:') || m[1].startsWith('mailto:')) continue;
  must(m[1], 'index.html');
}
for (const m of html.matchAll(/content="(assets\/[^"]+)"/g)) must(m[1], 'index.html, мета-тег');

/* 3. @font-face внутри fonts.css */
const fontsCss = readFileSync(join(ROOT, 'assets/fonts/fonts.css'), 'utf8');
for (const m of fontsCss.matchAll(/url\(\.\/([^)]+)\)/g)) must(`assets/fonts/${m[1]}`, 'fonts.css');

/* 4. Вендорный PDF.js — без него не откроется ни один чертёж */
for (const file of ['assets/vendor/pdfjs/pdf.min.mjs', 'assets/vendor/pdfjs/pdf.worker.min.mjs']) {
  must(file, 'PDF.js');
}

/* 5. .nojekyll — иначе Pages проигнорирует часть путей */
if (!existsSync(join(ROOT, '.nojekyll'))) errors.push('нет файла .nojekyll в корне');

/* 6. Свой домен.
   Публикуемся своим Actions-воркфлоу, а не из ветки, поэтому GitHub не создаёт
   CNAME сам — файл лежит в репозитории руками, и потерять его легко.
   Заодно сверяем домен с абсолютными ссылками в мета-тегах: разъехавшийся
   og:image ломает превью молча, без ошибок в консоли. */
let domain = null;
if (!existsSync(join(ROOT, 'CNAME'))) {
  errors.push('нет файла CNAME в корне — свой домен отвалится на ближайшем деплое');
} else {
  const lines = readFileSync(join(ROOT, 'CNAME'), 'utf8').trim().split('\n');
  domain = lines[0].trim();
  if (lines.length !== 1 || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    errors.push(`CNAME должен содержать ровно одно доменное имя, а там: ${JSON.stringify(domain)}`);
  }
}

for (const m of html.matchAll(/(?:content|href)="https:\/\/([a-z0-9.-]+)(\/[^"]*)?"/gi)) {
  const [, host, path = '/'] = m;
  if (domain && host !== domain) {
    errors.push(`index.html ссылается на https://${host}${path}, а в CNAME домен ${domain}`);
  }
  if (path !== '/') must(path.slice(1), 'index.html, абсолютная ссылка');
}

if (errors.length) {
  console.error('✗ Проверка не пройдена:\n' + errors.map((e) => `  · ${e}`).join('\n'));
  process.exit(1);
}

console.log(
  `✓ Проверка пройдена: ${PROJECTS.length} проектов, ${TOTAL_SHEETS} листов, ` +
  `${checked.size} путей на месте, домен ${domain}.`
);

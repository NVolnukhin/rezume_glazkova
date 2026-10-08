/**
 * Логика страницы: динамические даты, навигация, карточки портфолио.
 * Просмотрщик чертежей подгружается отдельным модулем по требованию.
 */

import { BIRTH_DATE, EXPERIENCE_PERIODS, PROJECTS, TOTAL_SHEETS } from './data.js';

/* ------------------------------------------------------------------ *
 *  Русские числительные
 * ------------------------------------------------------------------ */

/** Выбирает форму слова: plural(5, 'год', 'года', 'лет') → 'лет'. */
function plural(n, one, few, many) {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

const YEARS = (n) => `${n} ${plural(n, 'год', 'года', 'лет')}`;
const MONTHS = (n) => `${n} ${plural(n, 'месяц', 'месяца', 'месяцев')}`;

/* ------------------------------------------------------------------ *
 *  Даты
 * ------------------------------------------------------------------ */

/** Полных лет на сегодня. */
function ageFrom(isoDate, today = new Date()) {
  const [y, m, d] = isoDate.split('-').map(Number);
  let age = today.getFullYear() - y;
  const hadBirthday =
    today.getMonth() + 1 > m || (today.getMonth() + 1 === m && today.getDate() >= d);
  if (!hadBirthday) age -= 1;
  return age;
}

/** Порядковый номер месяца: 'YYYY-MM' → число месяцев от нулевого года. */
function monthIndex(ym) {
  const [y, m] = ym.split('-').map(Number);
  return y * 12 + (m - 1);
}

/** Текущий месяц в том же представлении. */
function currentMonthIndex(today = new Date()) {
  return today.getFullYear() * 12 + today.getMonth();
}

/**
 * Длительность периода в месяцах — границы включительно,
 * как считает hh.ru (май—июнь = 2 месяца).
 */
function periodMonths(period, today = new Date()) {
  const from = monthIndex(period.start);
  const to = period.end ? monthIndex(period.end) : currentMonthIndex(today);
  return Math.max(0, to - from + 1);
}

/**
 * Суммарный стаж в месяцах: пересекающиеся периоды не считаются дважды.
 */
function totalExperienceMonths(periods, today = new Date()) {
  const months = new Set();
  for (const p of periods) {
    const from = monthIndex(p.start);
    const to = p.end ? monthIndex(p.end) : currentMonthIndex(today);
    for (let i = from; i <= to; i += 1) months.add(i);
  }
  return months.size;
}

/** 21 → «1 год 9 месяцев»; 24 → «2 года»; 3 → «3 месяца». */
function formatDuration(totalMonths) {
  const y = Math.floor(totalMonths / 12);
  const m = totalMonths % 12;
  if (y && m) return `${YEARS(y)} ${MONTHS(m)}`;
  if (y) return YEARS(y);
  return MONTHS(m);
}

/** Короткая форма для плитки показателей: до года — месяцы, дальше — годы. */
function formatDurationShort(totalMonths) {
  const y = Math.floor(totalMonths / 12);
  return y >= 1 ? YEARS(y) : MONTHS(totalMonths);
}

const RU_MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

function formatToday(today = new Date()) {
  return `${today.getDate()} ${RU_MONTHS[today.getMonth()]} ${today.getFullYear()}`;
}

/* ------------------------------------------------------------------ *
 *  Подстановка динамических значений
 * ------------------------------------------------------------------ */

function fillDynamicValues() {
  const now = new Date();
  const totalMonths = totalExperienceMonths(EXPERIENCE_PERIODS, now);

  const setAll = (selector, value) => {
    document.querySelectorAll(selector).forEach((el) => { el.textContent = value; });
  };

  const age = ageFrom(BIRTH_DATE, now);
  setAll('[data-age]', YEARS(age));
  setAll('[data-total-experience]', formatDuration(totalMonths));
  setAll('[data-total-experience-short]', formatDurationShort(totalMonths));
  setAll('[data-total-sheets]', String(TOTAL_SHEETS));
  setAll('[data-total-projects]', String(PROJECTS.length));
  setAll('[data-year]', String(now.getFullYear()));
  setAll('[data-today-iso]', formatToday(now));

  document.querySelectorAll('[data-job-duration]').forEach((el) => {
    const period = EXPERIENCE_PERIODS.find((p) => p.id === el.dataset.jobDuration);
    if (period) el.textContent = formatDuration(periodMonths(period, now));
  });
}

/* ------------------------------------------------------------------ *
 *  Навигация
 * ------------------------------------------------------------------ */

function initNavigation() {
  const header = document.getElementById('siteHeader');
  const nav = document.getElementById('siteNav');
  const toggle = document.getElementById('navToggle');
  if (!header || !nav || !toggle) return;

  const closeMenu = () => {
    nav.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
  };

  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  nav.addEventListener('click', (e) => {
    if (e.target.closest('a')) closeMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });

  // Тень/линия под шапкой при прокрутке
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px;';
  document.body.prepend(sentinel);
  new IntersectionObserver(
    ([entry]) => header.classList.toggle('is-stuck', !entry.isIntersecting)
  ).observe(sentinel);

  // Подсветка активного раздела
  const links = [...nav.querySelectorAll('a[href^="#"]')];
  const sections = links
    .map((a) => document.querySelector(a.getAttribute('href')))
    .filter(Boolean);
  if (!sections.length) return;

  const spy = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        links.forEach((a) =>
          a.classList.toggle('is-active', a.getAttribute('href') === `#${entry.target.id}`)
        );
      });
    },
    { rootMargin: '-45% 0px -50% 0px', threshold: 0 }
  );
  sections.forEach((s) => spy.observe(s));
}

/* ------------------------------------------------------------------ *
 *  Портфолио
 * ------------------------------------------------------------------ */

const ICON_EXPAND =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">' +
  '<path d="M2 6V2h4M14 10v4h-4M10 2h4v4M6 14H2v-4"/></svg>';

function projectSheetCount(project) {
  return project.sheets.reduce((sum, s) => sum + s.pages, 0);
}

function buildProjectCard(project) {
  const sheets = projectSheetCount(project);
  const card = document.createElement('article');
  card.className = 'project';
  card.innerHTML = `
    <div class="project__media">
      <img src="${project.cover}" alt="Лист проекта «${project.title}»"
           width="1200" height="849" loading="lazy" decoding="async">
      <span class="project__index">${project.index}</span>
      <span class="project__sheets">${sheets} ${plural(sheets, 'лист', 'листа', 'листов')}</span>
    </div>
    <div class="project__body t-stagger">
      <p class="project__meta t-stagger-line">
        <span>${project.org}</span><span>${project.year}</span><span>${project.kind}</span>
      </p>
      <h3 class="project__title t-stagger-line">${project.title}</h3>
      <p class="project__stage t-stagger-line">${project.stage} · ${project.section}</p>
      <p class="project__summary t-stagger-line">${project.summary}</p>
      <ul class="project__tags t-stagger-line">
        ${project.tags.map((t) => `<li class="project__tag">${t}</li>`).join('')}
      </ul>
    </div>
    <div class="project__foot">
      <button class="project__open" type="button">${ICON_EXPAND} Открыть листы</button>
      <a class="project__dl" href="${project.sheets[0].file}" download>Скачать PDF</a>
    </div>
  `;

  const open = () => openViewer(project);
  card.querySelector('.project__open').addEventListener('click', open);
  card.querySelector('.project__media').addEventListener('click', open);
  card.querySelector('.project__media').style.cursor = 'pointer';
  card.querySelector('.project__title').addEventListener('click', open);
  card.querySelector('.project__title').style.cursor = 'pointer';
  return card;
}

function renderProjects() {
  const host = document.getElementById('projects');
  if (!host) return;
  host.innerHTML = '';
  const frag = document.createDocumentFragment();
  PROJECTS.forEach((p) => frag.append(buildProjectCard(p)));
  host.append(frag);
}

/* ------------------------------------------------------------------ *
 *  Ленивое подключение просмотрщика
 * ------------------------------------------------------------------ */

let viewerModule = null;
let viewerLoading = null;

function loadViewer() {
  if (viewerModule) return Promise.resolve(viewerModule);
  if (!viewerLoading) {
    viewerLoading = import('./viewer.js').then((mod) => {
      viewerModule = mod;
      return mod;
    });
  }
  return viewerLoading;
}

async function openViewer(project, startPage = 0) {
  try {
    const mod = await loadViewer();
    await mod.open(project, startPage);
  } catch (err) {
    console.error('Не удалось открыть просмотрщик', err);
    window.open(project.sheets[0].file, '_blank', 'noopener');
  }
}

/* Предзагружаем модуль, когда пользователь приближается к портфолио. */
function prefetchViewer() {
  const section = document.getElementById('portfolio');
  if (!section) return;
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        loadViewer().catch(() => {});
      }
    },
    { rootMargin: '400px' }
  );
  io.observe(section);
}

/* ------------------------------------------------------------------ *
 *  Появление блоков при прокрутке
 * ------------------------------------------------------------------ */

/**
 * Разбивает текст внутри элемента на слова в отдельных span-ах
 * и нумерует их через --i: задержку дальше считает CSS.
 * Пробелы остаются обычными текстовыми узлами, поэтому переносы
 * строк и неразрывные пробелы работают как раньше.
 */
function splitIntoWords(root) {
  if (root.dataset.streamReady) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  const words = [];
  for (const node of textNodes) {
    if (!node.nodeValue.trim()) continue;
    const frag = document.createDocumentFragment();
    for (const chunk of node.nodeValue.split(/(\s+)/)) {
      if (!chunk) continue;
      if (!chunk.trim()) {
        frag.append(chunk);
        continue;
      }
      const span = document.createElement('span');
      span.className = 't-stream-w';
      span.textContent = chunk;
      frag.append(span);
      words.push(span);
    }
    node.replaceWith(frag);
  }

  words.forEach((word, i) => word.style.setProperty('--i', String(i)));
  root.dataset.streamReady = '1';
}

/** Проставляет строкам порядковый номер — его читает transition-delay. */
function prepareStagger(root) {
  if (root.dataset.staggerReady) return;
  root.querySelectorAll(':scope > .t-stagger-line').forEach((line, i) => {
    line.style.setProperty('--i', String(i));
  });
  root.dataset.staggerReady = '1';
}

/** Запускает анимации текста внутри блока (и на нём самом). */
function playTextIn(root) {
  const pick = (selector) => {
    const list = [...root.querySelectorAll(selector)];
    if (root.matches && root.matches(selector)) list.unshift(root);
    return list.filter((el) => !el.classList.contains('is-shown'));
  };

  const staggers = pick('.t-stagger');
  const streams = pick('.t-stream');
  if (!staggers.length && !streams.length) return;

  staggers.forEach(prepareStagger);
  streams.forEach(splitIntoWords);

  // Слова создаются прямо сейчас: без принудительного пересчёта стилей
  // браузер применит к ним сразу конечное состояние и перехода не будет.
  void document.body.offsetWidth;

  staggers.forEach((el) => el.classList.add('is-shown'));
  streams.forEach((el) => el.classList.add('is-shown'));
}

function initReveal() {
  const targets = [...document.querySelectorAll(
    '.sec-head, .about, .job, .card, .software, .project, .edu__item, .contacts, .metric'
  )];
  if (!targets.length) return;

  const reveal = (el, delay = 0) => {
    el.style.transitionDelay = delay ? `${delay}ms` : '';
    el.classList.add('is-in');
    playTextIn(el);
  };
  const revealAll = () => {
    targets.forEach((el) => reveal(el));
    playTextIn(document.body);
  };
  const root = document.documentElement;

  // Анимация отключена настройками системы или браузер без IntersectionObserver —
  // снимаем флаг, поставленный в <head>, и показываем всё сразу:
  // содержимое не должно зависеть от анимации.
  if (
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    typeof IntersectionObserver !== 'function'
  ) {
    root.classList.remove('js-reveal');
    root.dataset.revealReady = '1';
    return;
  }

  root.classList.add('js-reveal');
  root.dataset.revealReady = '1';
  targets.forEach((el) => el.classList.add('reveal'));

  // Шапка видна сразу — её текст запускаем без ожидания прокрутки.
  // Намеренно без requestAnimationFrame: в фоновой вкладке кадры не идут,
  // и анимация не стартовала бы до переключения на неё.
  const hero = document.querySelector('.hero');
  if (hero) playTextIn(hero);

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry, i) => {
        if (!entry.isIntersecting) return;
        reveal(entry.target, Math.min(i * 45, 180));
        io.unobserve(entry.target);
      });
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.05 }
  );
  targets.forEach((el) => io.observe(el));

  // Страховка: что бы ни случилось с наблюдателем, текст не останется скрытым.
  setTimeout(() => {
    targets
      .filter((el) => !el.classList.contains('is-in')
        && el.getBoundingClientRect().top < window.innerHeight)
      .forEach((el) => reveal(el));

    // Разблокируем только то, что уже на экране, — анимации ниже по странице
    // должны дождаться прокрутки.
    document
      .querySelectorAll('.t-stream:not(.is-shown), .t-stagger:not(.is-shown)')
      .forEach((el) => {
        if (el.getBoundingClientRect().top < window.innerHeight) playTextIn(el);
      });
  }, 2500);

  window.addEventListener('pagehide', revealAll);
  window.addEventListener('beforeprint', revealAll);
}

/* ------------------------------------------------------------------ *
 *  Старт
 * ------------------------------------------------------------------ */

fillDynamicValues();
initNavigation();
renderProjects();
initReveal();
prefetchViewer();

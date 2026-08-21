/* ═══════════════════════════════════════════════════════════════
   Статистика звонков из Сипуни.

   Сипуни отдаёт журнал звонков в виде CSV. Мы его забираем,
   разбираем и считаем по каждому менеджеру:
     — попыток дозвониться (исходящие)
     — дозвонов (те, где разговор состоялся)
     — время на линии (сумма длительности разговоров)

   Авторизация: номер кабинета + MD5-подпись с секретным ключом.
   ═══════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const CONFIG = require('./config');

const USER   = process.env.SIPUNI_USER   || '';
const SECRET = process.env.SIPUNI_SECRET || '';

const enabled = () => Boolean(USER && SECRET);

/* Порядок полей для подписи задан документацией Сипуни и менять его нельзя */
const HASH_ORDER = [
  'anonymous', 'crmLinks', 'dtmfUserAnswer', 'firstTime', 'from', 'fromNumber',
  'hangupinitor', 'ignoreSpecChar', 'names', 'numbersInvolved', 'numbersRinged',
  'outgoingLine', 'rating', 'showTreeId', 'state', 'timeFrom', 'timeTo', 'to',
  'toAnswer', 'toNumber', 'tree', 'type', 'user',
];

// YYYY-MM-DD → DD.MM.YYYY
const ru = d => d.split('-').reverse().join('.');

async function fetchCsv(from, to) {
  const p = {
    anonymous: '1', crmLinks: '0', dtmfUserAnswer: '0', firstTime: '0',
    from: ru(from), fromNumber: '', hangupinitor: '0', ignoreSpecChar: '1',
    names: '1', numbersInvolved: '1', numbersRinged: '0', outgoingLine: '0',
    rating: '', showTreeId: '0', state: '0', timeFrom: '', timeTo: '',
    to: ru(to), toAnswer: '', toNumber: '', tree: '', type: '0', user: USER,
  };
  const signature = HASH_ORDER.map(k => p[k]).concat(SECRET).join('+');
  p.hash = crypto.createHash('md5').update(signature).digest('hex');

  const res = await fetch('https://sipuni.com/api/statistic/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(p),
  });
  if (!res.ok) throw new Error(`Сипуни ответила ${res.status}`);
  return res.text();
}

/* ── Разбор CSV ────────────────────────────────────────────────
   Колонки ищем по названиям, а не по номерам: если Сипуни
   поменяет порядок или добавит поле, ничего не сломается. */
function parseCsv(text) {
  const clean = text.replace(/^\uFEFF/, '').trim();
  if (!clean) return { header: [], rows: [] };

  const lines = clean.split(/\r?\n/);
  const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const cut = l => l.split(sep).map(c => c.replace(/^"|"$/g, '').trim());

  const header = cut(lines[0]);
  /* Ищем сначала точное совпадение, потом по началу строки, и только
     потом по вхождению — иначе «Куда» найдётся внутри «Откуда». */
  const find = (...keys) => {
    const test = fn => header.findIndex(h => fn(h.toLowerCase().trim()));
    const all = low => keys.every(k => low.includes(k));
    const one = keys.join(' ');
    let i = test(low => low === one);
    if (i === -1) i = test(low => low.startsWith(keys[0]) && all(low));
    if (i === -1) i = test(all);
    return i;
  };

  const idx = {
    time:     find('время'),
    type:     find('тип'),
    status:   find('статус'),
    from:     find('откуда'),
    to:       find('куда'),
    answered: find('ответил'),
    talk:     find('длительность', 'разгов'),
  };
  if (idx.talk === -1) idx.talk = find('разгов');

  const rows = lines.slice(1).filter(Boolean).map(l => {
    const c = cut(l);
    const get = i => (i >= 0 && c[i] !== undefined ? c[i] : '');
    return {
      time: get(idx.time), at: moment(get(idx.time)),
      type: get(idx.type), status: get(idx.status),
      from: get(idx.from), to: get(idx.to),
      answered: get(idx.answered), talk: get(idx.talk),
    };
  });
  return { header, rows, idx };
}

/* «20.08.2026 14:05:12» или «2026-08-20 14:05» → отметка времени.
   Сипуни отдаёт местное время, поэтому подставляем смещение пояса. */
function moment(v) {
  const s = String(v || '').trim();
  if (!s) return 0;
  const off = CONFIG.TZ_OFFSET || '+00:00';
  let m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6] || '00'}${off}`) || 0;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${off}`) || 0;
  const n = Number(s);
  return Number.isFinite(n) && n > 1e9 ? n * 1000 : 0;   // на случай unix-времени
}

/* «0:01:23» или «83» → секунды */
function seconds(v) {
  if (!v) return 0;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const digits = v => String(v || '').replace(/\D/g, '');

/* ── Подсчёт по менеджерам ─────────────────────────────────── */
function aggregate(rows) {
  const byExt = {};
  for (const m of CONFIG.MANAGERS) {
    byExt[String(m.ext)] = { id: m.id, name: m.name, ext: m.ext, attempts: 0, connected: 0, talkSec: 0, incoming: 0 };
  }

  for (const r of rows) {
    const talk = seconds(r.talk);
    const isOut = r.type.toLowerCase().includes('исход');
    const src = digits(r.from);
    const ans = digits(r.answered) || digits(r.to);

    if (isOut && byExt[src]) {
      byExt[src].attempts++;
      if (talk > 0) byExt[src].connected++;
    }
    if (!isOut && byExt[ans] && talk > 0) byExt[ans].incoming++;

    const owner = byExt[src] || byExt[ans];
    if (owner && talk > 0) owner.talkSec += talk;
  }

  return CONFIG.MANAGERS.map(m => {
    const s = byExt[String(m.ext)];
    return { ...s, rate: s.attempts ? Math.round(s.connected / s.attempts * 100) : 0 };
  });
}

/* ── Кэш и очередь запросов ────────────────────────────────────
   Сипуни ограничивает частоту обращений и отвечает 429, если дёргать
   её часто. Поэтому: одна выгрузка на период (а не отдельно ради
   статистики и ради времени реакции), склейка одновременных запросов
   и мягкий повтор при отказе. */

const cache = new Map();      // период → { at, rows, stats }
const inflight = new Map();   // период → незавершённый запрос

const todayStr = () => new Date().toISOString().slice(0, 10);

/* Прошедшие дни уже не меняются — их держим намного дольше */
const ttlFor = to => (to < todayStr() ? 12 * 3600 * 1000 : (CONFIG.CALLS_REFRESH_SEC || 180) * 1000);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchCsvRetry(from, to, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      return await fetchCsv(from, to);
    } catch (e) {
      const busy = /429/.test(e.message);
      if (!busy || i === tries) throw e;
      await sleep(1500 * i);                 // 1.5 с, затем 3 с
    }
  }
}

async function load(from, to) {
  to = to || from;
  const key = from + '..' + to;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlFor(to)) return hit;
  if (inflight.has(key)) return inflight.get(key);      // уже спрашиваем — подождём тот же ответ

  const task = (async () => {
    try {
      const { rows } = parseCsv(await fetchCsvRetry(from, to));
      const entry = {
        at: Date.now(), rows,
        stats: {
          enabled: true, managers: aggregate(rows), total: rows.length,
          error: null, updatedAt: new Date().toISOString(),
        },
      };
      cache.set(key, entry);
      return entry;
    } catch (e) {
      console.error('Сипуни:', e.message);
      const stale = cache.get(key);
      if (stale) return stale;                           // лучше прошлые данные, чем пустой экран
      return { at: 0, rows: [], stats: { enabled: true, managers: [], error: e.message, updatedAt: null } };
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

/* ── Выгрузка кусками по неделе ────────────────────────────────
   Запрашивать месяц одним куском нельзя: на больших периодах Сипуни
   обрезает выгрузку, и часть звонков просто теряется. Берём отрезками
   не длиннее недели, каждый кэшируем отдельно — тогда листание дней
   внутри уже загруженной недели мгновенное, а данные полные. */

const DAY_MS = 86400000;
const dOf = s => Date.parse(s + 'T00:00:00Z');
const sOf = t => new Date(t).toISOString().slice(0, 10);

/* Куски строго по единой сетке недель. Это важно: тогда отдельный день
   попадает ровно в тот же кусок, что уже загружен при просмотре месяца,
   и переключение дней не идёт в сеть вовсе. */
const WEEK = 7 * DAY_MS;
const weekStart = t => Math.floor(t / WEEK) * WEEK;

function chunks(from, to) {
  const out = [];
  let a = weekStart(dOf(from));
  const end = dOf(to);
  while (a <= end && out.length < 60) {
    out.push([sOf(a), sOf(a + 6 * DAY_MS)]);
    a += WEEK;
  }
  return out;
}

/* Отбираем строки нужного отрезка по времени звонка */
function slice(list, from, to) {
  const off = CONFIG.TZ_OFFSET || '+00:00';
  const start = Date.parse(from + 'T00:00:00' + off);
  const end   = Date.parse(to   + 'T23:59:59' + off);
  return list.filter(r => r.at ? (r.at >= start && r.at <= end) : true);
}

async function collect(from, to) {
  to = to || from;
  const parts = chunks(from, to);
  const all = [];
  let partial = false;

  for (const [a, b] of parts) {
    const entry = await load(a, b);
    if (entry.stats && entry.stats.error) partial = true;   // кусок не доехал
    all.push(...entry.rows);
  }
  const rows = all.some(r => r.at) ? slice(all, from, to) : all;
  return { rows, partial, parts: parts.length };
}

async function rows(from, to) {
  if (!enabled()) return [];
  return (await collect(from, to)).rows;
}

async function stats(from, to) {
  if (!enabled()) return { enabled: false, managers: [], error: null, updatedAt: null };
  const { rows: list, partial, parts } = await collect(from, to);
  return {
    enabled: true,
    managers: aggregate(list),
    total: list.length,
    partial,                       // часть выгрузки не получена — цифры занижены
    parts,
    error: partial ? 'Сипуни отдала не все данные за период' : null,
    updatedAt: new Date().toISOString(),
  };
}

/* Первые строки CSV — чтобы сверить разбор колонок, если цифры разойдутся */
async function raw(date) {
  if (!enabled()) return 'Не заданы SIPUNI_USER и SIPUNI_SECRET';
  const csv = await fetchCsv(date, date);
  const { header, idx } = parseCsv(csv);
  return [
    'Найденные колонки: ' + JSON.stringify(idx),
    'Заголовок: ' + header.join(' | '),
    '',
    ...csv.split(/\r?\n/).slice(0, 15),
  ].join('\n');
}

module.exports = { stats, raw, rows, enabled, parseCsv, seconds, aggregate, moment };

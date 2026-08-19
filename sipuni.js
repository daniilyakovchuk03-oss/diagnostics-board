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
      type: get(idx.type), status: get(idx.status),
      from: get(idx.from), to: get(idx.to),
      answered: get(idx.answered), talk: get(idx.talk),
    };
  });
  return { header, rows, idx };
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

/* ── Кэш по датам ──────────────────────────────────────────── */
const cache = new Map();   // date → { data, at }

async function stats(from, to) {
  if (!enabled()) return { enabled: false, managers: [], error: null, updatedAt: null };
  to = to || from;

  const ttl = (CONFIG.CALLS_REFRESH_SEC || 180) * 1000;
  const key = from + '..' + to;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;

  try {
    const csv = await fetchCsv(from, to);
    const { rows } = parseCsv(csv);
    const data = {
      enabled: true,
      managers: aggregate(rows),
      total: rows.length,
      error: null,
      updatedAt: new Date().toISOString(),
    };
    cache.set(key, { data, at: Date.now() });
    return data;
  } catch (e) {
    const data = { enabled: true, managers: [], error: e.message, updatedAt: null };
    cache.set(key, { data, at: Date.now() });
    return data;
  }
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

module.exports = { stats, raw, enabled, parseCsv, seconds, aggregate };    const test = fn => header.findIndex(h => fn(h.toLowerCase().trim()));
    const all = low => keys.every(k => low.includes(k));
    const one = keys.join(' ');
    let i = test(low => low === one);
    if (i === -1) i = test(low => low.startsWith(keys[0]) && all(low));
    if (i === -1) i = test(all);
    return i;
  };

  const idx = {
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
      type: get(idx.type), status: get(idx.status),
      from: get(idx.from), to: get(idx.to),
      answered: get(idx.answered), talk: get(idx.talk),
    };
  });
  return { header, rows, idx };
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

/* ── Кэш по датам ──────────────────────────────────────────── */
const cache = new Map();   // date → { data, at }

async function stats(from, to) {
  if (!enabled()) return { enabled: false, managers: [], error: null, updatedAt: null };
  to = to || from;

  const ttl = (CONFIG.CALLS_REFRESH_SEC || 180) * 1000;
  const key = from + '..' + to;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;

  try {
    const csv = await fetchCsv(from, to);
    const { rows } = parseCsv(csv);
    const data = {
      enabled: true,
      managers: aggregate(rows),
      total: rows.length,
      error: null,
      updatedAt: new Date().toISOString(),
    };
    cache.set(key, { data, at: Date.now() });
    return data;
  } catch (e) {
    const data = { enabled: true, managers: [], error: e.message, updatedAt: null };
    cache.set(key, { data, at: Date.now() });
    return data;
  }
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

module.exports = { stats, raw, enabled, parseCsv, seconds, aggregate };    const test = fn => header.findIndex(h => fn(h.toLowerCase().trim()));
    const all = low => keys.every(k => low.includes(k));
    const one = keys.join(' ');
    let i = test(low => low === one);
    if (i === -1) i = test(low => low.startsWith(keys[0]) && all(low));
    if (i === -1) i = test(all);
    return i;
  };

  const idx = {
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
      type: get(idx.type), status: get(idx.status),
      from: get(idx.from), to: get(idx.to),
      answered: get(idx.answered), talk: get(idx.talk),
    };
  });
  return { header, rows, idx };
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

/* ── Кэш по датам ──────────────────────────────────────────── */
const cache = new Map();   // date → { data, at }

async function stats(date) {
  if (!enabled()) return { enabled: false, managers: [], error: null, updatedAt: null };

  const ttl = (CONFIG.CALLS_REFRESH_SEC || 180) * 1000;
  const hit = cache.get(date);
  if (hit && Date.now() - hit.at < ttl) return hit.data;

  try {
    const csv = await fetchCsv(date);
    const { rows } = parseCsv(csv);
    const data = {
      enabled: true,
      managers: aggregate(rows),
      total: rows.length,
      error: null,
      updatedAt: new Date().toISOString(),
    };
    cache.set(date, { data, at: Date.now() });
    return data;
  } catch (e) {
    const data = { enabled: true, managers: [], error: e.message, updatedAt: null };
    cache.set(date, { data, at: Date.now() });
    return data;
  }
}

/* Первые строки CSV — чтобы сверить разбор колонок, если цифры разойдутся */
async function raw(date) {
  if (!enabled()) return 'Не заданы SIPUNI_USER и SIPUNI_SECRET';
  const csv = await fetchCsv(date);
  const { header, idx } = parseCsv(csv);
  return [
    'Найденные колонки: ' + JSON.stringify(idx),
    'Заголовок: ' + header.join(' | '),
    '',
    ...csv.split(/\r?\n/).slice(0, 15),
  ].join('\n');
}

module.exports = { stats, raw, enabled, parseCsv, seconds, aggregate };

/* ═══════════════════════════════════════════════════════════════
   Доска диагностик — сервер-посредник между amoCRM и доской.

   Что делает:
   1. Раз в минуту забирает сделки из амо и держит их в памяти.
   2. Принимает вебхуки от амо и обновляется мгновенно.
   3. Отдаёт доске готовый список встреч на нужный день.

   База данных не нужна: источник правды — всегда амо.
   Перезапустился — просто загрузил заново.
   ═══════════════════════════════════════════════════════════════ */

const http = require('http');
const crypto = require('crypto');
const fs   = require('fs');
const path = require('path');
const CONFIG = require('./config');
const sipuni = require('./sipuni');

/* ── Вход и права ───────────────────────────────────────────────
   Пароли берём из переменных окружения. Сессия — подписанная кука:
   подделать её без секрета нельзя, база для этого не нужна. */
const SESSION_SECRET = process.env.SESSION_SECRET
  || crypto.createHash('sha256').update(String(process.env.AMO_TOKEN || 'neadpulse')).digest('hex');

const sign = v => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex').slice(0, 32);

/* Сравнение без утечки времени: обычное === выдаёт длину общего префикса */
function sameSecret(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function checkLogin(login, password) {
  const u = (CONFIG.USERS || []).find(u => u.login === String(login || '').trim().toLowerCase());
  if (!u) return null;
  const expected = process.env[u.passwordEnv];
  if (!expected) {
    console.error(`Не задан пароль в переменной ${u.passwordEnv} — вход для «${u.login}» невозможен`);
    return null;
  }
  return sameSecret(password, expected) ? u : null;
}

function makeCookie(login) {
  const until = Date.now() + (CONFIG.SESSION_DAYS || 30) * 86400000;
  const body = `${login}.${until}`;
  const age = Math.round((CONFIG.SESSION_DAYS || 30) * 86400);
  return `np_session=${body}.${sign(body)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}`;
}

function currentUser(req) {
  const raw = (req.headers.cookie || '').split(';')
    .map(c => c.trim()).find(c => c.startsWith('np_session='));
  if (!raw) return null;
  const [login, until, mac] = raw.slice('np_session='.length).split('.');
  if (!login || !until || !mac) return null;
  if (sign(`${login}.${until}`) !== mac) return null;      // подпись не сходится
  if (Number(until) < Date.now()) return null;             // срок вышел
  return (CONFIG.USERS || []).find(u => u.login === login) || null;
}

const isAdmin = u => u && u.role === 'admin';

/* Менеджер видит только свои данные — режем на сервере, а не в интерфейсе */
const mineOnly = (list, user, key = 'm') =>
  isAdmin(user) ? list : list.filter(x => x[key] === user.managerId);

/* ── Общее хранилище таблицы эффективности ──────────────────────
   Цифры, которые руководитель вбивает руками. Держим в памяти и
   пишем в файл, чтобы переживать перезапуск сервиса.
   На Railway файловая система обнуляется при новом деплое — чтобы
   данные жили дольше, подключите Volume и укажите DATA_DIR. */
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
let store = {};

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  console.log(`Хранилище: ${Object.keys(store).length} записей в ${DATA_FILE}`);
} catch (e) {
  console.error('Хранилище недоступно:', e.message);
}

/* Пишем сразу: данных мало, а терять введённые вручную цифры нельзя.
   Сначала во временный файл, потом переименование — так файл не побьётся,
   если сервис остановят в момент записи. */
function saveStore() {
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('Не удалось записать хранилище:', e.message);
  }
}

/* Читаем тело запроса целиком, с ограничением размера */
function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > limit) { reject(new Error('Слишком большой запрос')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const BUILD = '2026-08-21.3';   // меняется с каждой правкой — видно в /health

const DOMAIN = (process.env.AMO_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const TOKEN  = process.env.AMO_TOKEN || '';
const PORT   = process.env.PORT || 3000;

if (!DOMAIN || !TOKEN) {
  console.warn('⚠  Не заданы переменные AMO_DOMAIN и AMO_TOKEN — данные из амо приходить не будут.');
}

/* ── Запрос к API амо ──────────────────────────────────────── */
async function amo(url) {
  const res = await fetch(`https://${DOMAIN}${url}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (res.status === 204) return null;                 // амо так отвечает на пустой список
  if (res.status === 401) throw new Error('Амо не приняла токен (401). Проверьте AMO_TOKEN.');
  if (!res.ok) throw new Error(`Амо ответила ${res.status} на ${url}`);
  return res.json();
}

/* ── Разбор сделки ─────────────────────────────────────────── */
function field(lead, id) {
  if (!id) return undefined;
  const f = (lead.custom_fields_values || []).find(f => Number(f.field_id) === Number(id));
  return f && f.values && f.values[0] ? f.values[0].value : undefined;
}

// Переводим unix-время из амо в местные дату и время.
// Возвращаем null на пустом или битом значении — раньше это роняло всю выгрузку.
function local(ts) {
  const n = Number(ts);
  if (!n || !Number.isFinite(n)) return null;
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: CONFIG.TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(n * 1000));
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}

function columnOf(lead) {
  if (CONFIG.TEACHER_FIELD_ID) {
    const t = String(field(lead, CONFIG.TEACHER_FIELD_ID) || '').trim().toLowerCase();
    const m = CONFIG.MANAGERS.find(m => String(m.teacher || '').toLowerCase() === t);
    if (m) return m.id;
  }
  const m = CONFIG.MANAGERS.find(m => Number(m.amo_user_id) === Number(lead.responsible_user_id));
  return m ? m.id : null;
}

function toAppointment(lead) {
  const raw = field(lead, CONFIG.DATE_FIELD_ID);
  if (!raw) return null;                                // дата диагностики не заполнена
  const ts = Number(raw);
  if (!ts) return null;

  const when = local(ts);
  if (!when) return null;                               // битая дата диагностики
  const col  = columnOf(lead);
  if (!col) return null;                                // ответственный не из нашего отдела

  return {
    id: lead.id,
    date: when.date,
    t: when.time,
    m: col,
    c: field(lead, CONFIG.NAME_FIELD_ID) || lead.name || 'Без имени',
    st: statusOf(lead),
    mk: '',
    note: '',
  };
}

/* ── Порядок этапов в воронке ──────────────────────────────────
   Всё, что стоит в воронке ПОЗЖЕ этапа «Записан на диагностику»,
   считается состоявшейся встречей. Исключения — в STATUS_OVERRIDE.
   Так новые этапы подхватятся сами, без правки конфига. */
let stageOrder = {};   // { status_id: позиция }

async function loadStages() {
  if (!CONFIG.PIPELINE_ID) return;
  try {
    const p = await amo(`/api/v4/leads/pipelines/${CONFIG.PIPELINE_ID}`);
    const list = (p && p._embedded && p._embedded.statuses) || [];
    stageOrder = {};
    for (const s of list) stageOrder[s.id] = s.sort;
    console.log(`Этапы воронки загружены: ${list.length}`);
  } catch (e) {
    console.error('Не удалось загрузить этапы воронки:', e.message);
  }
}

function statusOf(lead) {
  const id = lead.status_id;
  const override = CONFIG.STATUS_OVERRIDE[id];
  if (override) return override;                       // явное правило важнее порядка

  const anchor = stageOrder[CONFIG.ANCHOR_STATUS_ID];
  const here   = stageOrder[id];
  if (anchor === undefined || here === undefined) return 'wait';
  return here > anchor ? 'came' : 'wait';
}

/* Источник лида по тегам: есть слово «звонобот» — значит бот,
   всё остальное считаем таргетом и прочими каналами. */
function sourceOf(lead) {
  const tags = (lead._embedded && lead._embedded.tags) || [];
  const bot = tags.some(t => String(t.name || '').toLowerCase().includes('звонобот'));
  return bot ? 'bot' : 'target';
}

/* Лид для воронки: считаем по дате создания сделки, а не встречи */
function toLead(lead, phones) {
  const created = local(lead.created_at);
  if (!created) return null;                            // сделка без даты создания
  const raw = field(lead, CONFIG.DATE_FIELD_ID);
  const st = statusOf(lead);
  return {
    id: lead.id,
    created: created.date,
    // Назначенной считаем только сделку с РАЗБОРЧИВОЙ датой — так воронка
    // и доска диагностик показывают одни и те же сделки
    assigned: Boolean(local(raw)),
    st,
    m: columnOf(lead),
    src: sourceOf(lead),
    won: Number(lead.status_id) === Number(CONFIG.WON_STATUS_ID),
    createdTs: Number(lead.created_at) * 1000,          // для расчёта времени реакции
    phones: (phones && phones.get(lead.id)) || [],
  };
}

/* Телефон в сравнимый вид: только последние 10 цифр.
   +7 701 224 18 90, 8 701 224 18 90 и 7012241890 — это один номер. */
const normPhone = v => String(v || '').replace(/\D/g, '').slice(-10);

/* Телефоны сделок: амо отдаёт у сделки только ID контактов,
   поэтому догружаем контакты пачками и собираем номера. */
async function loadPhones(leads) {
  const ids = [...new Set(leads.flatMap(l =>
    ((l._embedded && l._embedded.contacts) || []).map(c => c.id)))];
  const byContact = new Map();

  for (let i = 0; i < ids.length; i += 250) {
    const chunk = ids.slice(i, i + 250);
    const q = new URLSearchParams({ limit: '250' });
    chunk.forEach(id => q.append('filter[id][]', String(id)));
    try {
      const data = await amo('/api/v4/contacts?' + q);
      for (const c of (data?._embedded?.contacts || [])) {
        const phones = (c.custom_fields_values || [])
          .filter(f => f.field_code === 'PHONE')
          .flatMap(f => (f.values || []).map(v => normPhone(v.value)))
          .filter(Boolean);
        if (phones.length) byContact.set(c.id, phones);
      }
    } catch (e) {
      console.error('Не удалось получить контакты:', e.message);
      break;
    }
  }

  const byLead = new Map();
  for (const l of leads) {
    const phones = ((l._embedded && l._embedded.contacts) || [])
      .flatMap(c => byContact.get(c.id) || []);
    if (phones.length) byLead.set(l.id, [...new Set(phones)]);
  }
  return byLead;
}

/* ── Кэш в памяти ──────────────────────────────────────────── */
let cache = { items: [], leads: [], updatedAt: null, error: null };

async function refresh() {
  if (!DOMAIN || !TOKEN) return;
  try {
    const leads = [];
    for (let page = 1; page <= 20; page++) {
      const q = new URLSearchParams({ limit: '250', page: String(page), with: 'contacts' });
      if (CONFIG.PIPELINE_ID) q.set('filter[pipeline_id]', String(CONFIG.PIPELINE_ID));
      const data = await amo('/api/v4/leads?' + q);
      const batch = (data && data._embedded && data._embedded.leads) || [];
      leads.push(...batch);
      if (batch.length < 250) break;
    }
    const phones = await loadPhones(leads);
    cache = {
      items: leads.map(toAppointment).filter(Boolean),
      leads: leads.map(l => toLead(l, phones)).filter(Boolean),
      updatedAt: new Date().toISOString(),
      error: null,
    };
    console.log(`Обновлено: сделок ${leads.length}, встреч на доске ${cache.items.length}`);
  } catch (e) {
    cache.error = e.message;
    console.error('Ошибка обновления:', e.message);
  }
}

let pending = null;
function refreshSoon() {                                 // вебхуки идут пачками — ждём 2 сек
  clearTimeout(pending);
  pending = setTimeout(refresh, 2000);
}

/* Сколько РАБОЧЕГО времени прошло между двумя моментами.
   Ночь и время после закрытия отдела не считаются: лид, упавший в 23:40,
   начинает «тикать» с 10:00 следующего дня. */
const DAY = 86400000;
function workSeconds(startTs, endTs) {
  if (!(endTs > startTs)) return 0;

  const offset = (() => {                       // '+05:00' → миллисекунды
    const m = String(CONFIG.TZ_OFFSET || '+00:00').match(/([+-])(\d{2}):(\d{2})/);
    if (!m) return 0;
    return (m[1] === '-' ? -1 : 1) * ((+m[2]) * 3600 + (+m[3]) * 60) * 1000;
  })();

  const from = CONFIG.WORK_FROM * 3600000;
  const to   = CONFIG.WORK_TO   * 3600000;
  if (!(to > from)) return Math.round((endTs - startTs) / 1000);

  // переводим в местное время, чтобы сутки резались по местной полуночи
  let a = startTs + offset, b = endTs + offset, total = 0;
  const firstDay = Math.floor(a / DAY), lastDay = Math.floor(b / DAY);
  if (lastDay - firstDay > 90) return Math.round((endTs - startTs) / 1000);  // защита от бесконечного цикла

  for (let d = firstDay; d <= lastDay; d++) {
    const open = d * DAY + from, close = d * DAY + to;
    const s = Math.max(a, open), e = Math.min(b, close);
    if (e > s) total += e - s;
  }
  return Math.round(total / 1000);
}

/* ── Время реакции: сколько прошло от создания сделки до первого
   исходящего звонка менеджера на телефон этого клиента ────────── */
async function responseTimes(from, to) {
  const out = {};
  for (const m of CONFIG.MANAGERS) out[m.id] = { deltas: [], noCall: 0, leads: 0 };

  const calls = await sipuni.rows(from, to);
  if (!calls.length) return finishResponse(out);

  // Раскладываем звонки: внутренний номер → телефон клиента → отметки времени
  const byExt = new Map();
  for (const c of calls) {
    if (!c.at || !String(c.type).toLowerCase().includes('исход')) continue;
    const ext = String(c.from || '').replace(/\D/g, '');
    const client = normPhone(c.to);
    if (!ext || !client) continue;
    if (!byExt.has(ext)) byExt.set(ext, new Map());
    const map = byExt.get(ext);
    if (!map.has(client)) map.set(client, []);
    map.get(client).push(c.at);
  }

  /* Берём и лиды, созданные накануне: заявка упала ночью, звонок был утром —
     такую пару обязательно нужно учесть, иначе ночные лиды выпадают. */
  const earliest = from ? new Date(from + 'T00:00:00Z').getTime() - DAY : 0;

  for (const lead of (cache.leads || [])) {
    if (!lead.m || !lead.createdTs) continue;
    if (earliest && lead.createdTs < earliest) continue;
    if (to && lead.created > to) continue;
    if (!lead.phones.length) { out[lead.m].noPhone = (out[lead.m].noPhone || 0) + 1; continue; }

    const man = CONFIG.MANAGERS.find(x => x.id === lead.m);
    const map = man && byExt.get(String(man.ext));
    if (!map) { out[lead.m].leads++; out[lead.m].noCall++; continue; }

    // первый звонок этому клиенту после создания сделки
    let first = null;
    for (const phone of lead.phones) {
      for (const at of (map.get(phone) || [])) {
        if (at >= lead.createdTs && (first === null || at < first)) first = at;
      }
    }
    out[lead.m].leads++;
    if (first !== null) out[lead.m].deltas.push(workSeconds(lead.createdTs, first));
    else out[lead.m].noCall++;                 // новый лид, а звонка ему так и не было
  }
  return finishResponse(out);
}

function finishResponse(out) {
  const res = {};
  for (const [id, v] of Object.entries(out)) {
    const n = v.deltas.length;
    res[id] = {
      avgResp: n ? Math.round(v.deltas.reduce((a, b) => a + b, 0) / n) : null,
      medResp: n ? Math.round(v.deltas.slice().sort((a, b) => a - b)[Math.floor(n / 2)]) : null,
      matched: n,
      noCall: v.noCall || 0,
      newLeads: v.leads || 0,
      noPhone: v.noPhone || 0,
    };
  }
  return res;
}

/* ── Страница /setup ───────────────────────────────────────── */
async function setupPage() {
  const esc = s => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  let html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Настройка доски</title><style>
    body{font-family:system-ui,sans-serif;background:#141A18;color:#E7EEEA;padding:24px;line-height:1.5}
    h1{font-size:20px} h2{font-size:15px;margin-top:32px;text-transform:uppercase;letter-spacing:.1em;color:#8C9A94}
    table{border-collapse:collapse;width:100%;max-width:820px;margin-top:8px}
    td,th{border-bottom:1px solid #2F3936;padding:7px 10px;text-align:left;font-size:14px;vertical-align:top}
    th{color:#8C9A94;font-weight:500;font-size:12px;text-transform:uppercase}
    code{font-family:ui-monospace,monospace;color:#7099FF}
    .hint{background:#1C2321;border:1px solid #2F3936;border-radius:10px;padding:14px 16px;max-width:820px}
    .err{border-color:#EF6A5E;color:#EF6A5E}
    </style></head><body>
    <h1>Настройка доски диагностик</h1>
    <div class="hint">Ниже — всё, что нужно, чтобы заполнить <code>config.js</code>.
    Сделайте скриншот этой страницы целиком и пришлите — соберём конфиг.</div>`;

  if (!DOMAIN || !TOKEN) {
    return html + `<div class="hint err" style="margin-top:16px">Не заданы переменные окружения
      <code>AMO_DOMAIN</code> и <code>AMO_TOKEN</code>. Добавьте их в Railway → Variables и перезапустите сервис.</div></body></html>`;
  }

  try {
    const [fields, pipes, users] = await Promise.all([
      amo('/api/v4/leads/custom_fields?limit=250'),
      amo('/api/v4/leads/pipelines'),
      amo('/api/v4/users?limit=250'),
    ]);

    html += `<h2>Поля сделки</h2><table><tr><th>ID поля</th><th>Название</th><th>Тип</th></tr>`;
    for (const f of (fields?._embedded?.custom_fields || []))
      html += `<tr><td><code>${f.id}</code></td><td>${esc(f.name)}</td><td>${esc(f.type)}</td></tr>`;
    html += `</table>`;

    html += `<h2>Воронки и этапы</h2>`;
    for (const p of (pipes?._embedded?.pipelines || [])) {
      html += `<h3 style="font-size:15px;margin:20px 0 0">${esc(p.name)} — ID воронки <code>${p.id}</code></h3>
        <table><tr><th>ID этапа</th><th>Название этапа</th></tr>`;
      for (const s of (p._embedded?.statuses || []))
        html += `<tr><td><code>${s.id}</code></td><td>${esc(s.name)}</td></tr>`;
      html += `</table>`;
    }

    html += `<h2>Сотрудники</h2><table><tr><th>ID</th><th>Имя</th><th>Почта</th></tr>`;
    for (const u of (users?._embedded?.users || []))
      html += `<tr><td><code>${u.id}</code></td><td>${esc(u.name)}</td><td>${esc(u.email || '')}</td></tr>`;
    html += `</table>`;

  } catch (e) {
    html += `<div class="hint err" style="margin-top:16px">Не удалось получить данные: ${esc(e.message)}</div>`;
  }
  return html + `</body></html>`;
}

/* ── Веб-сервер ────────────────────────────────────────────── */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, type, body) => {
    if (res.writableEnded) return;
    res.writeHead(code, { 'Content-Type': type });
    res.end(body);
  };
  const json = (code, obj) => send(code, 'application/json; charset=utf-8', JSON.stringify(obj));

  try {
  // ── Вход, выход, кто я
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    const u = checkLogin(body.login, body.password);
    if (!u) return json(401, { error: 'Неверный логин или пароль' });
    res.setHeader('Set-Cookie', makeCookie(u.login));
    return json(200, { login: u.login, name: u.name, role: u.role });
  }
  if (url.pathname === '/api/logout') {
    res.setHeader('Set-Cookie', 'np_session=; Path=/; HttpOnly; Max-Age=0');
    return json(200, { ok: true });
  }

  const user = currentUser(req);

  if (url.pathname === '/api/me') {
    if (!user) return json(401, { error: 'Не выполнен вход' });
    return json(200, { login: user.login, name: user.name, role: user.role, managerId: user.managerId || null });
  }

  // Всё остальное — только после входа
  const open = url.pathname === '/login.html' || url.pathname === '/amo/hook';
  if (!user && !open) {
    if (url.pathname.startsWith('/api/') || url.pathname === '/setup' || url.pathname === '/sipuni/raw')
      return json(401, { error: 'Не выполнен вход' });
    res.writeHead(302, { Location: '/login.html' });
    return res.end();
  }

  // Вебхук из амо: отвечаем сразу, разбираемся потом
  if (url.pathname === '/amo/hook') {
    res.writeHead(200); res.end('ok');
    req.on('data', () => {});
    console.log('Вебхук от амо получен');
    refreshSoon();
    return;
  }

  if (url.pathname === '/api/config') {
    return json(200, {
      managers: mineOnly(CONFIG.MANAGERS.map(m => ({ id: m.id, name: m.name })), user, 'id'),
      // Полный состав отдела: нужен там, где цифры общие (продажи, воронка)
      allManagers: CONFIG.MANAGERS.map(m => ({ id: m.id, name: m.name })),
      me: { name: user.name, role: user.role, managerId: user.managerId || null },
      // Нормативы показываем только руководителю
      norms: isAdmin(user) ? CONFIG.NORMS : null,
      mkEnabled: CONFIG.MK_ENABLED,
      configured: Boolean(CONFIG.DATE_FIELD_ID),
      callsEnabled: sipuni.enabled(),
      amoDomain: DOMAIN,
      work: [CONFIG.WORK_FROM, CONFIG.WORK_TO],
    });
  }

  // Статистика звонков из Сипуни + время реакции на новый лид
  if (url.pathname === '/api/calls') {
    const today = new Date().toISOString().slice(0, 10);
    const from = url.searchParams.get('from') || url.searchParams.get('date') || today;
    const to   = url.searchParams.get('to')   || from;
    const data = await sipuni.stats(from, to);
    if (data.enabled) {
      const resp = await responseTimes(from, to);
      data.managers = data.managers.map(m => ({
        ...m, ...(resp[m.id] || { avgResp: null, medResp: null, matched: 0, noCall: 0, newLeads: 0 }) }));
    }
    return json(200, { ...data, managers: mineOnly(data.managers || [], user, 'id') });
  }

  // Сырой CSV — на случай, если цифры разойдутся с кабинетом Сипуни
  if (url.pathname === '/sipuni/raw') {
    if (!isAdmin(user)) return send(403, 'text/plain; charset=utf-8', 'Только для руководителя');
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    try { return send(200, 'text/plain; charset=utf-8', await sipuni.raw(date)); }
    catch (e) { return send(500, 'text/plain; charset=utf-8', 'Ошибка: ' + e.message); }
  }

  if (url.pathname === '/api/appointments') {
    const from = url.searchParams.get('from') || url.searchParams.get('date');
    const to   = url.searchParams.get('to')   || from;
    return json(200, {
      updatedAt: cache.updatedAt,
      error: cache.error,
      // Даты в формате YYYY-MM-DD сравниваются как строки корректно
      items: mineOnly((cache.items || []).filter(x => !from || (x.date >= from && x.date <= to)), user),
    });
  }

  // Воронка по лидам: пришло → назначено → дошло
  if (url.pathname === '/api/funnel') {
    const from = url.searchParams.get('from');
    const to   = url.searchParams.get('to') || from;
    const src  = url.searchParams.get('src');   // bot | target | пусто = все
    const list = (cache.leads || []).filter(l =>
      (!from || (l.created >= from && l.created <= to)) &&
      (!src || l.src === src));

    /* Считаем «дошло» и «не дошло» ТОЛЬКО среди назначенных, иначе
       воронка перестаёт быть воронкой: сделка может уехать дальше по
       этапам без заполненной даты диагностики и дать больше 100%.
       Такие случаи выносим отдельно — это вопрос дисциплины в амо. */
    const count = arr => {
      const assigned = arr.filter(l => l.assigned);
      return {
        leads:    arr.length,
        assigned: assigned.length,
        came:     assigned.filter(l => l.st === 'came').length,
        no:       assigned.filter(l => l.st === 'no').length,
        noDate:   arr.filter(l => !l.assigned && l.st === 'came').length,
        won:      arr.filter(l => l.won).length,
      };
    };

    /* Воронка общая для всех: сколько лидов пришло на отдел и как они
       распределились. Это командные цифры, менеджеру полезно их видеть. */
    return json(200, {
      updatedAt: cache.updatedAt,
      error: cache.error,
      total: count(list),
      byManager: CONFIG.MANAGERS.map(m => ({
        id: m.id, name: m.name, ...count(list.filter(l => l.m === m.id)),
      })),
      other: count(list.filter(l => !l.m)),
    });
  }

  // ── Хранилище таблицы эффективности
  if (url.pathname === '/api/store') {
    const key = url.searchParams.get('key');
    if (req.method === 'GET') {
      if (!key) return json(400, { error: 'Не указан ключ' });
      return json(200, { key, value: store[key] ?? null });
    }
    if (req.method === 'POST') {
      if (!isAdmin(user)) return json(403, { error: 'Только для руководителя' });
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.key) return json(400, { error: 'Не указан ключ' });
      store[body.key] = String(body.value ?? '');
      saveStore();
      return json(200, { key: body.key, ok: true });
    }
    if (req.method === 'DELETE') {
      if (!isAdmin(user)) return json(403, { error: 'Только для руководителя' });
      if (key) { delete store[key]; saveStore(); }
      return json(200, { key, deleted: true });
    }
  }

  if (url.pathname === '/api/store/list') {
    const prefix = url.searchParams.get('prefix') || '';
    return json(200, { keys: Object.keys(store).filter(k => k.startsWith(prefix)) });
  }

  if (url.pathname === '/setup') {
    if (!isAdmin(user)) return send(403, 'text/plain; charset=utf-8', 'Только для руководителя');
    return send(200, MIME['.html'], await setupPage());
  }

  if (url.pathname === '/health') return json(200, {
    ok: true, build: BUILD,
    items: (cache.items || []).length,
    leads: (cache.leads || []).length,
    stages: Object.keys(stageOrder).length,
    updatedAt: cache.updatedAt, error: cache.error,
  });

  // Статика доски
  const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  const full = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(full, (err, data) => {
    if (err) return send(404, 'text/plain; charset=utf-8', 'Не найдено');
    send(200, MIME[path.extname(full)] || 'application/octet-stream', data);
  });

  } catch (e) {
    // Без этого любая ошибка оставляла запрос висеть, и доска грузилась вечно
    console.error('Ошибка в обработчике', url.pathname, '→', e.stack || e.message);
    json(500, { error: e.message, where: url.pathname });
  }
});

/* Заранее тянем звонки за сегодня, чтобы первое открытие вкладки
   не ждало ответа Сипуни */
function warmCalls() {
  if (!sipuni.enabled()) return;
  const today = new Date().toISOString().slice(0, 10);
  sipuni.stats(today, today).catch(() => {});
}

server.listen(PORT, async () => {
  console.log(`Доска запущена на порту ${PORT}`);
  await loadStages();
  refresh();
  setTimeout(warmCalls, 3000);
  setInterval(refresh, Math.max(20, CONFIG.REFRESH_SEC) * 1000);
});

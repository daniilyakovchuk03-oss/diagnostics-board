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
const fs   = require('fs');
const path = require('path');
const CONFIG = require('./config');
const sipuni = require('./sipuni');

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

// Переводим unix-время из амо в местные дату и время
function local(ts) {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: CONFIG.TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ts * 1000));
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

/* ── Кэш в памяти ──────────────────────────────────────────── */
let cache = { items: [], updatedAt: null, error: null };

async function refresh() {
  if (!DOMAIN || !TOKEN) return;
  try {
    const leads = [];
    for (let page = 1; page <= 20; page++) {
      const q = new URLSearchParams({ limit: '250', page: String(page) });
      if (CONFIG.PIPELINE_ID) q.set('filter[pipeline_id]', String(CONFIG.PIPELINE_ID));
      const data = await amo('/api/v4/leads?' + q);
      const batch = (data && data._embedded && data._embedded.leads) || [];
      leads.push(...batch);
      if (batch.length < 250) break;
    }
    cache = {
      items: leads.map(toAppointment).filter(Boolean),
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
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
  const json = (code, obj) => send(code, 'application/json; charset=utf-8', JSON.stringify(obj));

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
      managers: CONFIG.MANAGERS.map(m => ({ id: m.id, name: m.name })),
      mkEnabled: CONFIG.MK_ENABLED,
      configured: Boolean(CONFIG.DATE_FIELD_ID),
      callsEnabled: sipuni.enabled(),
    });
  }

  // Статистика звонков из Сипуни
  if (url.pathname === '/api/calls') {
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    return json(200, await sipuni.stats(date));
  }

  // Сырой CSV — на случай, если цифры разойдутся с кабинетом Сипуни
  if (url.pathname === '/sipuni/raw') {
    const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    try { return send(200, 'text/plain; charset=utf-8', await sipuni.raw(date)); }
    catch (e) { return send(500, 'text/plain; charset=utf-8', 'Ошибка: ' + e.message); }
  }

  if (url.pathname === '/api/appointments') {
    const date = url.searchParams.get('date');
    return json(200, {
      updatedAt: cache.updatedAt,
      error: cache.error,
      items: cache.items.filter(x => !date || x.date === date),
    });
  }

  if (url.pathname === '/setup') return send(200, MIME['.html'], await setupPage());

  if (url.pathname === '/health') return json(200, { ok: true, items: cache.items.length, updatedAt: cache.updatedAt });

  // Статика доски
  const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  const full = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(full, (err, data) => {
    if (err) return send(404, 'text/plain; charset=utf-8', 'Не найдено');
    send(200, MIME[path.extname(full)] || 'application/octet-stream', data);
  });
});

server.listen(PORT, async () => {
  console.log(`Доска запущена на порту ${PORT}`);
  await loadStages();
  refresh();
  setInterval(refresh, Math.max(20, CONFIG.REFRESH_SEC) * 1000);
});

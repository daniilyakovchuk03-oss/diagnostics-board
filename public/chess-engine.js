
/* ═══════════════════════════════════════════════════════════════
   Шахматный движок. Отдельным файлом, чтобы правила можно было
   проверить отдельно от интерфейса.

   Доска — массив из 64 клеток, индекс 0 = a8, 63 = h1.
   Белые фигуры заглавными (PNBRQK), чёрные строчными.
   ═══════════════════════════════════════════════════════════════ */

const START = 'rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR'.split('');

const WHITE = 'w', BLACK = 'b';
const isWhite = p => p !== '.' && p === p.toUpperCase();
const colorOf = p => p === '.' ? null : (isWhite(p) ? WHITE : BLACK);

const FILE = i => i % 8;
const RANK = i => (i / 8) | 0;
const onBoard = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
const idx = (f, r) => r * 8 + f;

/* Начальная позиция со всеми правами рокировки */
function newGame() {
  return {
    board: START.slice(),
    turn: WHITE,
    castle: { K: true, Q: true, k: true, q: true },   // K/Q — белые, k/q — чёрные
    ep: null,          // клетка для взятия на проходе
    halfmove: 0,       // ходов без взятий и движения пешек
    history: [],
  };
}

const PROMO = ['q', 'r', 'b', 'n'];

const STEPS = {
  n: [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]],
  b: [[1,1],[1,-1],[-1,-1],[-1,1]],
  r: [[1,0],[0,1],[-1,0],[0,-1]],
  k: [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]],
};

/* Псевдоходы: без проверки, не подставляется ли король */
function pseudoMoves(st, only) {
  const { board: b, turn } = st;
  const out = [];
  const add = (from, to, extra) => out.push({ from, to, ...extra });

  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (p === '.' || colorOf(p) !== turn) continue;
    if (only !== undefined && i !== only) continue;

    const low = p.toLowerCase();
    const f = FILE(i), r = RANK(i);

    if (low === 'p') {
      const dir = turn === WHITE ? -1 : 1;          // белые идут вверх (индекс уменьшается)
      const startRank = turn === WHITE ? 6 : 1;
      const lastRank = turn === WHITE ? 0 : 7;

      // превращаться можно в любую из четырёх фигур
      const promote = (from, to) => { for (const pc of PROMO) add(from, to, { promo: pc }); };

      const one = idx(f, r + dir);
      if (onBoard(f, r + dir) && b[one] === '.') {
        if (r + dir === lastRank) promote(i, one); else add(i, one, {});
        const two = idx(f, r + 2 * dir);
        if (r === startRank && b[two] === '.') add(i, two, { double: true });
      }
      for (const df of [-1, 1]) {
        const nf = f + df, nr = r + dir;
        if (!onBoard(nf, nr)) continue;
        const t = idx(nf, nr);
        if (b[t] !== '.' && colorOf(b[t]) !== turn) {
          if (nr === lastRank) promote(i, t); else add(i, t, {});
        } else if (st.ep === t) add(i, t, { ep: true });
      }
      continue;
    }

    if (low === 'n' || low === 'k') {
      for (const [df, dr] of STEPS[low]) {
        const nf = f + df, nr = r + dr;
        if (!onBoard(nf, nr)) continue;
        const t = idx(nf, nr);
        if (b[t] === '.' || colorOf(b[t]) !== turn) add(i, t, {});
      }
      if (low === 'k') {
        // рокировка: клетки свободны, права есть; поле под боем проверим позже
        const rights = turn === WHITE ? ['K', 'Q'] : ['k', 'q'];
        const home = turn === WHITE ? 60 : 4;
        if (i === home) {
          if (st.castle[rights[0]] && b[home+1] === '.' && b[home+2] === '.')
            add(i, home + 2, { castle: 'short' });
          if (st.castle[rights[1]] && b[home-1] === '.' && b[home-2] === '.' && b[home-3] === '.')
            add(i, home - 2, { castle: 'long' });
        }
      }
      continue;
    }

    const dirs = low === 'q' ? STEPS.b.concat(STEPS.r) : STEPS[low];
    for (const [df, dr] of dirs) {
      let nf = f + df, nr = r + dr;
      while (onBoard(nf, nr)) {
        const t = idx(nf, nr);
        if (b[t] === '.') add(i, t, {});
        else { if (colorOf(b[t]) !== turn) add(i, t, {}); break; }
        nf += df; nr += dr;
      }
    }
  }
  return out;
}

/* Бьёт ли сторона `by` клетку `sq` */
function attacked(st, sq, by) {
  const b = st.board;
  const f = FILE(sq), r = RANK(sq);

  // пешки
  const dir = by === WHITE ? 1 : -1;             // откуда бьют
  for (const df of [-1, 1]) {
    const nf = f + df, nr = r + dir;
    if (!onBoard(nf, nr)) continue;
    const p = b[idx(nf, nr)];
    if (p !== '.' && colorOf(p) === by && p.toLowerCase() === 'p') return true;
  }
  // конь и король
  for (const [low, steps] of [['n', STEPS.n], ['k', STEPS.k]]) {
    for (const [df, dr] of steps) {
      const nf = f + df, nr = r + dr;
      if (!onBoard(nf, nr)) continue;
      const p = b[idx(nf, nr)];
      if (p !== '.' && colorOf(p) === by && p.toLowerCase() === low) return true;
    }
  }
  // ладья/ферзь и слон/ферзь
  for (const [df, dr] of STEPS.r) {
    let nf = f + df, nr = r + dr;
    while (onBoard(nf, nr)) {
      const p = b[idx(nf, nr)];
      if (p !== '.') {
        if (colorOf(p) === by && 'rq'.includes(p.toLowerCase())) return true;
        break;
      }
      nf += df; nr += dr;
    }
  }
  for (const [df, dr] of STEPS.b) {
    let nf = f + df, nr = r + dr;
    while (onBoard(nf, nr)) {
      const p = b[idx(nf, nr)];
      if (p !== '.') {
        if (colorOf(p) === by && 'bq'.includes(p.toLowerCase())) return true;
        break;
      }
      nf += df; nr += dr;
    }
  }
  return false;
}

const kingSquare = (st, side) =>
  st.board.indexOf(side === WHITE ? 'K' : 'k');

const inCheck = (st, side) =>
  attacked(st, kingSquare(st, side), side === WHITE ? BLACK : WHITE);

/* Применить ход, вернуть данные для отката */
function apply(st, mv) {
  const b = st.board;
  const undo = {
    mv, captured: b[mv.to], castle: { ...st.castle }, ep: st.ep,
    halfmove: st.halfmove, epCaptured: null,
  };
  const piece = b[mv.from];
  const low = piece.toLowerCase();

  b[mv.to] = piece;
  b[mv.from] = '.';

  if (mv.ep) {                                   // взятие на проходе
    const capSq = mv.to + (st.turn === WHITE ? 8 : -8);
    undo.epCaptured = { sq: capSq, piece: b[capSq] };
    b[capSq] = '.';
  }
  if (mv.promo) b[mv.to] = st.turn === WHITE ? mv.promo.toUpperCase() : mv.promo;

  if (mv.castle) {                               // двигаем ладью
    const home = st.turn === WHITE ? 56 : 0;
    if (mv.castle === 'short') { b[home + 5] = b[home + 7]; b[home + 7] = '.'; }
    else { b[home + 3] = b[home]; b[home] = '.'; }
  }

  // права рокировки
  if (low === 'k') {
    if (st.turn === WHITE) { st.castle.K = st.castle.Q = false; }
    else { st.castle.k = st.castle.q = false; }
  }
  if (mv.from === 63 || mv.to === 63) st.castle.K = false;
  if (mv.from === 56 || mv.to === 56) st.castle.Q = false;
  if (mv.from === 7  || mv.to === 7)  st.castle.k = false;
  if (mv.from === 0  || mv.to === 0)  st.castle.q = false;

  st.ep = mv.double ? (mv.from + mv.to) / 2 : null;
  st.halfmove = (low === 'p' || undo.captured !== '.') ? 0 : st.halfmove + 1;
  st.turn = st.turn === WHITE ? BLACK : WHITE;
  return undo;
}

function undoMove(st, undo) {
  const b = st.board, mv = undo.mv;
  st.turn = st.turn === WHITE ? BLACK : WHITE;
  b[mv.from] = mv.promo ? (st.turn === WHITE ? 'P' : 'p') : b[mv.to];
  b[mv.to] = undo.captured;
  if (undo.epCaptured) b[undo.epCaptured.sq] = undo.epCaptured.piece;
  if (mv.castle) {
    const home = st.turn === WHITE ? 56 : 0;
    if (mv.castle === 'short') { b[home + 7] = b[home + 5]; b[home + 5] = '.'; }
    else { b[home] = b[home + 3]; b[home + 3] = '.'; }
  }
  st.castle = undo.castle;
  st.ep = undo.ep;
  st.halfmove = undo.halfmove;
}

/* Только законные ходы: король не остаётся под боем,
   рокировка не проходит через битое поле */
function legalMoves(st, only) {
  const me = st.turn;
  const out = [];
  for (const mv of pseudoMoves(st, only)) {
    if (mv.castle) {
      const home = me === WHITE ? 60 : 4;
      const mid = mv.castle === 'short' ? home + 1 : home - 1;
      const other = me === WHITE ? BLACK : WHITE;
      if (attacked(st, home, other) || attacked(st, mid, other)) continue;
    }
    const u = apply(st, mv);
    if (!inCheck(st, me)) out.push(mv);
    undoMove(st, u);
  }
  return out;
}

function gameState(st) {
  const moves = legalMoves(st);
  if (moves.length) return st.halfmove >= 100 ? 'draw50' : 'play';
  return inCheck(st, st.turn) ? 'mate' : 'stalemate';
}

/* ── Оценка позиции ───────────────────────────────────────────── */
const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

/* Таблицы для белых, для чёрных отражаются по вертикали */
const PST = {
  p: [ 0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10,
       5,5,10,25,25,10,5,5, 0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5,
       5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0 ],
  n: [ -50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40,
       -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30,
       -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30,
       -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50 ],
  b: [ -20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10,
       -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10,
       -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10,
       -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20 ],
  r: [ 0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5,
       -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5,
       -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0 ],
  q: [ -20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10,
       -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5, 0,0,5,5,5,5,0,-5,
       -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20 ],
  k: [ -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30,
       -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30,
       -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10,
       20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20 ],
};

/* Оценка с точки зрения белых, в сотых долях пешки */
function evaluate(st) {
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = st.board[i];
    if (p === '.') continue;
    const low = p.toLowerCase();
    const table = PST[low];
    const sq = isWhite(p) ? i : (56 - 8 * RANK(i) + FILE(i));   // отражение по вертикали
    const v = VALUE[low] + table[sq];
    score += isWhite(p) ? v : -v;
  }
  return score;
}

/* ── Поиск хода ───────────────────────────────────────────────── */
const MATE = 100000;

function order(st, moves) {
  return moves.slice().sort((a, b) => score(b) - score(a));
  function score(mv) {
    const victim = st.board[mv.to];
    if (victim === '.') return mv.promo === 'q' ? 800 : (mv.promo ? 200 : 0);
    return VALUE[victim.toLowerCase()] - VALUE[st.board[mv.from].toLowerCase()] / 10 + 1000;
  }
}

/* Досчитываем взятия, чтобы бот не «зевал» из-за обрыва расчёта */
function quiesce(st, alpha, beta, depth = 4) {
  const stand = st.turn === WHITE ? evaluate(st) : -evaluate(st);
  if (depth === 0) return stand;
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;

  for (const mv of order(st, legalMoves(st).filter(m => st.board[m.to] !== '.' || m.promo))) {
    const u = apply(st, mv);
    const v = -quiesce(st, -beta, -alpha, depth - 1);
    undoMove(st, u);
    if (v >= beta) return beta;
    if (v > alpha) alpha = v;
  }
  return alpha;
}

function search(st, depth, alpha, beta) {
  if (depth === 0) return quiesce(st, alpha, beta);

  const moves = legalMoves(st);
  if (!moves.length) return inCheck(st, st.turn) ? -MATE - depth : 0;

  for (const mv of order(st, moves)) {
    const u = apply(st, mv);
    const v = -search(st, depth - 1, -beta, -alpha);
    undoMove(st, u);
    if (v >= beta) return beta;
    if (v > alpha) alpha = v;
  }
  return alpha;
}

/* Лучший ход. blunder — доля случайности для лёгких уровней */
function bestMove(st, depth, blunder = 0) {
  const moves = order(st, legalMoves(st));
  if (!moves.length) return null;

  // на лёгком уровне иногда играем наугад — так живее и не обидно проигрывать
  if (blunder && Math.random() < blunder) {
    return moves[Math.floor(Math.random() * moves.length)];
  }

  let best = moves[0], bestVal = -Infinity;
  for (const mv of moves) {
    const u = apply(st, mv);
    const v = -search(st, depth - 1, -Infinity, Infinity);
    undoMove(st, u);
    if (v > bestVal) { bestVal = v; best = mv; }
  }
  return best;
}

/* Материал стороны — нужен интерфейсу для подколок */
function material(st, side) {
  let sum = 0;
  for (const p of st.board) {
    if (p === '.' || p.toLowerCase() === 'k') continue;
    if (colorOf(p) === side) sum += VALUE[p.toLowerCase()];
  }
  return sum;
}

const SQ = i => 'abcdefgh'[FILE(i)] + (8 - RANK(i));

/* Разбор позиции из записи FEN — нужен для проверки правил */
function fromFEN(fen) {
  const [rows, turn, castle, ep] = fen.split(' ');
  const board = [];
  for (const row of rows.split('/')) {
    for (const c of row) {
      if (/\d/.test(c)) for (let i = 0; i < +c; i++) board.push('.');
      else board.push(c);
    }
  }
  const sq = s => s === '-' ? null : ('abcdefgh'.indexOf(s[0]) + (8 - +s[1]) * 8);
  return {
    board, turn: turn === 'w' ? WHITE : BLACK,
    castle: { K: castle.includes('K'), Q: castle.includes('Q'),
              k: castle.includes('k'), q: castle.includes('q') },
    ep: sq(ep || '-'), halfmove: 0, history: [],
  };
}

const API = {
  newGame, legalMoves, apply, undoMove, inCheck, gameState, evaluate,
  bestMove, material, attacked, kingSquare, SQ, fromFEN, WHITE, BLACK, colorOf, isWhite, VALUE,
};

if (typeof module !== 'undefined') module.exports = API;      // для проверок в node
if (typeof window !== 'undefined') window.ChessEngine = API;  // для страницы игры

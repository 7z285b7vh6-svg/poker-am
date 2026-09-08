/*
 * ui.js — Renderizado del DOM. No conoce Firebase ni las reglas del juego;
 * solo recibe snapshots de datos (meta, players, game, myCards) y pinta.
 */
(function () {
  const RANK_LABEL = { T: '10' };
  const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const SUIT_RED = { h: true, d: true };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function cardEl(card, opts = {}) {
    if (!card) {
      const back = el('div', 'card back' + (opts.small ? ' small' : ''));
      return back;
    }
    const rank = card[0];
    const suit = card[1];
    const c = el('div', 'card' + (SUIT_RED[suit] ? ' red' : '') + (opts.small ? ' small' : ''));
    c.textContent = (RANK_LABEL[rank] || rank) + SUIT_SYMBOL[suit];
    if (opts.delay) c.style.animationDelay = opts.delay + 'ms';
    return c;
  }

  function faceDownCard(opts = {}) {
    const c = el('div', 'card back' + (opts.small ? ' small' : ''));
    if (opts.delay) c.style.animationDelay = opts.delay + 'ms';
    return c;
  }

  function fmtChips(n) {
    return Math.round(n).toLocaleString('es-MX');
  }

  function showToast(text) {
    const container = document.getElementById('toast-container');
    const t = el('div', 'toast', text);
    container.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // -------- Lobby --------

  function renderLobbySettings(meta) {
    const box = document.getElementById('lobby-settings');
    box.innerHTML = '';
    if (!meta || !meta.settings) return;
    const s = meta.settings;
    const items = [
      `💰 ${fmtChips(s.startingChips)} fichas iniciales`,
      `🔹 Ciegas ${fmtChips(s.smallBlind)}/${fmtChips(s.bigBlind)}`,
      `👥 Máx. ${s.maxPlayers} jugadores`,
    ];
    for (const it of items) box.appendChild(el('span', null, it));
  }

  function renderLobbyPlayers(playersObj, hostUid, opts = {}) {
    const ul = document.getElementById('lobby-players');
    ul.innerHTML = '';
    const list = Object.entries(playersObj || {}).sort((a, b) => a[1].seat - b[1].seat);
    for (const [uid, p] of list) {
      const li = el('li');
      const dot = el('span', 'dot' + (p.connected ? '' : ' off'));
      const name = el('span', 'p-name', p.name);
      li.appendChild(dot);
      li.appendChild(name);
      if (uid === hostUid) li.appendChild(el('span', 'p-host', 'Anfitrión'));
      if (p.isBot) li.appendChild(el('span', 'p-host', 'Bot'));
      li.appendChild(el('span', 'p-chips', fmtChips(p.chips)));
      if (p.isBot && opts.isHost && opts.onRemoveBot) {
        const removeBtn = el('button', 'icon-btn', '✕');
        removeBtn.type = 'button';
        removeBtn.title = 'Quitar bot';
        removeBtn.addEventListener('click', () => opts.onRemoveBot(uid));
        li.appendChild(removeBtn);
      }
      ul.appendChild(li);
    }
  }

  // -------- Mesa de juego --------

  // Calcula posiciones (en % del contenedor) alrededor de la mesa ovalada,
  // partiendo de mySeat en la parte inferior central y avanzando en orden de
  // turno alrededor de la mesa.
  function seatPositions(n, myDisplayIndex) {
    const positions = [];
    const Rx = 43, Ry = 39;
    for (let k = 0; k < n; k++) {
      const angleDeg = 90 + (k * 360) / n;
      const rad = (angleDeg * Math.PI) / 180;
      const left = 50 + Rx * Math.cos(rad);
      const top = 50 + Ry * Math.sin(rad);
      positions.push({ left, top });
    }
    return positions;
  }

  function statusLabel(status) {
    switch (status) {
      case 'folded': return 'Retirado';
      case 'allin': return 'ALL-IN';
      case 'busted': return 'Eliminado';
      case 'sittingout': return 'Fuera de la mano';
      default: return '';
    }
  }

  // Evita "re-repartir" (re-animar) cartas que ya estaban en pantalla: solo se
  // reconstruye una sección del DOM cuando su contenido realmente cambió.
  let lastCommunityKey = null;
  let lastMyCardsKey = null;

  function renderTable(ctx) {
    const { meta, players, game, myUid, myCards } = ctx;
    document.getElementById('topbar-hand').textContent = `Mano #${(game && game.handNumber) || 0}`;

    const communityCards = (game && game.community) || [];
    const communityKey = communityCards.join(',');
    if (communityKey !== lastCommunityKey) {
      lastCommunityKey = communityKey;
      const community = document.getElementById('community-row');
      community.innerHTML = '';
      communityCards.forEach((c, i) => community.appendChild(cardEl(c, { delay: i * 90 })));
      for (let i = communityCards.length; i < 5; i++) {
        const ph = el('div', 'card back small');
        ph.style.opacity = '0.12';
        community.appendChild(ph);
      }
    }

    document.getElementById('pot-display').textContent = `Bote: ${fmtChips(computePot(players))}`;
    document.getElementById('phase-label').textContent = game ? phaseText(game.phase) : '';

    // Cartas propias
    const myPlayer = players[myUid];
    const showMyCards = myCards && myCards.length === 2 && myPlayer && myPlayer.status !== 'busted' && myPlayer.status !== 'sittingout';
    const myCardsKey = showMyCards ? myCards.join(',') : '';
    if (myCardsKey !== lastMyCardsKey) {
      lastMyCardsKey = myCardsKey;
      const myCardsBox = document.getElementById('my-cards');
      myCardsBox.innerHTML = '';
      if (showMyCards) myCards.forEach((c, i) => myCardsBox.appendChild(cardEl(c, { delay: i * 90 })));
    }

    // Asientos
    const list = Object.entries(players || {}).sort((a, b) => a[1].seat - b[1].seat);
    const n = list.length;
    const myIndex = Math.max(0, list.findIndex(([uid]) => uid === myUid));
    const order = [];
    for (let k = 0; k < n; k++) order.push(list[(myIndex + k) % n]);
    const positions = seatPositions(n, 0);

    const layer = document.getElementById('seats-layer');
    layer.innerHTML = '';
    order.forEach(([uid, p], k) => {
      const pos = positions[k];
      const seat = el('div', 'seat');
      seat.style.left = pos.left + '%';
      seat.style.top = pos.top + '%';
      if (p.status === 'folded') seat.classList.add('folded');
      const isTurn = game && game.turnUid === uid && (game.phase !== 'handover' && game.phase !== 'showdown');
      if (isTurn) seat.classList.add('turn');

      const avatarWrap = el('div', 'seat-avatar-wrap');
      const avatar = el('div', 'seat-avatar', initials(p.name));
      avatarWrap.appendChild(avatar);
      if (game && game.dealerSeat === p.seat) {
        avatarWrap.appendChild(el('div', 'dealer-chip', 'D'));
      }
      if (isTurn) {
        const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        ring.setAttribute('class', 'timer-ring');
        ring.setAttribute('viewBox', '0 0 60 60');
        ring.innerHTML = `<circle cx="30" cy="30" r="27" fill="none" stroke="rgba(232,184,75,0.9)" stroke-width="3"
          stroke-dasharray="169.6" stroke-dashoffset="0" data-ring="1" transform="rotate(-90 30 30)"/>`;
        avatarWrap.appendChild(ring);
      }
      seat.appendChild(avatarWrap);
      seat.appendChild(el('div', 'seat-name', p.name + (uid === myUid ? ' (tú)' : '')));
      seat.appendChild(el('div', 'seat-chips', fmtChips(p.chips)));

      const st = statusLabel(p.status);
      if (st) seat.appendChild(el('div', 'seat-status' + (p.status === 'allin' ? ' allin' : ''), st));

      if (p.currentBet > 0 && (p.status === 'active' || p.status === 'allin')) {
        seat.appendChild(el('div', 'seat-bet', fmtChips(p.currentBet)));
      }

      // Cartas: reveladas en showdown para todos (incluso uno mismo); si no,
      // las propias ya se ven abajo en la barra de acciones, y las ajenas boca abajo.
      const holeRow = el('div', 'seat-hole-cards');
      const revealed = game && game.results && game.results.revealed && game.results.revealed.find((r) => r.uid === uid);
      if (revealed) {
        revealed.holeCards.forEach((c) => holeRow.appendChild(cardEl(c, { small: true })));
      } else if (uid === myUid && myCards && myCards.length === 2 && p.status !== 'sittingout' && p.status !== 'busted') {
        // ya se muestran abajo en la barra de acciones; no duplicar aquí
      } else if (p.status === 'active' || p.status === 'allin') {
        holeRow.appendChild(faceDownCard({ small: true }));
        holeRow.appendChild(faceDownCard({ small: true }));
      }
      seat.appendChild(holeRow);

      layer.appendChild(seat);
    });

    startTimerLoop(game);
  }

  function initials(name) {
    if (!name) return '?';
    return name.trim().slice(0, 2).toUpperCase();
  }

  function phaseText(phase) {
    const map = { preflop: 'PRE-FLOP', flop: 'FLOP', turn: 'TURN', river: 'RIVER', showdown: 'SHOWDOWN', handover: '' };
    return map[phase] || '';
  }

  // El bote total en cualquier momento de la mano es la suma de lo aportado
  // por todos los jugadores (incluye apuestas de la calle actual, aún no
  // "recogidas" al centro visualmente, lo cual es la forma más simple y
  // siempre correcta de mostrarlo).
  function computePot(players) {
    return Object.values(players || {}).reduce((s, p) => s + (p.totalContributed || 0), 0);
  }

  let timerInterval = null;
  function startTimerLoop(game) {
    if (timerInterval) clearInterval(timerInterval);
    if (!game || !game.turnDeadline || game.turnSeat === null || game.turnSeat === undefined) return;
    const update = () => {
      const ring = document.querySelector('[data-ring="1"]');
      if (!ring) return;
      const offset = window.__serverOffset || 0;
      const now = Date.now() + offset;
      const total = 30000;
      const remaining = Math.max(0, game.turnDeadline - now);
      const frac = Math.min(1, remaining / total);
      const circumference = 169.6;
      ring.setAttribute('stroke-dashoffset', String(circumference * (1 - frac)));
      ring.setAttribute('stroke', frac < 0.25 ? 'rgba(229,72,77,0.9)' : 'rgba(232,184,75,0.9)');
    };
    update();
    timerInterval = setInterval(update, 250);
  }

  function renderResultsBanner(results, players) {
    const box = document.getElementById('results-banner');
    if (!results) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.innerHTML = '';
    box.appendChild(el('h3', null, '🏆 Resultado de la mano'));
    for (const w of results.winners) {
      const line = w.handName
        ? `${w.name} gana ${fmtChips(w.amount)} con ${w.handName}`
        : `${w.name} gana ${fmtChips(w.amount)} (los demás se retiraron)`;
      box.appendChild(el('p', null, line));
    }
    box.classList.remove('hidden');
  }

  function renderEndedStandings(playersObj) {
    const box = document.getElementById('ended-standings');
    box.innerHTML = '';
    const list = Object.values(playersObj || {}).sort((a, b) => b.chips - a.chips);
    list.forEach((p, i) => {
      const row = el('div', 'standing-row');
      const left = el('span', null);
      left.appendChild(el('span', 'rank', `#${i + 1}`));
      left.appendChild(document.createTextNode(p.name));
      row.appendChild(left);
      row.appendChild(el('span', null, fmtChips(p.chips) + ' fichas'));
      box.appendChild(row);
    });
  }

  window.UI = {
    cardEl, faceDownCard, fmtChips, showToast,
    renderLobbySettings, renderLobbyPlayers,
    renderTable, renderResultsBanner, renderEndedStandings,
  };
})();

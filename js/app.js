/*
 * app.js — Punto de entrada: pantallas, formularios, y el "pegamento" entre
 * RoomController (Firebase) y UI (DOM).
 */
(function () {
  const controller = new RoomController();
  window.__controller = controller; // útil para depurar desde la consola

  let latestMeta = null;
  let latestPlayers = {};
  let latestGame = null;
  let latestMyCards = [];
  let currentScreen = null;
  let soundEnabled = true;
  let lastTurnUidSeen = null;
  let lastHandoverSeen = -1;

  const STORAGE_KEY = 'holdem_session_v1';

  // ---------------- Utilidades de pantalla ----------------
  function showScreen(id) {
    if (currentScreen === id) return;
    currentScreen = id;
    document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
  }

  function saveSession() {
    if (controller.roomCode) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ code: controller.roomCode, name: myNameCache }));
    }
  }
  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
  }

  let myNameCache = '';

  // ---------------- Sonido (beep sintetizado, sin archivos externos) ----------------
  let audioCtx = null;
  function beep(freq = 880, dur = 160) {
    if (!soundEnabled) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.16, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur / 1000);
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + dur / 1000);
    } catch (e) { /* ignorar */ }
  }

  // ---------------- Tabs de la pantalla de inicio ----------------
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('form-' + btn.dataset.tab).classList.add('active');
    });
  });

  document.getElementById('join-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });

  // La ciega grande siempre es el doble de la chica — no se captura por
  // separado, se calcula sola para que nunca queden desalineadas.
  const sbInput = document.getElementById('create-sb');
  const bbInput = document.getElementById('create-bb');
  function syncBigBlind() {
    const sb = Math.max(1, Number(sbInput.value) || 0);
    bbInput.value = sb * 2;
  }
  sbInput.addEventListener('input', syncBigBlind);
  syncBigBlind();

  // ---------------- Crear sala ----------------
  document.getElementById('form-create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('create-error');
    errBox.textContent = '';
    const hostName = document.getElementById('create-name').value.trim();
    const startingChips = Number(document.getElementById('create-chips').value);
    const smallBlind = Math.max(1, Number(document.getElementById('create-sb').value) || 0);
    const bigBlind = smallBlind * 2; // forzado siempre, sin importar lo que muestre el campo
    const maxPlayers = Number(document.getElementById('create-max').value);
    if (!hostName) return;
    myNameCache = hostName;
    const submitBtn = e.target.querySelector('button[type=submit]');
    submitBtn.disabled = true;
    try {
      await controller.createRoom({ hostName, startingChips, smallBlind, bigBlind, maxPlayers });
      saveSession();
    } catch (err) {
      errBox.textContent = 'No se pudo crear la sala. Revisa tu configuración de Firebase (ver README).';
      console.error(err);
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ---------------- Unirse a sala ----------------
  document.getElementById('form-join').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('join-error');
    errBox.textContent = '';
    const name = document.getElementById('join-name').value.trim();
    const code = document.getElementById('join-code').value.trim();
    if (!name || !code) return;
    myNameCache = name;
    const submitBtn = e.target.querySelector('button[type=submit]');
    submitBtn.disabled = true;
    try {
      const res = await controller.joinRoom(code, name);
      if (res.error) { errBox.textContent = res.error; }
      else { saveSession(); }
    } catch (err) {
      errBox.textContent = 'No se pudo conectar. Revisa tu configuración de Firebase (ver README).';
      console.error(err);
    } finally {
      submitBtn.disabled = false;
    }
  });

  // ---------------- Lobby ----------------
  document.getElementById('btn-copy-code').addEventListener('click', () => {
    if (!controller.roomCode) return;
    navigator.clipboard?.writeText(controller.roomCode).then(() => UI.showToast('Código copiado ✔'));
  });
  document.getElementById('btn-leave-lobby').addEventListener('click', doLeave);
  document.getElementById('btn-leave-game').addEventListener('click', doLeave);
  document.getElementById('btn-back-home').addEventListener('click', doLeave);

  function doLeave() {
    controller.leaveRoom();
    clearSession();
    latestMeta = null; latestPlayers = {}; latestGame = null; latestMyCards = [];
    location.reload();
  }

  document.getElementById('btn-start-game').addEventListener('click', async () => {
    const res = await controller.startGame();
    if (res && res.error) UI.showToast(res.error);
  });

  document.getElementById('btn-add-bot').addEventListener('click', async () => {
    const res = await controller.addBot();
    if (res && res.error) UI.showToast(res.error);
  });

  document.getElementById('btn-play-again').addEventListener('click', async () => {
    await controller.resetToLobby();
  });

  document.getElementById('btn-next-hand').addEventListener('click', () => {
    controller.forceNextHand();
  });

  // ---------------- Log ----------------
  document.getElementById('btn-log-toggle').addEventListener('click', () => {
    document.getElementById('log-panel').classList.toggle('hidden');
  });
  document.getElementById('btn-log-close').addEventListener('click', () => {
    document.getElementById('log-panel').classList.add('hidden');
  });
  document.getElementById('btn-sound').addEventListener('click', (e) => {
    soundEnabled = !soundEnabled;
    e.target.textContent = soundEnabled ? '🔊' : '🔇';
  });

  // ---------------- Acciones de juego ----------------
  document.getElementById('btn-fold').addEventListener('click', () => doAction('fold'));
  document.getElementById('btn-check').addEventListener('click', () => doAction('check'));
  document.getElementById('btn-call').addEventListener('click', () => doAction('call'));
  document.getElementById('btn-allin').addEventListener('click', () => doAction('allin'));
  document.getElementById('btn-raise-open').addEventListener('click', () => {
    document.getElementById('raise-row').classList.remove('hidden');
    document.getElementById('btn-raise-open').classList.add('hidden');
    document.getElementById('btn-raise-confirm').classList.remove('hidden');
  });
  document.getElementById('btn-raise-confirm').addEventListener('click', () => {
    const amount = Number(document.getElementById('raise-input').value);
    // Si el monto elegido deja al jugador sin fichas, es un all-in de
    // verdad — se manda como tal para que quede clarísimo en el historial
    // y no se sienta como que "se marcó all-in sin querer".
    doAction(amount >= currentRaiseMax ? 'allin' : 'raise', amount);
    closeRaiseRow();
  });
  function closeRaiseRow() {
    document.getElementById('raise-row').classList.add('hidden');
    document.getElementById('btn-raise-open').classList.remove('hidden');
    document.getElementById('btn-raise-confirm').classList.add('hidden');
  }

  // Recuerda el tope actual (all-in) para poder avisar cuando el slider lo alcanza.
  let currentRaiseMax = 0;
  function refreshRaiseConfirmLabel() {
    const value = Number(document.getElementById('raise-input').value);
    const btn = document.getElementById('btn-raise-confirm');
    const isAllIn = currentRaiseMax > 0 && value >= currentRaiseMax;
    btn.textContent = isAllIn ? '🔥 Confirmar ALL-IN' : 'Confirmar subida';
    btn.classList.toggle('btn-allin', isAllIn);
  }

  document.getElementById('raise-slider').addEventListener('input', (e) => {
    document.getElementById('raise-input').value = e.target.value;
    e.target.dataset.touched = '1';
    refreshRaiseConfirmLabel();
  });
  document.getElementById('raise-input').addEventListener('input', (e) => {
    document.getElementById('raise-slider').value = e.target.value;
    document.getElementById('raise-slider').dataset.touched = '1';
    refreshRaiseConfirmLabel();
  });

  function doAction(action, amount) {
    if (controller.isHost) {
      const err = controller.hostAction(action, amount);
      if (err) UI.showToast(err);
    } else {
      controller.sendAction(action, amount);
    }
    closeRaiseRow();
  }

  // ---------------- Eventos del controlador ----------------
  controller.on('meta', (meta) => {
    latestMeta = meta;
    if (!meta) { showScreen('screen-landing'); return; }
    document.getElementById('lobby-code').textContent = controller.roomCode.split('').join(' ');
    document.getElementById('topbar-code').textContent = controller.roomCode;
    if (meta.status === 'lobby') {
      showScreen('screen-lobby');
      UI.renderLobbySettings(meta);
      document.getElementById('host-controls').classList.toggle('hidden', !controller.isHost);
      document.getElementById('waiting-msg').classList.toggle('hidden', controller.isHost);
    } else if (meta.status === 'playing') {
      showScreen('screen-game');
    } else if (meta.status === 'ended') {
      showScreen('screen-ended');
      UI.renderEndedStandings(latestPlayers);
      document.getElementById('ended-host-controls').classList.toggle('hidden', !controller.isHost);
    }
  });

  controller.on('players', (players) => {
    latestPlayers = players || {};
    if (latestMeta && latestMeta.status === 'lobby') {
      UI.renderLobbyPlayers(latestPlayers, latestMeta.hostUid, {
        isHost: controller.isHost,
        onRemoveBot: (uid) => controller.removeBot(uid),
      });
      const count = Object.keys(latestPlayers).length;
      document.getElementById('btn-start-game').disabled = count < 2;
      document.getElementById('btn-add-bot').disabled = count >= (latestMeta.settings ? latestMeta.settings.maxPlayers : 5);
    }
    if (latestMeta && latestMeta.status === 'ended') {
      UI.renderEndedStandings(latestPlayers);
    }
    refreshTable();
  });

  controller.on('game', (game) => {
    latestGame = game;
    if (game) controller.setLastKnownHandNumber(game.handNumber || 0);
    refreshTable();
    handleTurnAndResultEffects(game);
  });

  controller.on('myCards', (cards) => {
    latestMyCards = cards || [];
    refreshTable();
  });

  function refreshTable() {
    if (currentScreen !== 'screen-game' || !latestGame) return;
    UI.renderTable({ meta: latestMeta, players: latestPlayers, game: latestGame, myUid: controller.uid, myCards: latestMyCards });
    updateActionBar();
    UI.renderResultsBanner(latestGame.phase === 'handover' ? latestGame.results : null, latestPlayers);
    document.getElementById('host-endhand-controls').classList.toggle('hidden', !(controller.isHost && latestGame.phase === 'handover'));
  }

  function handleTurnAndResultEffects(game) {
    if (!game) return;
    if (game.turnUid && game.turnUid !== lastTurnUidSeen && game.turnUid === controller.uid) {
      beep(880, 160);
    }
    lastTurnUidSeen = game.turnUid;
    if (game.phase === 'handover' && game.results && game.handNumber !== lastHandoverSeen) {
      lastHandoverSeen = game.handNumber;
      const iWon = game.results.winners.some((w) => w.uid === controller.uid);
      if (iWon) beep(1200, 220);
    }
  }

  let lastActionBarTurnKey = null;

  function updateActionBar() {
    const game = latestGame;
    const myPlayer = latestPlayers[controller.uid];
    const controls = document.getElementById('action-controls');
    const isMyTurn = game && myPlayer && game.turnUid === controller.uid &&
      ['preflop', 'flop', 'turn', 'river'].includes(game.phase);

    if (!isMyTurn || !myPlayer) {
      controls.querySelectorAll('button').forEach((b) => (b.disabled = true));
      document.getElementById('turn-hint').textContent = describeWaiting(game);
      return;
    }
    controls.querySelectorAll('button').forEach((b) => (b.disabled = false));
    document.getElementById('turn-hint').textContent = '¡Es tu turno!';

    const turnKey = `${game.turnUid}|${game.phase}|${game.handNumber}`;
    if (turnKey !== lastActionBarTurnKey) {
      lastActionBarTurnKey = turnKey;
      delete document.getElementById('raise-slider').dataset.touched;
    }

    const tableBet = game.currentBet || 0;
    const myBet = myPlayer.currentBet || 0;
    const callAmount = tableBet - myBet;
    const maxTotal = myBet + myPlayer.chips;

    const btnCheck = document.getElementById('btn-check');
    const btnCall = document.getElementById('btn-call');
    btnCheck.classList.toggle('hidden', callAmount > 0);
    btnCall.classList.toggle('hidden', callAmount <= 0);
    btnCall.textContent = `Igualar (${UI.fmtChips(Math.min(callAmount, myPlayer.chips))})`;

    const canRaise = myPlayer.chips > callAmount; // le quedan fichas después de igualar
    document.getElementById('btn-raise-open').classList.toggle('hidden', !canRaise);
    document.getElementById('btn-raise-confirm').classList.toggle('hidden', true);
    if (!canRaise) closeRaiseRow();

    const potNow = Object.values(latestPlayers).reduce((s, p) => s + (p.totalContributed || 0), 0);
    const minRaiseTotal = Math.min(maxTotal, tableBet + (game.minRaise || game.bigBlind || 20));
    const slider = document.getElementById('raise-slider');
    const input = document.getElementById('raise-input');
    slider.min = input.min = minRaiseTotal;
    slider.max = input.max = maxTotal;
    slider.step = input.step = Math.max(1, Math.floor((game.bigBlind || 20) / 2));
    if (!slider.dataset.touched) {
      slider.value = input.value = minRaiseTotal;
    }
    currentRaiseMax = maxTotal;
    refreshRaiseConfirmLabel();

    const quickBox = document.getElementById('quick-bets');
    quickBox.innerHTML = '';
    const quickOptions = [
      { label: '½ bote', value: clamp(tableBet + Math.round(potNow / 2), minRaiseTotal, maxTotal) },
      { label: 'Bote', value: clamp(tableBet + potNow, minRaiseTotal, maxTotal) },
      { label: 'All-in', value: maxTotal },
    ];
    for (const opt of quickOptions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = opt.label;
      b.addEventListener('click', () => {
        slider.value = input.value = opt.value;
        slider.dataset.touched = '1';
        refreshRaiseConfirmLabel();
      });
      quickBox.appendChild(b);
    }
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function describeWaiting(game) {
    if (!game) return '';
    if (game.phase === 'handover') return 'Mano terminada.';
    if (game.phase === 'showdown') return 'Showdown…';
    if (game.autoRunOut) return 'Todos all-in — repartiendo el resto de las cartas…';
    const turnPlayer = latestPlayers[game.turnUid];
    return turnPlayer ? `Esperando a ${turnPlayer.name}…` : '';
  }

  // ---------------- Arranque: reconexión automática ----------------
  (async function boot() {
    try {
      await controller.signIn();
    } catch (err) {
      console.error('No se pudo iniciar sesión anónima en Firebase', err);
      UI.showToast('No se pudo conectar con Firebase. Revisa js/firebase-config.js y el README.');
      showScreen('screen-landing');
      return;
    }
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const { code, name } = JSON.parse(saved);
        myNameCache = name;
        const res = await controller.joinRoom(code, name);
        if (res.error) { clearSession(); showScreen('screen-landing'); }
      } catch (err) {
        clearSession();
        showScreen('screen-landing');
      }
    } else {
      showScreen('screen-landing');
    }
  })();

  window.addEventListener('beforeunload', () => {
    if (controller.roomCode && controller.uid) {
      controller.db.ref(`rooms/${controller.roomCode}/players/${controller.uid}/connected`).set(false);
    }
  });
})();

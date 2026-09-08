/*
 * firebase-adapter.js — Conecta el motor de juego puro (game.js) con Firebase
 * Realtime Database. TODA la lógica de reglas del juego corre solo en el
 * navegador del anfitrión (host); los demás jugadores únicamente leen el
 * estado público/privado y envían "intenciones de acción" a /actions.
 *
 * Se apoya en el SDK "compat" de Firebase (namespaced), cargado vía <script>
 * en index.html, para evitar cualquier paso de build/bundling.
 */
(function () {
  const TURN_SECONDS = 30;
  const AUTO_RUN_DELAY_MS = 900; // pausa entre calles cuando se reparte solo (todos all-in)
  const SHOWDOWN_REVEAL_DELAY_MS = 1400; // pausa tras ver las 5 cartas antes de calcular el ganador
  const NEXT_HAND_DELAY_MS = 7000; // tiempo que se muestra el resultado antes de la siguiente mano
  const BOT_THINK_MIN_MS = 900; // "tiempo de reacción" simulado del bot
  const BOT_THINK_MAX_MS = 2200;

  const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin caracteres ambiguos

  function randomRoomCode(len = 5) {
    let code = '';
    for (let i = 0; i < len; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
    return code;
  }

  class RoomController {
    constructor() {
      this.db = firebase.database();
      this.auth = firebase.auth();
      this.uid = null;
      this.roomCode = null;
      this.isHost = false;
      this.listeners = [];
      this.hostGameState = null; // solo existe en el cliente del host
      this.turnTimer = null;
      this.nextHandTimer = null;
      this.serverOffset = 0;
      this.handlers = {}; // callbacks registrados por app.js
    }

    on(event, cb) {
      this.handlers[event] = cb;
    }

    _emit(event, payload) {
      if (this.handlers[event]) this.handlers[event](payload);
    }

    async signIn() {
      const cred = await this.auth.signInAnonymously();
      this.uid = cred.user.uid;
      this.db.ref('.info/serverTimeOffset').on('value', (snap) => {
        this.serverOffset = snap.val() || 0;
      });
      return this.uid;
    }

    serverNow() {
      return Date.now() + this.serverOffset;
    }

    // ---------------- Crear / unirse a sala ----------------

    async createRoom({ hostName, startingChips, smallBlind, bigBlind, maxPlayers }) {
      if (!this.uid) await this.signIn();
      let code;
      // Reintenta si por mala suerte el código ya existe
      for (let attempt = 0; attempt < 5; attempt++) {
        code = randomRoomCode();
        const snap = await this.db.ref(`rooms/${code}/meta`).get();
        if (!snap.exists()) break;
      }
      this.roomCode = code;
      this.isHost = true;

      const meta = {
        hostUid: this.uid,
        createdAt: firebase.database.ServerValue.TIMESTAMP,
        status: 'lobby',
        settings: { startingChips, smallBlind, bigBlind, maxPlayers },
      };
      await this.db.ref(`rooms/${code}/meta`).set(meta);
      await this.db.ref(`rooms/${code}/players/${this.uid}`).set({
        name: hostName,
        seat: 0,
        chips: startingChips,
        status: 'sittingout',
        currentBet: 0,
        totalContributed: 0,
        isHost: true,
        connected: true,
      });
      this._setupPresence(code, this.uid);
      this._attachHostListeners(code);
      this._attachCommonListeners(code);
      return code;
    }

    async joinRoom(code, name) {
      if (!this.uid) await this.signIn();
      code = code.toUpperCase().trim();
      const metaSnap = await this.db.ref(`rooms/${code}/meta`).get();
      if (!metaSnap.exists()) return { error: 'No existe una sala con ese código.' };
      const meta = metaSnap.val();
      if (meta.status === 'ended') return { error: 'Esa sala ya terminó.' };

      const playersSnap = await this.db.ref(`rooms/${code}/players`).get();
      const players = playersSnap.val() || {};
      if (players[this.uid]) {
        // Ya estábamos en la sala (recarga de página) — solo reconectar
        this.roomCode = code;
        this.isHost = players[this.uid].isHost === true;
        await this.db.ref(`rooms/${code}/players/${this.uid}/connected`).set(true);
        this._setupPresence(code, this.uid);
        if (this.isHost) {
          if (meta.status === 'playing') await this._recoverHostState();
          this._attachHostListeners(code);
        }
        this._attachCommonListeners(code);
        return { ok: true, rejoined: true };
      }
      const count = Object.keys(players).length;
      if (count >= meta.settings.maxPlayers) return { error: 'La sala ya está llena.' };
      if (meta.status !== 'lobby') return { error: 'La partida ya comenzó. Espera a la siguiente ronda o pide al anfitrión otra sala.' };

      this.roomCode = code;
      this.isHost = false;
      await this.db.ref(`rooms/${code}/joinRequests/${this.uid}`).set({
        name,
        ts: firebase.database.ServerValue.TIMESTAMP,
      });
      this._setupPresence(code, this.uid);
      this._attachCommonListeners(code);
      return { ok: true };
    }

    _setupPresence(code, uid) {
      const ref = this.db.ref(`rooms/${code}/players/${uid}/connected`);
      ref.onDisconnect().set(false);
      ref.set(true);
    }

    leaveRoom() {
      this.listeners.forEach(({ ref, cb }) => ref.off('value', cb));
      this.listeners = [];
      if (this.turnTimer) clearInterval(this.turnTimer);
      if (this.nextHandTimer) clearTimeout(this.nextHandTimer);
      if (this.roomCode && this.uid) {
        this.db.ref(`rooms/${this.roomCode}/players/${this.uid}/connected`).set(false);
      }
    }

    // ---------------- Listeners comunes a todos los clientes ----------------

    _attachCommonListeners(code) {
      const metaRef = this.db.ref(`rooms/${code}/meta`);
      const metaCb = (snap) => this._emit('meta', snap.val());
      metaRef.on('value', metaCb);
      this.listeners.push({ ref: metaRef, cb: metaCb });

      const playersRef = this.db.ref(`rooms/${code}/players`);
      const playersCb = (snap) => this._emit('players', snap.val() || {});
      playersRef.on('value', playersCb);
      this.listeners.push({ ref: playersRef, cb: playersCb });

      const gameRef = this.db.ref(`rooms/${code}/game`);
      const gameCb = (snap) => this._emit('game', snap.val());
      gameRef.on('value', gameCb);
      this.listeners.push({ ref: gameRef, cb: gameCb });

      const privRef = this.db.ref(`rooms/${code}/private/${this.uid}/holeCards`);
      const privCb = (snap) => this._emit('myCards', snap.val() || []);
      privRef.on('value', privCb);
      this.listeners.push({ ref: privRef, cb: privCb });
    }

    // ---------------- Solo el anfitrión: procesar joins y acciones ----------------

    _attachHostListeners(code) {
      const joinRef = this.db.ref(`rooms/${code}/joinRequests`);
      const joinCb = (snap) => this._processJoinRequests(snap.val() || {});
      joinRef.on('value', joinCb);
      this.listeners.push({ ref: joinRef, cb: joinCb });

      const actionsRef = this.db.ref(`rooms/${code}/actions`);
      const actionsCb = (snap) => {
        const val = snap.val();
        if (val) this._processActionQueue(val);
      };
      actionsRef.on('value', actionsCb);
      this.listeners.push({ ref: actionsRef, cb: actionsCb });
    }

    async _processJoinRequests(requests) {
      const entries = Object.entries(requests);
      if (entries.length === 0) return;
      const playersSnap = await this.db.ref(`rooms/${this.roomCode}/players`).get();
      const players = playersSnap.val() || {};
      const metaSnap = await this.db.ref(`rooms/${this.roomCode}/meta`).get();
      const meta = metaSnap.val();
      let nextSeat = Object.keys(players).length;
      for (const [uid, req] of entries) {
        if (players[uid]) { // ya estaba, solo limpia la solicitud
          await this.db.ref(`rooms/${this.roomCode}/joinRequests/${uid}`).remove();
          continue;
        }
        if (Object.keys(players).length >= meta.settings.maxPlayers) {
          await this.db.ref(`rooms/${this.roomCode}/joinRequests/${uid}`).remove();
          continue;
        }
        const newPlayer = {
          name: req.name || 'Jugador',
          seat: nextSeat,
          chips: meta.settings.startingChips,
          status: 'sittingout',
          currentBet: 0,
          totalContributed: 0,
          isHost: false,
          connected: true,
        };
        players[uid] = newPlayer;
        nextSeat += 1;
        await this.db.ref(`rooms/${this.roomCode}/players/${uid}`).set(newPlayer);
        await this.db.ref(`rooms/${this.roomCode}/joinRequests/${uid}`).remove();
      }
    }

    // ---------------- Bots (solo host, solo en el lobby) ----------------

    static get BOT_NAMES() {
      return ['Bot Ana 🤖', 'Bot Beto 🤖', 'Bot Caro 🤖', 'Bot Dani 🤖', 'Bot Eva 🤖'];
    }

    async addBot() {
      const metaSnap = await this.db.ref(`rooms/${this.roomCode}/meta`).get();
      const meta = metaSnap.val();
      if (meta.status !== 'lobby') return { error: 'Solo puedes agregar bots antes de iniciar la partida.' };
      const playersSnap = await this.db.ref(`rooms/${this.roomCode}/players`).get();
      const players = playersSnap.val() || {};
      const count = Object.keys(players).length;
      if (count >= meta.settings.maxPlayers) return { error: 'La sala ya está llena.' };

      const usedNames = new Set(Object.values(players).map((p) => p.name));
      const name = RoomController.BOT_NAMES.find((n) => !usedNames.has(n)) || `Bot ${count + 1} 🤖`;
      const botUid = 'bot_' + Math.random().toString(36).slice(2, 10);
      await this.db.ref(`rooms/${this.roomCode}/players/${botUid}`).set({
        name,
        seat: count,
        chips: meta.settings.startingChips,
        status: 'sittingout',
        currentBet: 0,
        totalContributed: 0,
        isHost: false,
        isBot: true,
        connected: true,
      });
      return { ok: true };
    }

    async removeBot(uid) {
      const metaSnap = await this.db.ref(`rooms/${this.roomCode}/meta`).get();
      const meta = metaSnap.val();
      if (meta.status !== 'lobby') return { error: 'Solo puedes quitar bots antes de iniciar la partida.' };
      await this.db.ref(`rooms/${this.roomCode}/players/${uid}`).remove();
      return { ok: true };
    }

    // ---------------- Iniciar partida (solo host) ----------------

    async startGame() {
      const playersSnap = await this.db.ref(`rooms/${this.roomCode}/players`).get();
      const playersObj = playersSnap.val() || {};
      const metaSnap = await this.db.ref(`rooms/${this.roomCode}/meta`).get();
      const meta = metaSnap.val();
      const playerList = Object.entries(playersObj)
        .sort((a, b) => a[1].seat - b[1].seat)
        .map(([uid, p]) => ({ uid, name: p.name, chips: p.chips, isBot: !!p.isBot }));

      if (playerList.length < 2) return { error: 'Se necesitan al menos 2 jugadores.' };

      this.hostGameState = PokerGame.createInitialState(playerList, meta.settings);
      await this.db.ref(`rooms/${this.roomCode}/meta/status`).set('playing');
      this._dealNewHand();
      return { ok: true };
    }

    _dealNewHand() {
      const result = PokerGame.startNewHand(this.hostGameState);
      this.hostGameState = result.state;
      if (result.error) {
        // No hay suficientes jugadores con fichas: terminar la partida
        this.db.ref(`rooms/${this.roomCode}/meta/status`).set('ended');
        this._pushPublicState();
        return;
      }
      this._pushPublicState();
      this._afterStateChange();
    }

    // Aplica una acción propia (host) o de otro jugador (vía cola /actions)
    _applyLocalAction(uid, action, amount) {
      const result = PokerGame.applyAction(this.hostGameState, uid, action, amount);
      if (result.error) return result.error;
      this.hostGameState = result.state;
      this._pushPublicState();
      this._afterStateChange();
      return null;
    }

    _processActionQueue(actions) {
      const entries = Object.entries(actions).sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
      for (const [pushId, act] of entries) {
        if (act.handNumber === this.hostGameState.handNumber) {
          this._applyLocalAction(act.uid, act.action, act.amount);
        }
        this.db.ref(`rooms/${this.roomCode}/actions/${pushId}`).remove();
      }
    }

    // Llamado por la UI del host cuando el propio host actúa
    hostAction(action, amount) {
      return this._applyLocalAction(this.uid, action, amount);
    }

    // Botón "Siguiente mano" del host: no esperar los NEXT_HAND_DELAY_MS
    forceNextHand() {
      if (!this.hostGameState || this.hostGameState.phase !== 'handover') return;
      if (this.nextHandTimer) clearTimeout(this.nextHandTimer);
      if (PokerGame.activePlayerCount(this.hostGameState) >= 2) {
        this._dealNewHand();
      } else {
        this.db.ref(`rooms/${this.roomCode}/meta/status`).set('ended');
      }
    }

    // Reinicia la sala para jugar otra partida con las mismas fichas iniciales
    async resetToLobby() {
      const metaSnap = await this.db.ref(`rooms/${this.roomCode}/meta`).get();
      const meta = metaSnap.val();
      const playersSnap = await this.db.ref(`rooms/${this.roomCode}/players`).get();
      const players = playersSnap.val() || {};
      const updates = {};
      updates[`rooms/${this.roomCode}/meta/status`] = 'lobby';
      updates[`rooms/${this.roomCode}/game`] = null;
      updates[`rooms/${this.roomCode}/hostSecret`] = null;
      for (const uid of Object.keys(players)) {
        updates[`rooms/${this.roomCode}/players/${uid}/chips`] = meta.settings.startingChips;
        updates[`rooms/${this.roomCode}/players/${uid}/status`] = 'sittingout';
        updates[`rooms/${this.roomCode}/players/${uid}/currentBet`] = 0;
        updates[`rooms/${this.roomCode}/players/${uid}/totalContributed`] = 0;
        updates[`rooms/${this.roomCode}/private/${uid}/holeCards`] = null;
      }
      this.hostGameState = null;
      await this.db.ref().update(updates);
    }

    // Llamado por la UI de un jugador (no host) para enviar su acción
    sendAction(action, amount) {
      return this.db.ref(`rooms/${this.roomCode}/actions`).push({
        uid: this.uid,
        action,
        amount: amount == null ? null : amount,
        ts: Date.now(),
        handNumber: this._lastKnownHandNumber || 0,
      });
    }

    // El cliente guarda el número de mano actual (recibido vía 'game') para
    // adjuntarlo a sus acciones y evitar procesar acciones "tardías" de una
    // mano ya terminada.
    setLastKnownHandNumber(n) {
      this._lastKnownHandNumber = n;
    }

    // ---------------- Recuperación (el host recargó la página a mitad de una mano) ----------------

    // Reconstruye this.hostGameState a partir de lo público + lo guardado en
    // hostSecret (mazo restante y quién falta por actuar), que SOLO el host
    // puede leer. Sin esto, si el anfitrión recarga su pestaña la partida en
    // curso quedaría irrecuperable (el mazo solo vive en su memoria).
    async _recoverHostState() {
      try {
        const [gameSnap, playersSnap, secretSnap] = await Promise.all([
          this.db.ref(`rooms/${this.roomCode}/game`).get(),
          this.db.ref(`rooms/${this.roomCode}/players`).get(),
          this.db.ref(`rooms/${this.roomCode}/hostSecret`).get(),
        ]);
        const game = gameSnap.val();
        const secret = secretSnap.val();
        const playersObj = playersSnap.val() || {};
        if (!game || !secret || !secret.deck) return false; // no había mano en curso

        const entries = Object.entries(playersObj).sort((a, b) => a[1].seat - b[1].seat);
        const holeSnaps = await Promise.all(
          entries.map(([uid]) => this.db.ref(`rooms/${this.roomCode}/private/${uid}/holeCards`).get())
        );
        const players = entries.map(([uid, p], i) => ({
          uid,
          name: p.name,
          seat: p.seat,
          chips: p.chips,
          status: p.status,
          currentBet: p.currentBet || 0,
          totalContributed: p.totalContributed || 0,
          holeCards: holeSnaps[i].val() || [],
          isBot: !!p.isBot,
        }));

        this.hostGameState = {
          phase: game.phase,
          players,
          dealerSeat: game.dealerSeat,
          community: game.community || [],
          deck: secret.deck || [],
          currentBet: game.currentBet || 0,
          minRaise: game.minRaise || game.bigBlind,
          turnSeat: game.turnSeat === undefined ? null : game.turnSeat,
          needsToAct: secret.needsToAct || [],
          smallBlind: game.smallBlind,
          bigBlind: game.bigBlind,
          handNumber: game.handNumber || 0,
          log: game.log || [],
          results: game.results || null,
          autoRunOut: !!game.autoRunOut,
        };
        this._afterStateChange();
        return true;
      } catch (err) {
        console.error('No se pudo recuperar el estado de la mano en curso', err);
        return false;
      }
    }

    // ---------------- Ciclo de vida tras cada cambio de estado (host) ----------------

    _afterStateChange() {
      if (!this.hostGameState) return;
      if (this.turnTimer) { clearInterval(this.turnTimer); clearTimeout(this.turnTimer); this.turnTimer = null; }

      const s = this.hostGameState;

      // 'handover' = alguien ganó porque todos los demás se retiraron (fin
      // inmediato, sin cartas que mostrar). 'showdown' = se llegó al río con
      // 2+ jugadores: hay que revelar cartas y CALCULAR el ganador. Antes
      // solo se resolvía 'handover', así que un showdown normal (el caso más
      // común) nunca llamaba a resolveHand y la mesa se quedaba congelada
      // para siempre. Ahora se resuelven ambos casos.
      if (s.phase === 'handover') {
        if (!s.results) {
          this.hostGameState = PokerGame.resolveHand(s);
          this._pushPublicState();
        }
        this._scheduleNextHand();
        return;
      }

      if (s.phase === 'showdown') {
        if (s.results) { this._scheduleNextHand(); return; } // ya resuelto (p.ej. tras recuperar el estado)
        // Pequeña pausa para que se alcancen a ver las 5 cartas comunitarias
        // antes de que aparezca el resultado — se siente menos brusco.
        this.turnTimer = setTimeout(() => {
          if (!this.hostGameState || this.hostGameState.phase !== 'showdown' || this.hostGameState.results) return;
          this.hostGameState = PokerGame.resolveHand(this.hostGameState);
          this._pushPublicState();
          this._scheduleNextHand();
        }, SHOWDOWN_REVEAL_DELAY_MS);
        return;
      }

      if (s.autoRunOut) {
        setTimeout(() => {
          if (!this.hostGameState || !this.hostGameState.autoRunOut) return;
          this.hostGameState = PokerGame.continueAutoRunOut(this.hostGameState);
          this._pushPublicState();
          this._afterStateChange();
        }, AUTO_RUN_DELAY_MS);
        return;
      }

      if (s.turnSeat !== null && (s.phase === 'preflop' || s.phase === 'flop' || s.phase === 'turn' || s.phase === 'river')) {
        const turnPlayer = s.players[s.turnSeat];

        if (turnPlayer.isBot) {
          // El bot "piensa" un ratito random para que se sienta natural, y
          // decide con la IA heurística de bot.js. No se le pone el
          // temporizador humano de 30s — nunca se queda esperando.
          const thinkMs = BOT_THINK_MIN_MS + Math.random() * (BOT_THINK_MAX_MS - BOT_THINK_MIN_MS);
          this.turnTimer = setTimeout(() => {
            if (!this.hostGameState || this.hostGameState.turnSeat === null) return;
            const p = this.hostGameState.players[this.hostGameState.turnSeat];
            if (!p.isBot || p.uid !== turnPlayer.uid) return; // el turno ya cambió
            const decision = PokerBot.decideAction(this.hostGameState, p.uid);
            this._applyLocalAction(p.uid, decision.action, decision.amount);
          }, thinkMs);
          return;
        }

        const deadline = this.serverNow() + TURN_SECONDS * 1000;
        this.db.ref(`rooms/${this.roomCode}/game/turnDeadline`).set(deadline);
        this.turnTimer = setInterval(() => {
          if (!this.hostGameState || this.hostGameState.turnSeat === null) return;
          if (this.serverNow() >= deadline) {
            const p = this.hostGameState.players[this.hostGameState.turnSeat];
            const callAmount = this.hostGameState.currentBet - p.currentBet;
            this._applyLocalAction(p.uid, callAmount > 0 ? 'fold' : 'check', null);
          }
        }, 1000);
      }
    }

    // Programa el arranque de la siguiente mano tras mostrar el resultado
    // (o termina la partida si ya no quedan 2+ jugadores con fichas). Se usa
    // tanto justo después de resolver una mano como al recuperar el estado
    // del host cuando la mano ya había quedado resuelta antes de recargar.
    _scheduleNextHand() {
      if (this.nextHandTimer) clearTimeout(this.nextHandTimer);
      this.nextHandTimer = setTimeout(() => {
        if (PokerGame.activePlayerCount(this.hostGameState) >= 2) {
          this._dealNewHand();
        } else {
          this.db.ref(`rooms/${this.roomCode}/meta/status`).set('ended');
        }
      }, NEXT_HAND_DELAY_MS);
    }

    // Publica el estado a Firebase, separando lo público de lo privado (cartas)
    _pushPublicState() {
      const s = this.hostGameState;
      const updates = {};
      updates[`rooms/${this.roomCode}/game/phase`] = s.phase;
      updates[`rooms/${this.roomCode}/game/community`] = s.community;
      updates[`rooms/${this.roomCode}/game/currentBet`] = s.currentBet;
      updates[`rooms/${this.roomCode}/game/minRaise`] = s.minRaise;
      updates[`rooms/${this.roomCode}/game/dealerSeat`] = s.dealerSeat;
      updates[`rooms/${this.roomCode}/game/turnSeat`] = s.turnSeat;
      updates[`rooms/${this.roomCode}/game/turnUid`] = s.turnSeat !== null ? s.players[s.turnSeat].uid : null;
      updates[`rooms/${this.roomCode}/game/handNumber`] = s.handNumber;
      updates[`rooms/${this.roomCode}/game/autoRunOut`] = !!s.autoRunOut;
      updates[`rooms/${this.roomCode}/game/log`] = s.log.slice(-30);
      updates[`rooms/${this.roomCode}/game/results`] = s.results || null;
      updates[`rooms/${this.roomCode}/game/smallBlind`] = s.smallBlind;
      updates[`rooms/${this.roomCode}/game/bigBlind`] = s.bigBlind;

      for (const p of s.players) {
        const base = `rooms/${this.roomCode}/players/${p.uid}`;
        updates[`${base}/chips`] = p.chips;
        updates[`${base}/status`] = p.status;
        updates[`${base}/currentBet`] = p.currentBet;
        updates[`${base}/totalContributed`] = p.totalContributed;
        updates[`${base}/seat`] = p.seat;
        // Cartas privadas: solo puede leerlas ese uid (o el host), según database.rules.json.
        // La revelación pública en el showdown viaja aparte, dentro de game/results.revealed.
        updates[`rooms/${this.roomCode}/private/${p.uid}/holeCards`] = p.holeCards;
      }

      // Solo el host puede leer esto (ver database.rules.json). Permite
      // reconstruir la mano en curso si el anfitrión recarga su pestaña.
      updates[`rooms/${this.roomCode}/hostSecret/deck`] = s.deck;
      updates[`rooms/${this.roomCode}/hostSecret/needsToAct`] = s.needsToAct;

      this.db.ref().update(updates);
    }
  }

  window.RoomController = RoomController;
})();

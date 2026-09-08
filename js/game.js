/*
 * game.js — Motor de reglas de Texas Hold'em, puro y sin dependencias de
 * Firebase ni del DOM. Recibe y devuelve objetos de estado planos (serializables
 * a JSON), lo que permite probarlo en Node y sincronizarlo tal cual con Firebase.
 *
 * Este motor corre ÚNICAMENTE en el navegador del anfitrión (host). Los demás
 * jugadores solo envían "intenciones de acción" que el host valida y aplica.
 *
 * Simplificaciones deliberadas (juego casero entre amigos, no un motor de casino):
 *  - Un all-in por debajo del "raise mínimo" sí reabre la ronda de apuestas para
 *    el resto (regla ligeramente más generosa que la de casino, pero más simple
 *    y nunca perjudica al que hizo all-in).
 *  - El "chip impar" de un bote dividido por empate se asigna al ganador más
 *    cercano a la izquierda del botón de dealer.
 */
(function (root, factory) {
  const mod = factory(
    typeof module === 'object' && module.exports ? require('./deck.js') : root.PokerDeck,
    typeof module === 'object' && module.exports ? require('./handEvaluator.js') : root.PokerEval
  );
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.PokerGame = mod;
  }
})(typeof self !== 'undefined' ? self : this, function (PokerDeck, PokerEval) {

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function createInitialState(players, settings) {
    // players: [{uid, name, chips}] en el orden en que se sentaron (seat = índice)
    const seated = players.map((p, i) => ({
      uid: p.uid,
      name: p.name,
      seat: i,
      chips: p.chips,
      status: 'sittingout', // se activa al iniciar cada mano
      currentBet: 0,
      totalContributed: 0,
      holeCards: [],
    }));
    return {
      phase: 'lobby',
      players: seated,
      dealerSeat: -1,
      community: [],
      deck: [],
      currentBet: 0,
      minRaise: settings.bigBlind,
      turnSeat: null,
      needsToAct: [],
      smallBlind: settings.smallBlind,
      bigBlind: settings.bigBlind,
      handNumber: 0,
      log: [],
      results: null,
    };
  }

  function pushLog(state, text) {
    state.log.push({ t: Date.now(), text });
    if (state.log.length > 200) state.log.shift();
  }

  function eligiblePlayers(state) {
    // Jugadores con fichas > 0, listos para participar en la próxima mano.
    return state.players.filter((p) => p.chips > 0);
  }

  function nextSeatWithCondition(state, fromSeat, predicate) {
    const n = state.players.length;
    for (let i = 1; i <= n; i++) {
      const seat = (fromSeat + i) % n;
      const p = state.players[seat];
      if (p && predicate(p)) return seat;
    }
    return null;
  }

  // Reparte el botón, ciegas, cartas y arranca la fase 'preflop'.
  function startNewHand(state) {
    const s = clone(state);
    const playable = eligiblePlayers(s);
    if (playable.length < 2) {
      return { state: s, error: 'Se necesitan al menos 2 jugadores con fichas.' };
    }

    // Reiniciar estado de mano para todos
    for (const p of s.players) {
      p.currentBet = 0;
      p.totalContributed = 0;
      p.holeCards = [];
      if (p.chips > 0) {
        p.status = 'active';
      } else {
        p.status = 'busted';
      }
    }
    s.community = [];
    s.results = null;
    s.handNumber += 1;

    const activeSeats = s.players.filter((p) => p.status === 'active').map((p) => p.seat);

    // Rotar botón de dealer al siguiente jugador activo
    let dealerSeat = s.dealerSeat;
    if (dealerSeat === -1 || !activeSeats.includes(dealerSeat)) {
      dealerSeat = activeSeats[0];
    } else {
      dealerSeat = nextSeatWithCondition(s, dealerSeat, (p) => p.status === 'active');
    }
    s.dealerSeat = dealerSeat;

    let sbSeat, bbSeat, firstToActSeat;
    if (activeSeats.length === 2) {
      // Heads-up: el dealer es la ciega chica y actúa primero preflop.
      sbSeat = dealerSeat;
      bbSeat = nextSeatWithCondition(s, dealerSeat, (p) => p.status === 'active');
      firstToActSeat = sbSeat;
    } else {
      sbSeat = nextSeatWithCondition(s, dealerSeat, (p) => p.status === 'active');
      bbSeat = nextSeatWithCondition(s, sbSeat, (p) => p.status === 'active');
      firstToActSeat = nextSeatWithCondition(s, bbSeat, (p) => p.status === 'active');
    }

    postBlind(s, sbSeat, s.smallBlind);
    postBlind(s, bbSeat, s.bigBlind);
    pushLog(s, `Mano #${s.handNumber} — ciegas ${s.smallBlind}/${s.bigBlind}`);

    // Barajar y repartir 2 cartas a cada jugador activo, empezando por la SB
    const deck = PokerDeck.freshShuffledDeck();
    const dealOrder = [];
    let seat = sbSeat;
    for (let i = 0; i < activeSeats.length; i++) {
      dealOrder.push(seat);
      seat = nextSeatWithCondition(s, seat, (p) => p.status === 'active');
    }
    for (let round = 0; round < 2; round++) {
      for (const st of dealOrder) {
        const player = s.players[st];
        player.holeCards.push(deck.pop());
      }
    }
    s.deck = deck;

    s.currentBet = Math.max(s.players[sbSeat].currentBet, s.players[bbSeat].currentBet, s.bigBlind);
    s.minRaise = s.bigBlind;
    s.phase = 'preflop';
    s.turnSeat = firstToActSeat;
    s.needsToAct = s.players.filter((p) => p.status === 'active').map((p) => p.uid);
    s.autoRunOut = false;

    // Caso borde: si el/los ciegos quedaron all-in de entrada y nadie más
    // puede actuar (p.ej. heads-up con un stack muy corto), no hay ronda de
    // apuestas real: se pasa directo a repartir el resto de calles.
    if (s.needsToAct.length === 0) {
      finishBettingRound(s);
    } else if (!s.needsToAct.includes(s.players[s.turnSeat].uid)) {
      const fixed = nextSeatWithCondition(s, s.turnSeat, (p) => canAct(p) && s.needsToAct.includes(p.uid));
      if (fixed !== null) s.turnSeat = fixed;
    }

    return { state: s, error: null };
  }

  function postBlind(s, seat, amount) {
    const p = s.players[seat];
    const paid = Math.min(amount, p.chips);
    p.chips -= paid;
    p.currentBet += paid;
    p.totalContributed += paid;
    if (p.chips === 0) p.status = 'allin';
    pushLog(s, `${p.name} pone la ciega (${paid})`);
  }

  function canAct(p) {
    return p.status === 'active';
  }

  function notFolded(p) {
    return p.status !== 'folded' && p.status !== 'sittingout' && p.status !== 'busted';
  }

  // Aplica la acción de un jugador. action: 'fold'|'check'|'call'|'raise'|'allin'
  // amount (solo para 'raise'): nuevo total de apuesta del jugador en esta calle.
  function applyAction(state, uid, action, amount) {
    const s = clone(state);
    const player = s.players.find((p) => p.uid === uid);
    if (!player) return { state: s, error: 'Jugador no encontrado' };
    if (s.turnSeat === null || s.players[s.turnSeat].uid !== uid) {
      return { state: s, error: 'No es tu turno' };
    }
    if (!canAct(player)) return { state: s, error: 'No puedes actuar' };

    const callAmount = s.currentBet - player.currentBet;

    if (action === 'fold') {
      player.status = 'folded';
      pushLog(s, `${player.name} se retira`);
    } else if (action === 'check') {
      if (callAmount > 0) return { state: state, error: 'No puedes pasar, hay una apuesta que igualar' };
      pushLog(s, `${player.name} pasa`);
    } else if (action === 'call') {
      const pay = Math.min(callAmount, player.chips);
      player.chips -= pay;
      player.currentBet += pay;
      player.totalContributed += pay;
      if (player.chips === 0) player.status = 'allin';
      pushLog(s, `${player.name} iguala (${pay})`);
    } else if (action === 'raise' || action === 'allin') {
      let raiseTo = action === 'allin' ? player.currentBet + player.chips : amount;
      if (raiseTo > player.currentBet + player.chips) raiseTo = player.currentBet + player.chips; // cap
      const pay = raiseTo - player.currentBet;
      if (pay <= 0 || pay > player.chips) return { state: state, error: 'Monto de apuesta inválido' };
      const isAllIn = pay === player.chips;
      const raiseSize = raiseTo - s.currentBet;
      if (raiseTo <= s.currentBet && !isAllIn) {
        return { state: state, error: 'La subida debe superar la apuesta actual' };
      }
      if (raiseTo <= s.currentBet && isAllIn) {
        // All-in por debajo de la apuesta actual en realidad es un "call" parcial
        player.chips = 0;
        player.currentBet = raiseTo;
        player.totalContributed += pay;
        player.status = 'allin';
        pushLog(s, `${player.name} va all-in por ${pay} (no alcanza a igualar)`);
        s.needsToAct = s.needsToAct.filter((u) => u !== uid);
        advanceTurnOrRound(s);
        return { state: s, error: null };
      }
      if (raiseSize < s.minRaise && !isAllIn) {
        return { state: state, error: `La subida mínima es ${s.minRaise}` };
      }
      player.chips -= pay;
      player.currentBet = raiseTo;
      player.totalContributed += pay;
      if (isAllIn) player.status = 'allin';
      if (raiseSize > 0) s.minRaise = raiseSize;
      s.currentBet = raiseTo;
      // Reabrir la acción para todos los demás jugadores activos/all-in-capaces
      s.needsToAct = s.players
        .filter((p) => p.uid !== uid && p.status === 'active')
        .map((p) => p.uid);
      pushLog(s, `${player.name} ${action === 'allin' ? 'va all-in' : 'sube'} a ${raiseTo}`);
      advanceTurnOrRound(s);
      return { state: s, error: null };
    } else {
      return { state: state, error: 'Acción desconocida' };
    }

    s.needsToAct = s.needsToAct.filter((u) => u !== uid);
    advanceTurnOrRound(s);
    return { state: s, error: null };
  }

  function activeNonFolded(s) {
    return s.players.filter((p) => notFolded(p));
  }

  function advanceTurnOrRound(s) {
    // ¿Queda un único jugador no retirado? Mano terminada de inmediato.
    const remaining = activeNonFolded(s);
    if (remaining.length <= 1) {
      s.phase = 'handover';
      s.turnSeat = null;
      return;
    }

    if (s.needsToAct.length === 0) {
      finishBettingRound(s);
      return;
    }

    // Buscar siguiente asiento activo (puede actuar) en sentido horario
    const nextSeat = nextSeatWithCondition(s, s.turnSeat, (p) => canAct(p) && s.needsToAct.includes(p.uid));
    if (nextSeat === null) {
      finishBettingRound(s);
    } else {
      s.turnSeat = nextSeat;
    }
  }

  function finishBettingRound(s) {
    const remaining = activeNonFolded(s);
    if (remaining.length <= 1) {
      s.phase = 'handover';
      s.turnSeat = null;
      return;
    }
    // Reiniciar apuestas de la calle
    for (const p of s.players) p.currentBet = 0;
    s.currentBet = 0;
    s.minRaise = s.bigBlind;

    if (s.phase === 'preflop') {
      s.deck.pop(); // quemar
      s.community.push(s.deck.pop(), s.deck.pop(), s.deck.pop());
      s.phase = 'flop';
    } else if (s.phase === 'flop') {
      s.deck.pop();
      s.community.push(s.deck.pop());
      s.phase = 'turn';
    } else if (s.phase === 'turn') {
      s.deck.pop();
      s.community.push(s.deck.pop());
      s.phase = 'river';
    } else if (s.phase === 'river') {
      s.phase = 'showdown';
      s.turnSeat = null;
      return;
    }
    pushLog(s, `— ${s.phase.toUpperCase()} —`);

    const canActPlayers = s.players.filter((p) => p.status === 'active');
    if (canActPlayers.length <= 1) {
      // Todos all-in menos (como mucho) uno: no hay más apuestas, se reparten
      // las calles restantes automáticamente ("run it out").
      s.needsToAct = [];
      s.turnSeat = null;
      s.autoRunOut = true;
      return;
    }
    s.autoRunOut = false;
    s.needsToAct = canActPlayers.map((p) => p.uid);
    s.turnSeat = nextSeatWithCondition(s, s.dealerSeat, (p) => p.status === 'active');
  }

  // Se llama repetidamente (con posible delay en la UI) mientras autoRunOut sea
  // true, hasta llegar a showdown.
  function continueAutoRunOut(state) {
    const s = clone(state);
    if (s.phase === 'river') {
      s.phase = 'showdown';
      s.autoRunOut = false;
      return s;
    }
    finishBettingRound(s);
    return s;
  }

  // Construye los botes (principal + side pots) según lo aportado por cada jugador.
  function buildPots(players) {
    const contributors = players.filter((p) => p.totalContributed > 0);
    const levels = [...new Set(contributors.map((p) => p.totalContributed))].sort((a, b) => a - b);
    const pots = [];
    let prevLevel = 0;
    for (const level of levels) {
      const layerPlayers = contributors.filter((p) => p.totalContributed >= level);
      const amount = (level - prevLevel) * layerPlayers.length;
      const eligible = layerPlayers.filter((p) => notFolded(p)).map((p) => p.uid);
      if (amount > 0) pots.push({ amount, eligible });
      prevLevel = level;
    }
    return pots;
  }

  // Resuelve el showdown (o el caso de que todos se retiraran menos uno).
  function resolveHand(state) {
    const s = clone(state);
    const remaining = activeNonFolded(s);
    const pots = buildPots(s.players);
    const winners = []; // {uid, name, amount, handName}

    if (remaining.length === 1) {
      const winner = remaining[0];
      const total = pots.reduce((sum, pot) => sum + pot.amount, 0);
      winner.chips += total;
      winners.push({ uid: winner.uid, name: winner.name, amount: total, handName: null });
      pushLog(s, `${winner.name} gana ${total} (todos los demás se retiraron)`);
    } else {
      const scores = {};
      for (const p of remaining) {
        scores[p.uid] = PokerEval.evaluateBest([...p.holeCards, ...s.community]);
      }
      for (const pot of pots) {
        const eligibleUids = pot.eligible.filter((uid) => scores[uid]);
        if (eligibleUids.length === 0) continue;
        let bestScore = scores[eligibleUids[0]];
        for (const uid of eligibleUids) {
          if (PokerEval.compareScore(scores[uid], bestScore) > 0) bestScore = scores[uid];
        }
        const potWinners = eligibleUids.filter((uid) => PokerEval.compareScore(scores[uid], bestScore) === 0);
        // Ordenar ganadores por posición desde la izquierda del dealer para el chip impar
        potWinners.sort((a, b) => {
          const seatA = s.players.find((p) => p.uid === a).seat;
          const seatB = s.players.find((p) => p.uid === b).seat;
          const relA = (seatA - s.dealerSeat + s.players.length) % s.players.length;
          const relB = (seatB - s.dealerSeat + s.players.length) % s.players.length;
          return relA - relB;
        });
        const share = Math.floor(pot.amount / potWinners.length);
        let remainder = pot.amount - share * potWinners.length;
        for (const uid of potWinners) {
          const p = s.players.find((pp) => pp.uid === uid);
          let amount = share;
          if (remainder > 0) { amount += 1; remainder -= 1; }
          p.chips += amount;
          const existing = winners.find((w) => w.uid === uid);
          const handName = scores[uid].name;
          if (existing) existing.amount += amount;
          else winners.push({ uid, name: p.name, amount, handName });
        }
      }
      for (const w of winners) {
        pushLog(s, `${w.name} gana ${w.amount}${w.handName ? ' con ' + w.handName : ''}`);
      }
    }

    // Revelar cartas de todos los que llegaron al showdown (para la UI)
    const revealed = remaining.map((p) => ({ uid: p.uid, holeCards: p.holeCards }));

    for (const p of s.players) {
      if (p.chips <= 0) p.status = 'busted';
    }

    s.phase = 'handover';
    s.results = { winners, pots, revealed, handNumber: s.handNumber };
    return s;
  }

  function activePlayerCount(s) {
    return s.players.filter((p) => p.chips > 0).length;
  }

  return {
    createInitialState,
    startNewHand,
    applyAction,
    continueAutoRunOut,
    resolveHand,
    buildPots,
    activePlayerCount,
    notFolded,
  };
});

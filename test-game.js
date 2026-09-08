const Game = require('./js/game.js');

function assert(cond, msg) {
  if (!cond) {
    console.error('FALLÓ:', msg);
    process.exitCode = 1;
  } else {
    console.log('OK:', msg);
  }
}

// ---------- Escenario 1: mano completa hasta showdown con 3 jugadores ----------
(function scenario1() {
  let state = Game.createInitialState(
    [{ uid: 'a', name: 'Ana', chips: 1000 }, { uid: 'b', name: 'Beto', chips: 1000 }, { uid: 'c', name: 'Caro', chips: 1000 }],
    { smallBlind: 10, bigBlind: 20 }
  );
  let r = Game.startNewHand(state);
  assert(!r.error, 'startNewHand sin error (3 jugadores)');
  state = r.state;
  assert(state.phase === 'preflop', 'fase preflop tras repartir');
  assert(state.players.every((p) => p.holeCards.length === 2 || p.status === 'busted'), 'cada jugador tiene 2 cartas');
  assert(state.deck.length === 52 - 6, 'deck con 46 cartas tras repartir a 3 jugadores');

  // Todos igualan/pasan hasta el river, luego showdown
  function playWholeStreet() {
    let guard = 0;
    while (state.phase !== 'showdown' && state.phase !== 'handover' && guard < 50) {
      guard++;
      const turnUid = state.players[state.turnSeat].uid;
      const player = state.players.find((p) => p.uid === turnUid);
      const callAmount = state.currentBet - player.currentBet;
      const action = callAmount > 0 ? 'call' : 'check';
      const res = Game.applyAction(state, turnUid, action, null);
      assert(!res.error, `acción ${action} de ${turnUid} sin error en fase ${state.phase}`);
      state = res.state;
      if (state.autoRunOut) state = Game.continueAutoRunOut(state);
    }
  }
  playWholeStreet();
  assert(state.phase === 'showdown', 'la mano llega a showdown cuando todos igualan');
  assert(state.community.length === 5, 'hay 5 cartas comunitarias en showdown');

  const totalChipsBefore = 3000;
  state = Game.resolveHand(state);
  const totalChipsAfter = state.players.reduce((s, p) => s + p.chips, 0);
  assert(totalChipsAfter === totalChipsBefore, `fichas conservadas (${totalChipsAfter} === ${totalChipsBefore})`);
  assert(state.results && state.results.winners.length >= 1, 'hay al menos un ganador registrado');
  console.log('  Ganador(es):', state.results.winners);
})();

// ---------- Escenario 2: todos se retiran menos uno (sin llegar a showdown) ----------
(function scenario2() {
  let state = Game.createInitialState(
    [{ uid: 'a', name: 'Ana', chips: 500 }, { uid: 'b', name: 'Beto', chips: 500 }, { uid: 'c', name: 'Caro', chips: 500 }],
    { smallBlind: 5, bigBlind: 10 }
  );
  let r = Game.startNewHand(state);
  state = r.state;
  let guard = 0;
  while (state.phase !== 'handover' && guard < 20) {
    guard++;
    const turnUid = state.players[state.turnSeat].uid;
    const res = Game.applyAction(state, turnUid, 'fold', null);
    state = res.state;
  }
  assert(state.phase === 'handover', 'la mano termina en handover cuando todos se retiran menos uno');
  state = Game.resolveHand(state);
  const totalAfter = state.players.reduce((s, p) => s + p.chips, 0);
  assert(totalAfter === 1500, `fichas conservadas tras fold-out (${totalAfter} === 1500)`);
  assert(state.results.winners.length === 1, 'un solo ganador cuando los demás se retiran');
  console.log('  Ganador único:', state.results.winners);
})();

// ---------- Escenario 3: side pots con 3 jugadores de distinto stack (manual) ----------
(function scenario3() {
  // Construimos el estado post-mano manualmente para aislar buildPots/resolveHand
  let state = Game.createInitialState(
    [{ uid: 'short', name: 'Corto', chips: 100 }, { uid: 'mid', name: 'Medio', chips: 300 }, { uid: 'big', name: 'Grande', chips: 1000 }],
    { smallBlind: 10, bigBlind: 20 }
  );
  // Simular que ya se jugó la mano completa: short fue all-in por 100,
  // mid all-in por 300, big pagó 300 y se retiró... probemos con big igualando 300.
  state.players[0].totalContributed = 100; state.players[0].status = 'allin'; state.players[0].chips = 0;
  state.players[1].totalContributed = 300; state.players[1].status = 'allin'; state.players[1].chips = 0;
  state.players[2].totalContributed = 300; state.players[2].status = 'active'; state.players[2].chips = 700;
  // Cartas fijas para saber quién gana cada bote
  state.players[0].holeCards = ['Ah', 'Ad']; // par de ases -> debería ganar el bote principal
  state.players[1].holeCards = ['2c', '2d']; // par de doses
  state.players[2].holeCards = ['Kh', 'Kd']; // par de reyes -> debería ganar el side pot (contra 'mid' ya eliminado del side, pero compite con... )
  state.community = ['3h', '4h', '5d', '9c', 'Jc'];
  state.phase = 'showdown';

  const pots = Game.buildPots(state.players);
  // Bote principal: 100*3 = 300 (elegibles: los 3). Side pot: (300-100)*2=400 (elegibles: mid y big)
  assert(pots.length === 2, `hay 2 botes (principal + side pot), hubo ${pots.length}`);
  assert(pots[0].amount === 300, `bote principal de 300 (fue ${pots[0].amount})`);
  assert(pots[1].amount === 400, `side pot de 400 (fue ${pots[1].amount})`);
  assert(pots[0].eligible.length === 3, 'los 3 jugadores son elegibles al bote principal');
  assert(pots[1].eligible.sort().join(',') === 'big,mid', 'solo mid y big son elegibles al side pot');

  const resolved = Game.resolveHand(state);
  const short = resolved.players.find((p) => p.uid === 'short');
  const mid = resolved.players.find((p) => p.uid === 'mid');
  const big = resolved.players.find((p) => p.uid === 'big');
  // short tenía par de ases -> gana el bote principal (300) -> chips: 0 (ya apostó todo) + 300 = 300
  assert(short.chips === 300, `'short' gana el bote principal con par de ases (chips=${short.chips})`);
  // big tenía par de reyes, mejor que mid (par de doses) -> gana el side pot (400)
  // big ya había apostado 300 de sus 1000 (700 restantes) + gana 400 = 1100
  assert(big.chips === 1100, `'big' gana el side pot con par de reyes (chips=${big.chips})`);
  assert(mid.chips === 0, `'mid' no gana nada (chips=${mid.chips})`);
  const total = resolved.players.reduce((s, p) => s + p.chips, 0);
  // ojo: chips ya reflejan solo lo que NO se apostó (totalContributed ya se restó conceptualmente
  // porque nunca se dedujo de .chips en este test manual) + lo ganado.
  console.log('  Chips finales:', short.chips, mid.chips, big.chips, '(total nominal:', total, ')');
  console.log('  Resultados showdown:', resolved.results.winners);
})();

// ---------- Escenario 4: empate exacto divide el bote (con chip impar) ----------
(function scenario4() {
  let state = Game.createInitialState(
    [{ uid: 'a', name: 'Ana', chips: 0 }, { uid: 'b', name: 'Beto', chips: 0 }],
    { smallBlind: 10, bigBlind: 20 }
  );
  state.players[0].totalContributed = 101; state.players[0].status = 'active';
  state.players[1].totalContributed = 101; state.players[1].status = 'active';
  state.players[0].holeCards = ['Ah', 'Kd'];
  state.players[1].holeCards = ['As', 'Kc'];
  state.community = ['2h', '7d', '9d', 'Jc', '4s']; // ambos juegan A K carta alta, empate exacto
  state.dealerSeat = 0;
  const resolved = Game.resolveHand(state);
  const total = resolved.players.reduce((s, p) => s + p.chips, 0);
  assert(total === 202, `bote de 202 repartido completo (total=${total})`);
  const a = resolved.players.find((p) => p.uid === 'a').chips;
  const b = resolved.players.find((p) => p.uid === 'b').chips;
  assert(Math.abs(a - b) <= 1, `empate se reparte casi igual (a=${a}, b=${b})`);
  console.log('  Empate repartido:', a, b);
})();

console.log('\nTODOS LOS ESCENARIOS EJECUTADOS');

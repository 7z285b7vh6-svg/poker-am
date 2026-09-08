const Game = require('./js/game.js');
const Bot = require('./js/bot.js');

function playHandToCompletion(state, log) {
  let guard = 0;
  while (state.phase !== 'showdown' && state.phase !== 'handover' && guard < 200) {
    guard++;
    const turnUid = state.players[state.turnSeat].uid;
    const decision = Bot.decideAction(state, turnUid);
    if (!['fold', 'check', 'call', 'raise', 'allin'].includes(decision.action)) {
      throw new Error('Acción inválida devuelta por el bot: ' + JSON.stringify(decision));
    }
    const res = Game.applyAction(state, turnUid, decision.action, decision.amount);
    if (res.error) {
      throw new Error(`El motor rechazó una acción del bot (${decision.action} ${decision.amount}) en fase ${state.phase}: ${res.error}`);
    }
    state = res.state;
    if (state.autoRunOut) {
      let g2 = 0;
      while (state.autoRunOut && g2 < 10) { g2++; state = Game.continueAutoRunOut(state); }
    }
  }
  if (guard >= 200) throw new Error('La mano no terminó tras 200 acciones — posible ciclo infinito');
  return state;
}

const NUM_HANDS = 300;
const NUM_PLAYERS = 5;
let state = Game.createInitialState(
  Array.from({ length: NUM_PLAYERS }, (_, i) => ({ uid: 'p' + i, name: 'Bot' + i, chips: 1000 })),
  { smallBlind: 10, bigBlind: 20 }
);

let handsPlayed = 0;
for (let h = 0; h < NUM_HANDS; h++) {
  if (Game.activePlayerCount(state) < 2) break;
  const r = Game.startNewHand(state);
  if (r.error) { console.log('Fin de la partida:', r.error); break; }
  state = r.state;
  state = playHandToCompletion(state, []);
  state = Game.resolveHand(state);
  handsPlayed++;
  const total = state.players.reduce((s, p) => s + p.chips, 0);
  if (total !== NUM_PLAYERS * 1000) {
    throw new Error(`¡Fichas no cuadran en la mano #${h + 1}! total=${total}, esperado=${NUM_PLAYERS * 1000}`);
  }
}

console.log(`OK: ${handsPlayed} manos completas jugadas por bots sin errores, fichas siempre cuadraron.`);
console.log('Fichas finales:', state.players.map((p) => `${p.name}:${p.chips}`).join('  '));

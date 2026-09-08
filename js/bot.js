/*
 * bot.js — Un jugador con IA heurística (no es un solver perfecto de poker,
 * pero razona con fuerza de mano, cuentas del bote y algo de farol) para que
 * puedas llenar una sala tú solo y encontrar bugs jugando contra él.
 *
 * Corre ÚNICAMENTE en el navegador del anfitrión (igual que el resto del
 * motor): recibe el mismo objeto de estado que usa game.js y decide qué
 * acción tomar. No conoce Firebase ni el DOM.
 */
(function (root, factory) {
  const mod = factory(
    typeof module === 'object' && module.exports ? require('./handEvaluator.js') : root.PokerEval
  );
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.PokerBot = mod;
  }
})(typeof self !== 'undefined' ? self : this, function (PokerEval) {

  function rankValue(card) {
    return PokerEval.rankValue(card);
  }

  // Estima qué tan buena es la mano SOLO con las 2 cartas propias (preflop).
  // No es una tabla exacta de equity, es una aproximación razonable: premia
  // pares, cartas altas, parejas del mismo palo y conectores.
  function preflopStrength(holeCards) {
    const r1 = rankValue(holeCards[0]);
    const r2 = rankValue(holeCards[1]);
    const suited = holeCards[0][1] === holeCards[1][1];
    const hi = Math.max(r1, r2);
    const lo = Math.min(r1, r2);
    let score = (hi / 14) * 0.55 + (lo / 14) * 0.35;
    if (r1 === r2) score += 0.30 + (hi / 14) * 0.15; // pares, mejor cuanto más alto
    if (suited) score += 0.08;
    const gap = hi - lo;
    if (gap === 0) { /* ya contado arriba como par */ }
    else if (gap === 1) score += 0.06;
    else if (gap === 2) score += 0.03;
    return Math.min(1, score);
  }

  // Con cartas comunitarias en la mesa, usa el evaluador real de manos y
  // traduce la categoría (0=carta alta .. 8=escalera de color) a un puntaje.
  function postflopStrength(holeCards, community) {
    const result = PokerEval.evaluateBest([...holeCards, ...community]);
    const base = result.cat / 8;
    const kicker = (result.tiebreak[0] || 0) / 14;
    return Math.min(1, base * 0.88 + kicker * 0.12);
  }

  function estimateStrength(state, player) {
    if (!state.community || state.community.length === 0) {
      return preflopStrength(player.holeCards);
    }
    return postflopStrength(player.holeCards, state.community);
  }

  function clampToValidRaise(state, player, desiredTotal) {
    const tableBet = state.currentBet || 0;
    const maxTotal = player.currentBet + player.chips;
    const minRaiseTotal = Math.min(maxTotal, tableBet + (state.minRaise || state.bigBlind || 20));
    return Math.max(minRaiseTotal, Math.min(maxTotal, Math.round(desiredTotal)));
  }

  // Devuelve { action, amount } — amount solo importa para 'raise'/'allin'.
  function decideAction(state, uid) {
    const player = state.players.find((p) => p.uid === uid);
    if (!player) return { action: 'fold', amount: null };

    const tableBet = state.currentBet || 0;
    const myBet = player.currentBet || 0;
    const callAmount = tableBet - myBet;
    const potNow = state.players.reduce((s, p) => s + (p.totalContributed || 0), 0);

    const baseStrength = estimateStrength(state, player);
    const bluffing = Math.random() < 0.05;
    const noise = (Math.random() - 0.5) * 0.14;
    const strength = Math.min(1, Math.max(0, baseStrength + noise + (bluffing ? 0.22 : 0)));

    // --- Nadie apostó todavía esta calle: puedo pasar gratis o apostar ---
    if (callAmount <= 0) {
      if (strength > 0.68 && player.chips > 0 && Math.random() < 0.55) {
        const sizing = 0.35 + Math.random() * 0.35; // entre ~35% y 70% del bote
        const desired = tableBet + Math.max(state.bigBlind || 20, Math.round(potNow * sizing));
        const amount = clampToValidRaise(state, player, desired);
        if (amount > tableBet) return { action: 'raise', amount };
      }
      return { action: 'check', amount: null };
    }

    // --- Hay que pagar algo para seguir en la mano ---
    const potOdds = callAmount / (potNow + callAmount);
    const allInIfCall = callAmount >= player.chips;

    if (strength < 0.28 || (strength < potOdds * 0.9 && strength < 0.45)) {
      // Mano floja frente a una apuesta que no compensa: normalmente se retira,
      // salvo que ya haya invertido tanto que igualar sea casi gratis.
      if (callAmount > player.chips * 0.35 || strength < 0.18) {
        return { action: 'fold', amount: null };
      }
    }

    if (strength > 0.85 && !allInIfCall && Math.random() < 0.30) {
      const desired = tableBet + Math.max(state.minRaise || state.bigBlind || 20, Math.round((potNow + callAmount) * 0.55));
      const amount = clampToValidRaise(state, player, desired);
      if (amount > tableBet) return { action: 'raise', amount };
    }

    if (allInIfCall) return { action: 'allin', amount: null };
    return { action: 'call', amount: null };
  }

  return { decideAction, estimateStrength, preflopStrength, postflopStrength };
});

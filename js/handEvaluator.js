/*
 * handEvaluator.js — Evalúa la mejor mano de 5 cartas entre 7 (2 propias + 5
 * comunitarias) para Texas Hold'em. Sin dependencias externas.
 * Funciona en navegador (window.PokerEval) y en Node (module.exports).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.PokerEval = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const RANK_ORDER = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  const CATEGORY_NAMES = [
    'Carta alta', 'Par', 'Doble par', 'Trío', 'Escalera',
    'Color', 'Full house', "Póker", 'Escalera de color'
  ];

  function rankValue(card) {
    return RANK_ORDER.indexOf(card[0]) + 2; // 2..14
  }
  function suitOf(card) {
    return card[1];
  }

  function combinations5of7(cards7) {
    const result = [];
    const n = cards7.length; // 7
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        for (let c = b + 1; c < n; c++) {
          for (let d = c + 1; d < n; d++) {
            for (let e = d + 1; e < n; e++) {
              result.push([cards7[a], cards7[b], cards7[c], cards7[d], cards7[e]]);
            }
          }
        }
      }
    }
    return result;
  }

  function evaluate5(cards) {
    const ranks = cards.map(rankValue);
    const suits = cards.map(suitOf);
    const isFlush = suits.every((s) => s === suits[0]);
    const sortedDesc = [...ranks].sort((x, y) => y - x);
    const uniqueRanksDesc = [...new Set(sortedDesc)];

    let straightHigh = null;
    if (uniqueRanksDesc.length === 5) {
      if (uniqueRanksDesc[0] - uniqueRanksDesc[4] === 4) {
        straightHigh = uniqueRanksDesc[0];
      } else if (uniqueRanksDesc[0] === 14 && uniqueRanksDesc[1] === 5 &&
                 uniqueRanksDesc[2] === 4 && uniqueRanksDesc[3] === 3 && uniqueRanksDesc[4] === 2) {
        straightHigh = 5; // escalera "rueda" A-2-3-4-5, el as juega bajo
      }
    }

    const freq = {};
    for (const r of ranks) freq[r] = (freq[r] || 0) + 1;
    const groups = Object.entries(freq)
      .map(([r, c]) => ({ rank: Number(r), count: c }))
      .sort((a, b) => b.count - a.count || b.rank - a.rank);

    if (straightHigh && isFlush) return { cat: 8, tiebreak: [straightHigh] };
    if (groups[0].count === 4) {
      const kicker = groups[1].rank;
      return { cat: 7, tiebreak: [groups[0].rank, kicker] };
    }
    if (groups[0].count === 3 && groups[1] && groups[1].count === 2) {
      return { cat: 6, tiebreak: [groups[0].rank, groups[1].rank] };
    }
    if (isFlush) return { cat: 5, tiebreak: sortedDesc };
    if (straightHigh) return { cat: 4, tiebreak: [straightHigh] };
    if (groups[0].count === 3) {
      const kickers = groups.slice(1).map((g) => g.rank).sort((a, b) => b - a);
      return { cat: 3, tiebreak: [groups[0].rank, ...kickers] };
    }
    if (groups[0].count === 2 && groups[1] && groups[1].count === 2) {
      const pairRanks = [groups[0].rank, groups[1].rank].sort((a, b) => b - a);
      const kicker = groups[2].rank;
      return { cat: 2, tiebreak: [...pairRanks, kicker] };
    }
    if (groups[0].count === 2) {
      const kickers = groups.slice(1).map((g) => g.rank).sort((a, b) => b - a);
      return { cat: 1, tiebreak: [groups[0].rank, ...kickers] };
    }
    return { cat: 0, tiebreak: sortedDesc };
  }

  // Devuelve 1 si a > b, -1 si a < b, 0 si empate.
  function compareScore(a, b) {
    if (a.cat !== b.cat) return a.cat > b.cat ? 1 : -1;
    const len = Math.max(a.tiebreak.length, b.tiebreak.length);
    for (let i = 0; i < len; i++) {
      const av = a.tiebreak[i] || 0;
      const bv = b.tiebreak[i] || 0;
      if (av !== bv) return av > bv ? 1 : -1;
    }
    return 0;
  }

  // cards: array de 5,6 o 7 cartas (strings). Devuelve la mejor combinación de 5.
  function evaluateBest(cards) {
    if (cards.length < 5) throw new Error('Se necesitan al menos 5 cartas');
    let best = null;
    let bestCards = null;
    const combos = cards.length === 5 ? [cards] : combinations5of7(cards);
    for (const combo of combos) {
      const score = evaluate5(combo);
      if (!best || compareScore(score, best) > 0) {
        best = score;
        bestCards = combo;
      }
    }
    return { ...best, cards: bestCards, name: CATEGORY_NAMES[best.cat] };
  }

  return { evaluate5, evaluateBest, compareScore, CATEGORY_NAMES, rankValue, suitOf };
});

/*
 * deck.js — Baraja de 52 cartas, barajado seguro y utilidades.
 * Carta representada como string de 2 chars: rango + palo.
 * Rangos: 2 3 4 5 6 7 8 9 T J Q K A
 * Palos:  s (spades) h (hearts) d (diamonds) c (clubs)
 * Funciona tanto en navegador (window.PokerDeck) como en Node (module.exports).
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.PokerDeck = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  const SUITS = ['s', 'h', 'd', 'c'];

  function createDeck() {
    const deck = [];
    for (const r of RANKS) {
      for (const s of SUITS) {
        deck.push(r + s);
      }
    }
    return deck;
  }

  // Fisher-Yates shuffle usando crypto.getRandomValues cuando está disponible
  // (navegador), con fallback a Math.random (p.ej. en Node para tests).
  function secureRandomInt(maxExclusive) {
    const cryptoObj = (typeof crypto !== 'undefined' && crypto.getRandomValues)
      ? crypto
      : (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues)
        ? globalThis.crypto
        : null;
    if (cryptoObj) {
      const range = 0x100000000;
      const limit = range - (range % maxExclusive);
      let x;
      do {
        const buf = new Uint32Array(1);
        cryptoObj.getRandomValues(buf);
        x = buf[0];
      } while (x >= limit);
      return x % maxExclusive;
    }
    return Math.floor(Math.random() * maxExclusive);
  }

  function shuffle(deckIn) {
    const deck = deckIn.slice();
    for (let i = deck.length - 1; i > 0; i--) {
      const j = secureRandomInt(i + 1);
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  function freshShuffledDeck() {
    return shuffle(createDeck());
  }

  function rankValue(card) {
    return RANKS.indexOf(card[0]) + 2; // 2..14
  }

  function suitOf(card) {
    return card[1];
  }

  return { createDeck, shuffle, freshShuffledDeck, rankValue, suitOf, RANKS, SUITS };
});

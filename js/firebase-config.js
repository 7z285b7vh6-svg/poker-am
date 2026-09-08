/*
 * firebase-config.js — Reemplaza estos valores con los de TU proyecto de
 * Firebase (Configuración del proyecto ⚙️ → General → "Tus apps" → SDK config).
 *
 * IMPORTANTE: este archivo se sube al repositorio público de GitHub. Eso es
 * normal y seguro: la "config" de Firebase para apps web NO es secreta, es un
 * identificador público. La seguridad real la dan las Reglas de la Realtime
 * Database (database.rules.json) y el hecho de que la autenticación anónima
 * esté activada. Aun así, revisa siempre las reglas antes de compartir la
 * app ampliamente.
 */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyBvvK7AyYZ4nnQe1Xq6cdMEKkpoXbPzTuo",
  authDomain: "poker-d279c.firebaseapp.com",
  databaseURL: "https://poker-d279c-default-rtdb.firebaseio.com",
  projectId: "poker-d279c",
  storageBucket: "poker-d279c.firebasestorage.app",
  messagingSenderId: "784523187646",
  appId: "1:784523187646:web:e9817eea3b1a554a73d5ef"
};

// Inicializa la app de Firebase con esa configuración. Esto debe correr
// ANTES de firebase-adapter.js (que ya asume que firebase.database()/auth()
// están listos para usarse).
firebase.initializeApp(window.FIREBASE_CONFIG);

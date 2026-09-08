# Texas Hold'em con amigos 🂡

Poker Texas Hold'em en tiempo real, para jugar entre 2 y 5 amigos desde el
navegador. Tú creas la sala, defines cuántas fichas empieza cada quien, y
listo: se reparte, se apuesta, se calculan los botes (incluyendo botes
laterales cuando alguien va all-in) y se reparten las ganancias
automáticamente, todo sincronizado al instante con Firebase Realtime Database.

No requiere cuentas, contraseñas ni backend propio: solo un proyecto de
Firebase (gratis) y GitHub Pages (gratis) para alojar los archivos.

## Cómo está armado (por si te interesa)

- **`js/deck.js`** — baraja de 52 cartas y barajado.
- **`js/handEvaluator.js`** — evalúa la mejor mano de 5 cartas entre 7.
- **`js/game.js`** — el motor de reglas completo (ciegas, turnos, subidas,
  botes principales/laterales, showdown). Es código puro, sin Firebase ni
  DOM — por eso se pudo probar automáticamente (ver `test-game.js`).
- **`js/firebase-adapter.js`** — conecta ese motor con Firebase. **Corre
  únicamente en el navegador de quien creó la sala** (el "anfitrión"): es
  quien de verdad reparte las cartas y aplica las reglas. Los demás
  jugadores solo mandan "quiero retirarme / igualar / subir a X" y reciben
  el estado público de la mesa.
- **`js/ui.js` / `js/app.js`** — la interfaz visual y el cableado de botones.
- **`database.rules.json`** — reglas de seguridad: cada quien solo puede leer
  sus propias cartas; el resto de la mesa es pública para los jugadores de
  esa sala.

### Modelo de confianza

Este proyecto está pensado para jugar **entre amigos**, no para un torneo
anti-trampas. El anfitrión tiene, técnicamente, la capacidad de ver el mazo
completo si abre la consola del navegador. Las reglas de Firebase sí evitan
que un jugador cualquiera pueda leer las cartas de otro jugador o modificar
las fichas ajenas, pero no hay forma de impedir que quien reparte "haga
trampa" mirando su propio código — igual que en una partida casera con
cartas físicas, confías en quien reparte. Si algún día quieres una versión
"a prueba de anfitrión tramposo", el reparto tendría que moverse a un backend
neutral (p. ej. Cloud Functions), que no está incluido aquí para mantener
todo en el plan gratuito de Firebase.

También: **si el anfitrión cierra la pestaña, la partida se congela** (nadie
más puede repartir). Para partidas largas, que el anfitrión tenga buena
conexión y no cierre la pestaña.

---

## 1. Crea tu proyecto de Firebase (una sola vez)

1. Ve a [console.firebase.google.com](https://console.firebase.google.com) y
   crea un proyecto nuevo (el nombre no importa).
2. En el menú lateral, entra a **Compilación → Authentication** → pestaña
   "Sign-in method" → habilita **Anónimo**. (Así cada jugador tiene una
   identidad única sin necesidad de registrarse.)
3. Entra a **Compilación → Realtime Database** → **Crear base de datos**.
   Elige la ubicación que te quede más cerca. Cuando pregunte el modo de
   seguridad, cualquiera está bien — las reglas de abajo las vamos a
   reemplazar de todas formas.
4. Ve a la pestaña **Reglas** de esa misma Realtime Database, borra lo que
   haya y pega el contenido completo del archivo [`database.rules.json`](./database.rules.json)
   de este proyecto. Dale **Publicar**.
5. Ve a **Configuración del proyecto** (el engranaje ⚙️ junto a "Descripción
   general del proyecto") → pestaña **General** → baja hasta "Tus apps" →
   clic en el ícono **`</>`** (Web) → dale un apodo → **Registrar app**.
   Firebase te muestra un bloque `firebaseConfig = {...}`: copia esos
   valores.
6. Abre [`js/firebase-config.js`](./js/firebase-config.js) en este proyecto y
   reemplaza los valores de ejemplo por los tuyos. Guarda el archivo.

Ese archivo con la configuración **sí se sube a GitHub sin problema**: no es
una contraseña, es solo un identificador público de tu proyecto. La
seguridad real la dan las reglas del paso 4 y que la autenticación anónima
esté activada.

## 2. Sube el proyecto a GitHub

Si ya tienes este código en una carpeta local:

```bash
git init
git add .
git commit -m "Texas Hold'em con amigos"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git push -u origin main
```

## 3. Activa GitHub Pages

1. En tu repositorio de GitHub, ve a **Settings → Pages**.
2. En "Build and deployment", elige **Deploy from a branch**.
3. Rama: **main**, carpeta: **/ (root)**. Guarda.
4. En un minuto te dará una URL como
   `https://tu_usuario.github.io/tu_repo/` — esa es la liga que compartes
   con tus amigos.

(Si prefieres usar Firebase Hosting en vez de GitHub Pages, este proyecto
también incluye `firebase.json`. Con la [CLI de Firebase](https://firebase.google.com/docs/cli)
instalada: `firebase login`, renombra `.firebaserc.example` a `.firebaserc`
y pon tu Project ID, luego `firebase deploy`. La CLI también te sirve para
subir las reglas de la base de datos con `firebase deploy --only database`
en vez de pegarlas a mano en la consola.)

## 4. Juega

1. Abre la URL. Quien vaya a ser el anfitrión elige **Crear sala**, pone su
   nombre, cuántas fichas empieza cada jugador, las ciegas, y el máximo de
   jugadores (2 a 5).
2. Comparte el código de 5 letras que aparece con tus amigos (por WhatsApp,
   Discord, lo que sea — la app no manda invitaciones).
3. Cada amigo abre la misma URL, elige **Unirse a sala**, pone su nombre y
   el código.
4. Cuando estén todos, el anfitrión da clic en **Iniciar partida**.
5. Se juega en tiempo real: cartas, apuestas, botes y ganador se calculan
   solos. Al terminar una mano, la siguiente arranca sola a los pocos
   segundos (o el anfitrión puede saltarla con "Siguiente mano ▶").
6. Si alguien se queda sin fichas, sigue viendo la mesa pero ya no reparte
   en las manos siguientes. Cuando solo quede un jugador con fichas, la
   partida termina y se muestra la tabla final.
7. Si alguien recarga la página o pierde la conexión, al volver a entrar con
   el mismo enlace recupera su lugar en la sala automáticamente.

## Probar la lógica del juego

El motor de reglas (`js/game.js`) es código puro de JavaScript y se puede
correr y probar con Node, sin necesidad de navegador ni de Firebase:

```bash
node test-game.js
```

Corre varios escenarios (mano completa hasta el showdown, alguien se retira
antes del río, botes laterales con jugadores all-in de distinto tamaño de
stack, empates) y verifica que las fichas siempre cuadren.

## Estructura del proyecto

```
index.html               Página única (inicio / lobby / mesa / fin)
css/style.css             Todos los estilos
js/deck.js                Baraja y barajado
js/handEvaluator.js       Evaluador de manos de poker
js/game.js                Motor de reglas (puro, testeable)
js/firebase-adapter.js    Conecta el motor con Firebase (solo lo usa el host)
js/firebase-config.js     ← aquí pegas tu configuración de Firebase
js/ui.js                  Renderizado de la mesa
js/app.js                 Pantallas y cableado de botones
database.rules.json       Reglas de seguridad de Realtime Database
firebase.json             (opcional) config para Firebase Hosting/CLI
test-game.js              Pruebas del motor de reglas
```

## Ideas para seguir mejorando

- Reconexión automática del anfitrión desde otro dispositivo si cierra la
  pestaña (requeriría mover el reparto a Cloud Functions).
- Chat de texto entre jugadores.
- Historial de manos descargable.
- Estadísticas por jugador entre partidas.

¡Disfruta la partida! 🃏

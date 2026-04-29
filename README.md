# MyBuddy Server

MyBuddy es una aplicación de chat web en tiempo real estilo WhatsApp. Permite a los usuarios registrarse, ver un directorio con todos los demás usuarios registrados y mantener conversaciones uno a uno con mensajes de texto e imágenes.

El proyecto se compone de un servidor Node.js que sirve el cliente web estático y enruta eventos en tiempo real por WebSocket, junto con un cliente HTML/JS que utiliza Firebase para autenticación y persistencia de mensajes.

---

## Arquitectura general

```
┌─────────────────┐         WebSocket          ┌─────────────────┐
│  Cliente Web    │ ◄────── presencia ──────► │                 │
│  (public/*.js)  │ ◄──────  typing   ──────► │  Server Node.js │
│                 │                            │  (server.js)    │
└────────┬────────┘                            └─────────────────┘
         │
         │ Firebase SDK
         ▼
┌─────────────────────────────────┐
│  Firebase                       │
│  ├── Auth (email + contraseña)  │
│  └── Firestore                  │
│       ├── users/                │
│       ├── usernames/            │
│       └── conversations/        │
│            └── messages/        │
└─────────────────────────────────┘
```

- **Firebase Auth** se encarga del registro e inicio de sesión.
- **Firestore** guarda los perfiles de usuarios y el historial de mensajes (texto e imágenes en base64).
- **WebSocket** se usa únicamente para señales en tiempo real que no requieren persistencia: presencia (conectado/desconectado) y typing indicator.

---

## Estructura del proyecto

```
MyBuddy-Server/
├── server.js          Servidor Express + WebSocket
├── package.json       Dependencias y scripts
└── public/
    ├── index.html     Estructura de las pantallas (auth, directorio, chat)
    ├── styles.css     Estilos visuales (paleta verde estilo WhatsApp)
    └── app.js         Lógica del cliente (Firebase + WebSocket)
```

---

## Requisitos

- **Node.js** 16 o superior
- **npm**
- Un proyecto de **Firebase** con Authentication (email/password) y Firestore habilitados

---

## Instalación y ejecución

```bash
# 1. Clonar el repositorio
git clone <url-del-repo>
cd MyBuddy-Server

# 2. Instalar dependencias
npm install

# 3. Configurar Firebase
# Edita public/app.js y reemplaza el objeto firebaseConfig con
# la configuración de tu propio proyecto de Firebase.

# 4. Iniciar el servidor
npm start
```

El servidor queda escuchando en `http://localhost:3000` por defecto. Para usar otro puerto:

```bash
PORT=8080 npm start
```

---

## Configuración de Firebase

En la consola de Firebase:

1. Crea un proyecto nuevo.
2. Activa **Authentication** → método de inicio de sesión **Correo electrónico/Contraseña**.
3. Crea una base de datos **Firestore** en modo producción o test.
4. En **Configuración del proyecto → Tus apps → Web**, registra una app y copia el `firebaseConfig`.
5. Pega esa configuración en `public/app.js`, en la constante `firebaseConfig`.

### Reglas de Firestore sugeridas

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && request.auth.uid == uid;
    }
    match /usernames/{username} {
      allow read: if request.auth != null;
      allow write: if request.auth != null;
    }
    match /conversations/{convId}/messages/{msgId} {
      allow read, write: if request.auth != null
        && convId.split('_').hasAny([request.auth.uid]);
    }
  }
}
```

---

## Modelo de datos en Firestore

### Colección `users/{uid}`
Perfil de cada usuario.
```json
{
  "username": "noel",
  "email": "noel@example.com",
  "description": "",
  "phoneNumber": "",
  "createdAt": Timestamp
}
```

### Colección `usernames/{username}`
Índice de unicidad de nombres de usuario.
```json
{ "uid": "abc123..." }
```

### Colección `conversations/{convId}/messages/{msgId}`
Mensajes de cada conversación. El `convId` es la concatenación ordenada alfabéticamente de los dos UIDs unidos por `_`.

Mensaje de texto:
```json
{
  "type": "text",
  "sender": "uidA",
  "recipient": "uidB",
  "content": "Hola!",
  "timestamp": 1714419600000
}
```

Mensaje de imagen:
```json
{
  "type": "image",
  "sender": "uidA",
  "recipient": "uidB",
  "content": "<base64...>",
  "mimeType": "image/jpeg",
  "timestamp": 1714419600000
}
```

---

## Protocolo WebSocket

El servidor expone un único endpoint WebSocket en la misma URL del servidor (`ws://localhost:3000` o `wss://...` en producción). Todos los mensajes se envían como JSON.

### Cliente → Servidor

**Identificación (obligatorio al conectar):**
```json
{ "type": "identify", "userId": "<uid del usuario>" }
```

**Notificación de typing:**
```json
{ "type": "typing", "from": "<mi uid>", "to": "<uid del contacto>" }
```

> Cualquier mensaje que incluya el campo `to` será reenviado tal cual al destinatario indicado, si está conectado.

### Servidor → Cliente

**Contacto conectado:**
```json
{ "type": "peer_connected", "userId": "<uid>" }
```

**Contacto desconectado:**
```json
{ "type": "peer_disconnected", "userId": "<uid>" }
```

**Reenvío de typing:**
```json
{ "type": "typing", "from": "<uid>", "to": "<uid>", "timestamp": 1714419600000 }
```

### Heartbeat

El servidor envía un `ping` a cada cliente cada 30 segundos. Si el cliente no responde con `pong` en el siguiente ciclo, la conexión se termina automáticamente.

---

## Endpoints HTTP

### `GET /health`
Devuelve el estado del servidor en JSON.
```json
{
  "status": "ok",
  "uptime": 123.45,
  "connectedUsers": 3
}
```

### Archivos estáticos
Cualquier ruta no reservada sirve los archivos de `public/` (`index.html`, `styles.css`, `app.js`).

---

## Pantallas de la aplicación

1. **Pantalla de autenticación** — paneles de login y registro con validación en cliente.
2. **Directorio** — lista de todos los usuarios registrados, con buscador en vivo por username o email.
3. **Chat** — historial de la conversación, envío de texto e imágenes, indicador de presencia y typing, lightbox para imágenes.

---

## Decisiones técnicas

- **Firestore para los mensajes** garantiza persistencia y sincronización offline-first sin que el servidor tenga que mantener estado de mensajes.
- **WebSocket sólo para señales efímeras** (presencia y typing), evitando complejidad y carga innecesaria en el servidor.
- **`conversationId` determinístico** (UIDs ordenados y unidos por `_`) hace que ambos extremos calculen el mismo identificador sin necesidad de coordinación.
- **Username único** mediante una colección espejo `usernames/{username}` escrita en un batch atómico junto con el documento del usuario.
- **Reconexión automática** del WebSocket cada 3 segundos cuando se cae la conexión y todavía hay un chat abierto.

---

## Scripts disponibles

| Script        | Descripción                       |
|---------------|-----------------------------------|
| `npm start`   | Inicia el servidor en el puerto 3000 (o `PORT`). |

---

## Licencia

Proyecto de uso interno / educativo.

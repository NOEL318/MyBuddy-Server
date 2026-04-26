const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Mapa de userId → WebSocket para enrutar mensajes entre usuarios específicos
const clients = new Map();

// Formatea la fecha actual para los logs
function timestamp() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function log(msg) {
    console.log(`[${timestamp()}] ${msg}`);
}

// Endpoint de salud
app.get('/health', (req, res) => {
    res.json({
        status:         'ok',
        uptime:         process.uptime(),
        connectedUsers: clients.size
    });
});

// Maneja cada nueva conexión WebSocket
wss.on('connection', (ws) => {
    let userId = null;

    log('[Server] Nueva conexión WebSocket');

    // Heartbeat: detecta conexiones colgadas cada 30 segundos
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch (e) {
            log(`[Server] Mensaje inválido: ${e.message}`);
            return;
        }

        // Registro e identificación del cliente por userId
        if (message.type === 'identify') {
            userId = message.userId;
            if (!userId) {
                log('[Server] Identify sin userId, ignorando');
                return;
            }

            // Reemplaza conexión anterior del mismo usuario si existía
            const existing = clients.get(userId);
            if (existing && existing !== ws) {
                log(`[Server] Reemplazando conexión anterior de ${userId}`);
                existing.terminate();
            }

            clients.set(userId, ws);
            log(`[Server] Cliente identificado: ${userId} (total conectados: ${clients.size})`);

            // Notifica a todos los demás clientes que este usuario está conectado
            clients.forEach((client, uid) => {
                if (uid !== userId && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'peer_connected', userId }));
                }
            });
            return;
        }

        // Enruta el mensaje al destinatario indicado en el campo 'to'
        const targetId = message.to;
        if (!targetId) {
            log(`[Server] Mensaje de ${userId} sin campo 'to', descartado`);
            return;
        }

        const target = clients.get(targetId);
        if (target && target.readyState === WebSocket.OPEN) {
            if (!message.timestamp) message.timestamp = Date.now();
            target.send(JSON.stringify(message));
            const preview = message.type === 'text'
                ? `"${String(message.content || '').substring(0, 40)}"`
                : '[imagen]';
            log(`[Server] ${userId} → ${targetId}: ${message.type} ${preview}`);
        } else {
            log(`[Server] Destinatario ${targetId} no conectado, mensaje descartado`);
        }
    });

    // Elimina al cliente y notifica a los demás que se desconectó
    ws.on('close', () => {
        if (userId) {
            if (clients.get(userId) === ws) {
                clients.delete(userId);
            }
            log(`[Server] Cliente desconectado: ${userId} (restantes: ${clients.size})`);

            clients.forEach((client, uid) => {
                if (uid !== userId && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'peer_disconnected', userId }));
                }
            });
        }
    });

    ws.on('error', (err) => {
        log(`[Server] Error WebSocket (${userId || 'desconocido'}): ${err.message}`);
    });
});

// Ping periódico para detectar conexiones muertas
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            log('[Server] Terminando conexión sin respuesta de heartbeat');
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30_000);

wss.on('close', () => clearInterval(heartbeatInterval));

// Inicia el servidor HTTP
server.listen(process.env.PORT || 3000, () => {
    log(`[Server] MyBuddy corriendo en http://localhost:${process.env.PORT || 3000}`);
});

// Servidor Node.js que sirve el cliente web estatico y enruta mensajes en tiempo real entre clientes a traves de WebSocket usando un userId como direccion
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const clients = new Map();

// Devuelve la fecha y hora actual en formato YYYY-MM-DD HH:MM:SS para usar en los logs
function timestamp() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

// Imprime un mensaje en la consola anteponiendo la marca de tiempo
function log(msg) {
    console.log(`[${timestamp()}] ${msg}`);
}

// Endpoint HTTP que reporta el estado del servidor, su uptime y la cantidad de usuarios conectados
app.get('/health', (req, res) => {
    res.json({
        status:         'ok',
        uptime:         process.uptime(),
        connectedUsers: clients.size
    });
});

// Maneja una nueva conexion WebSocket: identifica al cliente por userId, enruta sus mensajes al destinatario indicado y notifica eventos de presencia
wss.on('connection', (ws) => {
    let userId = null;

    log('[Server] Nueva conexion WebSocket');

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch (e) {
            log(`[Server] Mensaje invalido: ${e.message}`);
            return;
        }

        if (message.type === 'identify') {
            userId = message.userId;
            if (!userId) {
                log('[Server] Identify sin userId, ignorando');
                return;
            }

            const existing = clients.get(userId);
            if (existing && existing !== ws) {
                log(`[Server] Reemplazando conexion anterior de ${userId}`);
                existing.terminate();
            }

            clients.set(userId, ws);
            log(`[Server] Cliente identificado: ${userId} (total conectados: ${clients.size})`);

            clients.forEach((client, uid) => {
                if (uid !== userId && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'peer_connected', userId }));
                }
            });
            return;
        }

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
            log(`[Server] ${userId} -> ${targetId}: ${message.type} ${preview}`);
        } else {
            log(`[Server] Destinatario ${targetId} no conectado, mensaje descartado`);
        }
    });

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

// Envia un ping cada 30 segundos a todos los clientes y termina las conexiones que no hayan respondido al pong anterior
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            log('[Server] Terminando conexion sin respuesta de heartbeat');
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30_000);

wss.on('close', () => clearInterval(heartbeatInterval));

server.listen(process.env.PORT || 3000, () => {
    log(`[Server] MyBuddy corriendo en http://localhost:${process.env.PORT || 3000}`);
});

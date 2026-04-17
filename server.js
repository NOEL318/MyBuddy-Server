const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const clients = { ios: null, web: null };

// Maneja cada nueva conexión WebSocket, registra mensajes, desconexiones y errores
wss.on('connection', (ws) => {
    let clientType = null;

    console.log('[Server] Nueva conexión WebSocket');

    // Identifica el cliente entrante y reenvía sus mensajes al otro peer
    ws.on('message', (data) => {
        let message;
        try {
            message = JSON.parse(data.toString());
        } catch (e) {
            console.error('[Server] Mensaje inválido:', e.message);
            return;
        }

        if (message.type === 'identify') {
            clientType = message.clientType;
            clients[clientType] = ws;
            console.log(`[Server] Cliente identificado: ${clientType}`);
            const other = clientType === 'ios' ? clients.web : clients.ios;
            if (other && other.readyState === WebSocket.OPEN) {
                other.send(JSON.stringify({ type: 'peer_connected', sender: clientType }));
            }
            return;
        }

        const targetType = clientType === 'ios' ? 'web' : 'ios';
        const target = clients[targetType];

        if (target && target.readyState === WebSocket.OPEN) {
            target.send(JSON.stringify(message));
            const preview = message.type === 'text'
                ? `"${message.content.substring(0, 40)}"`
                : '[imagen]';
            console.log(`[Server] ${clientType} → ${targetType}: ${message.type} ${preview}`);
        } else {
            console.log(`[Server] ${targetType} no conectado, mensaje descartado`);
        }
    });

    // Elimina al cliente de la lista y notifica al otro peer que se desconectó
    ws.on('close', () => {
        if (clientType) {
            clients[clientType] = null;
            console.log(`[Server] Cliente desconectado: ${clientType}`);
            const other = clientType === 'ios' ? clients.web : clients.ios;
            if (other && other.readyState === WebSocket.OPEN) {
                other.send(JSON.stringify({ type: 'peer_disconnected', sender: clientType }));
            }
        }
    });

    // Registra errores de la conexión WebSocket
    ws.on('error', (err) => {
        console.error(`[Server] Error WebSocket (${clientType}):`, err.message);
    });
});

// Inicia el servidor HTTP en el puerto configurado por la plataforma o 3000
server.listen(process.env.PORT || 3000, () => {
    console.log(`[Server] MyBuddy corriendo en http://localhost:${process.env.PORT || 3000}`);
});

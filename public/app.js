const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

const messagesEl = document.getElementById('messages');
const statusEl = document.getElementById('status');
const textInput = document.getElementById('text-input');
const sendBtn = document.getElementById('send-btn');
const imageInput = document.getElementById('image-input');

const lightbox = document.createElement('div');
lightbox.id = 'lightbox';
const lightboxImg = document.createElement('img');
lightbox.appendChild(lightboxImg);
document.body.appendChild(lightbox);
lightbox.addEventListener('click', () => lightbox.classList.remove('open'));

let ws = null;
let reconnectTimer = null;

// Establece la conexión WebSocket con el servidor e inicia reconexión automática si se cierra
function connect() {
    clearTimeout(reconnectTimer);
    setStatus('Conectando...', '');

    ws = new WebSocket(WS_URL);

    ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'identify', clientType: 'web' }));
        setStatus('Esperando iPhone...', 'disconnected');
    });

    ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'peer_connected') {
            setStatus('iPhone conectado', 'connected');
            addSystemMessage('iPhone conectado');
            return;
        }
        if (msg.type === 'peer_disconnected') {
            setStatus('iPhone desconectado', 'disconnected');
            addSystemMessage('iPhone desconectado');
            return;
        }

        renderMessage(msg, false);
    });

    ws.addEventListener('close', () => {
        setStatus('Desconectado', 'disconnected');
        reconnectTimer = setTimeout(connect, 3000);
    });

    ws.addEventListener('error', () => {
        ws.close();
    });
}

// Actualiza el texto y la clase CSS del indicador de estado en el header
function setStatus(text, className) {
    statusEl.textContent = text;
    statusEl.className = className;
}

// Envía el texto del input como mensaje de texto al servidor
function sendText() {
    const text = textInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

    const msg = {
        type: 'text',
        sender: 'web',
        content: text,
        timestamp: Date.now()
    };

    ws.send(JSON.stringify(msg));
    renderMessage(msg, true);
    textInput.value = '';
}

// Lee el archivo seleccionado como base64 y lo envía como mensaje de imagen al servidor
function sendImage(file) {
    if (!file || !ws || ws.readyState !== WebSocket.OPEN) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        const base64 = e.target.result.split(',')[1];

        const msg = {
            type: 'image',
            sender: 'web',
            content: base64,
            mimeType: file.type,
            timestamp: Date.now()
        };

        ws.send(JSON.stringify(msg));
        renderMessage(msg, true);
    };
    reader.readAsDataURL(file);
}

// Crea y agrega una burbuja de mensaje (texto o imagen) al área de chat
function renderMessage(msg, isSent) {
    const msgEl = document.createElement('div');
    msgEl.className = `message ${isSent ? 'sent' : 'received'}`;

    const bubbleEl = document.createElement('div');
    bubbleEl.className = 'bubble';

    if (msg.type === 'text') {
        const textEl = document.createElement('span');
        textEl.className = 'bubble-text';
        textEl.textContent = msg.content;
        bubbleEl.appendChild(textEl);
    } else if (msg.type === 'image') {
        const mimeType = msg.mimeType || 'image/jpeg';
        const imgEl = document.createElement('img');
        imgEl.className = 'bubble-image';
        imgEl.src = `data:${mimeType};base64,${msg.content}`;
        imgEl.addEventListener('click', () => {
            lightboxImg.src = imgEl.src;
            lightbox.classList.add('open');
        });
        bubbleEl.appendChild(imgEl);
    }

    const timeEl = document.createElement('span');
    timeEl.className = 'timestamp';
    timeEl.textContent = formatTime(msg.timestamp);

    msgEl.appendChild(bubbleEl);
    msgEl.appendChild(timeEl);
    messagesEl.appendChild(msgEl);
    scrollToBottom();
}

// Muestra un mensaje de sistema centrado en el chat (ej: "iPhone conectado")
function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'system-message';
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
}

// Desplaza el contenedor de mensajes hasta el último mensaje
function scrollToBottom() {
    const container = document.getElementById('messages-container');
    container.scrollTop = container.scrollHeight;
}

// Convierte un timestamp en milisegundos a una cadena de hora en formato HH:MM
function formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

sendBtn.addEventListener('click', sendText);
textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendText();
    }
});
imageInput.addEventListener('change', (e) => {
    sendImage(e.target.files[0]);
    imageInput.value = '';
});

connect();

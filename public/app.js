// ─── Firebase config ──────────────────────────────────────────────────────────
// Obtén el appId de tu proyecto web en Firebase Console →
// Configuración del proyecto → Tus apps → Web
const firebaseConfig = {
    apiKey:            'AIzaSyBnE2LU6cxMnGSTy994T2nmmz2nlsAABXY',
    authDomain:        'test-b7426.firebaseapp.com',
    projectId:         'test-b7426',
    storageBucket:     'test-b7426.firebasestorage.app',
    messagingSenderId: '317859138732',
    appId:             '1:317859138732:web:4ae5326181838084816309',
    measurementId:     'G-TM45WLB63D'
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.firestore();

// ─── Estado global ────────────────────────────────────────────────────────────
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

let currentUser      = null;   // firebase.User
let currentProfile   = null;   // { uid, username, email }
let recipientProfile = null;   // { uid, username, email }
let convId           = null;

let ws               = null;
let reconnectTimer   = null;
let messagesListener = null;
let allUsers         = [];
let lastTypingSent   = 0;
let typingHideTimer  = null;

// ─── Lightbox ─────────────────────────────────────────────────────────────────
const lightbox    = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
lightbox.addEventListener('click', () => lightbox.classList.remove('open'));

// ─── Auth state ───────────────────────────────────────────────────────────────
auth.onAuthStateChanged(async (user) => {
    if (user) {
        currentUser    = user;
        currentProfile = await fetchProfile(user.uid);
        showDirectory();
    } else {
        currentUser    = null;
        currentProfile = null;
        disconnectWS();
        showScreen('auth-screen');
        showPanel('login-panel');
    }
});

// ─── Navegación entre pantallas ───────────────────────────────────────────────
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

function showPanel(id) {
    document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

// ─── Login ────────────────────────────────────────────────────────────────────
document.getElementById('login-btn').addEventListener('click', async () => {
    const email    = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errorEl  = document.getElementById('login-error');
    const spinner  = document.getElementById('login-spinner');
    const btnText  = document.getElementById('login-btn-text');
    const btn      = document.getElementById('login-btn');

    if (!email || !password) {
        errorEl.textContent = 'Completa todos los campos.';
        return;
    }
    errorEl.textContent = '';
    btn.disabled = true;
    btnText.style.display = 'none';
    spinner.classList.remove('hidden');

    try {
        await auth.signInWithEmailAndPassword(email, password);
        // onAuthStateChanged maneja la navegación
    } catch (e) {
        errorEl.textContent = authError(e);
        btn.disabled = false;
        btnText.style.display = '';
        spinner.classList.add('hidden');
    }
});

['login-email', 'login-password'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('login-btn').click();
    });
});

document.getElementById('goto-register-btn').addEventListener('click', () => {
    document.getElementById('login-error').textContent = '';
    showPanel('register-panel');
});

// ─── Registro ─────────────────────────────────────────────────────────────────
document.getElementById('register-btn').addEventListener('click', async () => {
    const username = document.getElementById('reg-username').value.trim();
    const email    = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    const confirm  = document.getElementById('reg-confirm').value;
    const errorEl  = document.getElementById('register-error');

    // Limpiar errores previos
    ['err-username','err-email','err-password','err-confirm'].forEach(id => {
        const el = document.getElementById(id);
        el.classList.add('hidden');
        el.textContent = '';
    });
    errorEl.textContent = '';

    let valid = true;
    if (username.length < 3) {
        showFieldError('err-username', 'reg-username', 'Mínimo 3 caracteres'); valid = false;
    }
    if (!email.includes('@') || !email.includes('.')) {
        showFieldError('err-email', 'reg-email', 'Correo no válido'); valid = false;
    }
    if (password.length < 6) {
        showFieldError('err-password', 'reg-password', 'Mínimo 6 caracteres'); valid = false;
    }
    if (password !== confirm) {
        showFieldError('err-confirm', 'reg-confirm', 'Las contraseñas no coinciden'); valid = false;
    }
    if (!valid) return;

    const spinner = document.getElementById('register-spinner');
    const btnText = document.getElementById('register-btn-text');
    const btn     = document.getElementById('register-btn');
    btn.disabled  = true;
    btnText.style.display = 'none';
    spinner.classList.remove('hidden');

    try {
        // Verificar unicidad del username antes de crear el usuario
        const usernameDoc = await db.collection('usernames').doc(username).get();
        if (usernameDoc.exists) {
            showFieldError('err-username', 'reg-username', 'Ese nombre de usuario ya está en uso');
            return;
        }

        const result = await auth.createUserWithEmailAndPassword(email, password);
        const uid = result.user.uid;

        // Crear perfil en Firestore (batch atómico, igual que iOS)
        const batch = db.batch();
        batch.set(db.collection('users').doc(uid), {
            username,
            email,
            description: '',
            phoneNumber: '',
            createdAt:   firebase.firestore.Timestamp.now()
        });
        batch.set(db.collection('usernames').doc(username), { uid });
        await batch.commit();

        // onAuthStateChanged navegará al directorio automáticamente
    } catch (e) {
        errorEl.textContent = authError(e);
    } finally {
        btn.disabled = false;
        btnText.style.display = '';
        spinner.classList.add('hidden');
    }
});

document.getElementById('goto-login-btn').addEventListener('click', () => {
    document.getElementById('register-error').textContent = '';
    showPanel('login-panel');
});

function showFieldError(errId, inputId, msg) {
    const errEl = document.getElementById(errId);
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
    document.getElementById(inputId)?.closest('.input-row')?.classList.add('invalid');
}

// ─── Logout ───────────────────────────────────────────────────────────────────
document.getElementById('logout-btn').addEventListener('click', async () => {
    stopMessagesListener();
    disconnectWS();
    allUsers = [];
    await auth.signOut();
});

// ─── Directorio ───────────────────────────────────────────────────────────────
async function showDirectory() {
    stopMessagesListener();
    disconnectWS();
    document.getElementById('my-username').textContent =
        currentProfile?.username || currentUser?.email || '';
    document.getElementById('search-input').value = '';
    showScreen('directory-screen');
    await loadDirectory();
}

async function loadDirectory() {
    const listEl = document.getElementById('user-list');
    listEl.innerHTML = '<div class="dir-empty">Cargando usuarios...</div>';
    try {
        const snapshot = await db.collection('users').get();
        allUsers = snapshot.docs
            .map(doc => ({ uid: doc.id, ...doc.data() }))
            .filter(u => u.uid !== currentUser.uid)
            .sort((a, b) => (a.username || '').localeCompare(b.username || ''));
        renderUserList(allUsers);
    } catch (e) {
        listEl.innerHTML = '<div class="dir-empty">Error al cargar usuarios.</div>';
    }
}

function renderUserList(users) {
    const listEl = document.getElementById('user-list');
    if (users.length === 0) {
        listEl.innerHTML = '<div class="dir-empty">No hay otros usuarios registrados.</div>';
        return;
    }
    listEl.innerHTML = users.map(u => `
        <div class="user-row" data-uid="${escapeHtml(u.uid)}">
            <div class="user-avatar">${escapeHtml((u.username || '?').charAt(0).toUpperCase())}</div>
            <div class="user-info">
                <div class="user-name">${escapeHtml(u.username || 'Sin nombre')}</div>
                <div class="user-email">${escapeHtml(u.email || '')}</div>
            </div>
            <svg class="user-chevron" viewBox="0 0 24 24" width="18" height="18">
                <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6-6-6z" fill="currentColor"/>
            </svg>
        </div>
    `).join('');

    listEl.querySelectorAll('.user-row').forEach(row => {
        row.addEventListener('click', () => {
            const profile = allUsers.find(u => u.uid === row.dataset.uid);
            if (profile) openChat(profile);
        });
    });
}

document.getElementById('search-input').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    const filtered = q
        ? allUsers.filter(u =>
            (u.username || '').toLowerCase().includes(q) ||
            (u.email    || '').toLowerCase().includes(q))
        : allUsers;
    renderUserList(filtered);
});

// ─── Chat ─────────────────────────────────────────────────────────────────────
function openChat(profile) {
    recipientProfile = profile;
    convId = conversationId(currentUser.uid, profile.uid);

    document.getElementById('contact-name').textContent =
        profile.username || profile.email || 'Contacto';
    document.getElementById('chat-avatar').textContent =
        (profile.username || '?').charAt(0).toUpperCase();
    setStatus('Conectando...', '');
    document.getElementById('messages').innerHTML = '';

    showScreen('chat-screen');
    startMessagesListener();
    connectWS();
}

document.getElementById('back-btn').addEventListener('click', () => {
    stopMessagesListener();
    disconnectWS();
    recipientProfile = null;
    convId = null;
    showDirectory();
});

// ─── Firestore messages listener ──────────────────────────────────────────────
function startMessagesListener() {
    stopMessagesListener();

    // Carga el historial (últimos 50) y luego escucha mensajes nuevos
    db.collection('conversations').doc(convId)
      .collection('messages')
      .orderBy('timestamp')
      .limit(50)
      .get()
      .then(snapshot => {
          const messagesEl = document.getElementById('messages');
          messagesEl.innerHTML = '';
          snapshot.docs.forEach(doc => renderMessage({ id: doc.id, ...doc.data() }));
          scrollToBottom();

          const threshold = snapshot.docs.length > 0
              ? snapshot.docs[snapshot.docs.length - 1].data().timestamp
              : Date.now();

          messagesListener = db.collection('conversations').doc(convId)
              .collection('messages')
              .where('timestamp', '>', threshold)
              .orderBy('timestamp')
              .onSnapshot(snap => {
                  snap.docChanges().forEach(change => {
                      if (change.type === 'added') {
                          renderMessage({ id: change.doc.id, ...change.doc.data() });
                          scrollToBottom();
                      }
                  });
              });
      })
      .catch(e => console.error('[Firestore] Error al cargar mensajes:', e));
}

function stopMessagesListener() {
    if (messagesListener) {
        messagesListener();
        messagesListener = null;
    }
}

// ─── Envío de mensajes ────────────────────────────────────────────────────────
function sendText() {
    const textInput = document.getElementById('text-input');
    const text = textInput.value.trim();
    if (!text || !convId) return;
    textInput.value = '';

    db.collection('conversations').doc(convId).collection('messages').add({
        type:      'text',
        sender:    currentUser.uid,
        recipient: recipientProfile.uid,
        content:   text,
        timestamp: Date.now()
    }).catch(e => console.error('[Firestore] Error enviando texto:', e));
}

function sendImage(file) {
    if (!file || !convId) return;
    const reader = new FileReader();
    reader.onload = e => {
        const base64 = e.target.result.split(',')[1];
        db.collection('conversations').doc(convId).collection('messages').add({
            type:      'image',
            sender:    currentUser.uid,
            recipient: recipientProfile.uid,
            content:   base64,
            mimeType:  file.type,
            timestamp: Date.now()
        }).catch(err => console.error('[Firestore] Error enviando imagen:', err));
    };
    reader.readAsDataURL(file);
}

document.getElementById('send-btn').addEventListener('click', sendText);

document.getElementById('text-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
});

document.getElementById('text-input').addEventListener('input', () => {
    const now = Date.now();
    if (now - lastTypingSent > 1500) {
        lastTypingSent = now;
        sendTypingWS();
    }
});

document.getElementById('image-input').addEventListener('change', e => {
    sendImage(e.target.files[0]);
    e.target.value = '';
});

// ─── WebSocket (solo typing indicator) ───────────────────────────────────────
function connectWS() {
    disconnectWS();
    ws = new WebSocket(WS_URL);

    ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'identify', userId: currentUser.uid }));
        setStatus('En línea', 'connected');
    });

    ws.addEventListener('message', event => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'peer_connected' && msg.userId === recipientProfile?.uid) {
                setStatus('Contacto en línea', 'connected');
                addSystemMessage('Contacto conectado');
            } else if (msg.type === 'peer_disconnected' && msg.userId === recipientProfile?.uid) {
                setStatus('Contacto desconectado', 'disconnected');
                addSystemMessage('Contacto desconectado');
            } else if (msg.type === 'typing' && msg.from === recipientProfile?.uid) {
                showTypingStatus();
            }
        } catch (_) {}
    });

    ws.addEventListener('close', () => {
        if (recipientProfile) {
            setStatus('Reconectando...', '');
            reconnectTimer = setTimeout(connectWS, 3000);
        }
    });

    ws.addEventListener('error', () => ws.close());
}

function disconnectWS() {
    clearTimeout(reconnectTimer);
    if (ws) { ws.close(); ws = null; }
}

function sendTypingWS() {
    if (ws?.readyState === WebSocket.OPEN && recipientProfile) {
        ws.send(JSON.stringify({
            type: 'typing',
            from: currentUser.uid,
            to:   recipientProfile.uid
        }));
    }
}

function showTypingStatus() {
    setStatus('escribiendo...', 'connected');
    clearTimeout(typingHideTimer);
    typingHideTimer = setTimeout(() => {
        if (recipientProfile) setStatus('En línea', 'connected');
    }, 3000);
}

// ─── Render mensajes ──────────────────────────────────────────────────────────
function renderMessage(msg) {
    const isSent  = msg.sender === currentUser.uid;
    const msgEl   = document.createElement('div');
    msgEl.className = `message ${isSent ? 'sent' : 'received'}`;

    const bubbleEl = document.createElement('div');
    bubbleEl.className = 'bubble';

    if (msg.type === 'text') {
        const textEl = document.createElement('span');
        textEl.className   = 'bubble-text';
        textEl.textContent = msg.content;
        bubbleEl.appendChild(textEl);
    } else if (msg.type === 'image') {
        const mime  = msg.mimeType || 'image/jpeg';
        const imgEl = document.createElement('img');
        imgEl.className = 'bubble-image';
        imgEl.src       = `data:${mime};base64,${msg.content}`;
        imgEl.addEventListener('click', () => {
            lightboxImg.src = imgEl.src;
            lightbox.classList.add('open');
        });
        bubbleEl.appendChild(imgEl);
    }

    const timeEl = document.createElement('span');
    timeEl.className   = 'timestamp';
    timeEl.textContent = formatTime(msg.timestamp);

    msgEl.appendChild(bubbleEl);
    msgEl.appendChild(timeEl);
    document.getElementById('messages').appendChild(msgEl);
}

function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className   = 'system-message';
    el.textContent = text;
    document.getElementById('messages').appendChild(el);
    scrollToBottom();
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function setStatus(text, className) {
    const el = document.getElementById('status');
    el.textContent = text;
    el.className   = className;
}

function scrollToBottom() {
    const c = document.getElementById('messages-container');
    c.scrollTop = c.scrollHeight;
}

function formatTime(ts) {
    return new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

function conversationId(uid1, uid2) {
    return [uid1, uid2].sort().join('_');
}

async function fetchProfile(uid) {
    try {
        const doc = await db.collection('users').doc(uid).get();
        if (doc.exists) return { uid: doc.id, ...doc.data() };
    } catch (_) {}
    return { uid, username: '', email: currentUser?.email ?? '' };
}

function authError(e) {
    const code = e.code || '';
    if (code.includes('invalid-email'))          return 'El correo no tiene un formato válido.';
    if (code.includes('wrong-password') ||
        code.includes('invalid-credential'))     return 'Correo o contraseña incorrectos.';
    if (code.includes('user-not-found'))         return 'No existe una cuenta con ese correo.';
    if (code.includes('email-already-in-use'))   return 'Ya existe una cuenta con ese correo.';
    if (code.includes('weak-password'))          return 'La contraseña es demasiado débil.';
    if (code.includes('network-request-failed')) return 'Sin conexión. Revisa tu internet.';
    if (code.includes('too-many-requests'))      return 'Demasiados intentos. Intenta más tarde.';
    return 'Ocurrió un error. Intenta de nuevo.';
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

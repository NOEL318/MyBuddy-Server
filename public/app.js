// Logica del cliente web de MyBuddy: autentica al usuario con Firebase, lista los demas usuarios, mantiene el chat en tiempo real con Firestore y sincroniza presencia y typing por WebSocket
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

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

let currentUser      = null;
let currentProfile   = null;
let recipientProfile = null;
let convId           = null;

let ws               = null;
let reconnectTimer   = null;
let messagesListener = null;
let allUsers         = [];
let lastTypingSent   = 0;
let typingHideTimer  = null;

const lightbox    = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
lightbox.addEventListener('click', () => lightbox.classList.remove('open'));

// Reacciona a los cambios de sesion: si hay usuario carga su perfil y muestra el directorio, si no lo hay limpia el estado y vuelve a la pantalla de login
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

// Muestra unicamente la pantalla cuyo id se pasa y oculta las demas
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

// Muestra unicamente el panel de autenticacion (login o registro) cuyo id se pasa
function showPanel(id) {
    document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

// Maneja el envio del formulario de login validando los campos y autenticando al usuario contra Firebase Auth con email y contraseña
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

// Maneja el envio del formulario de registro: valida los campos, comprueba que el username no este en uso, crea el usuario en Firebase Auth y guarda su perfil en Firestore en una operacion atomica
document.getElementById('register-btn').addEventListener('click', async () => {
    const username = document.getElementById('reg-username').value.trim();
    const email    = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    const confirm  = document.getElementById('reg-confirm').value;
    const errorEl  = document.getElementById('register-error');

    ['err-username','err-email','err-password','err-confirm'].forEach(id => {
        const el = document.getElementById(id);
        el.classList.add('hidden');
        el.textContent = '';
    });
    errorEl.textContent = '';

    let valid = true;
    if (username.length < 3) {
        showFieldError('err-username', 'reg-username', 'Minimo 3 caracteres'); valid = false;
    }
    if (!email.includes('@') || !email.includes('.')) {
        showFieldError('err-email', 'reg-email', 'Correo no valido'); valid = false;
    }
    if (password.length < 6) {
        showFieldError('err-password', 'reg-password', 'Minimo 6 caracteres'); valid = false;
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
        const usernameDoc = await db.collection('usernames').doc(username).get();
        if (usernameDoc.exists) {
            showFieldError('err-username', 'reg-username', 'Ese nombre de usuario ya esta en uso');
            return;
        }

        const result = await auth.createUserWithEmailAndPassword(email, password);
        const uid = result.user.uid;

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

// Muestra un mensaje de error junto a un campo del formulario y marca visualmente el campo como invalido
function showFieldError(errId, inputId, msg) {
    const errEl = document.getElementById(errId);
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
    document.getElementById(inputId)?.closest('.input-row')?.classList.add('invalid');
}

// Cierra la sesion del usuario actual, detiene los listeners de Firestore, desconecta el WebSocket y limpia la lista de usuarios cacheada
document.getElementById('logout-btn').addEventListener('click', async () => {
    stopMessagesListener();
    disconnectWS();
    allUsers = [];
    await auth.signOut();
});

// Prepara y muestra la pantalla del directorio limpiando estado anterior y cargando la lista de usuarios
async function showDirectory() {
    stopMessagesListener();
    disconnectWS();
    document.getElementById('my-username').textContent =
        currentProfile?.username || currentUser?.email || '';
    document.getElementById('search-input').value = '';
    showScreen('directory-screen');
    await loadDirectory();
}

// Carga desde Firestore la lista de todos los usuarios registrados excluyendo al actual y la renderiza ordenada alfabeticamente
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

// Pinta en el DOM la lista de usuarios recibida y asigna a cada fila el evento click que abre el chat con ese contacto
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

// Abre la pantalla de chat con el perfil indicado, calcula el id de la conversacion, inicia el listener de mensajes y abre el WebSocket
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

// Carga el historial reciente (ultimos 50 mensajes) de la conversacion actual y se suscribe en tiempo real a los nuevos mensajes que lleguen despues
function startMessagesListener() {
    stopMessagesListener();

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

// Cancela la suscripcion al listener de mensajes de Firestore si esta activa
function stopMessagesListener() {
    if (messagesListener) {
        messagesListener();
        messagesListener = null;
    }
}

// Toma el texto escrito en el input y lo guarda como mensaje en la conversacion actual de Firestore
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

// Lee el archivo de imagen seleccionado, lo convierte a base64 y lo guarda como mensaje en la conversacion actual de Firestore
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

// Abre la conexion WebSocket con el servidor, se identifica con su userId y procesa los eventos de presencia (peer_connected/disconnected) y typing del contacto, reintentando la conexion si se cae
function connectWS() {
    disconnectWS();
    ws = new WebSocket(WS_URL);

    ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'identify', userId: currentUser.uid }));
        setStatus('En linea', 'connected');
    });

    ws.addEventListener('message', event => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'peer_connected' && msg.userId === recipientProfile?.uid) {
                setStatus('Contacto en linea', 'connected');
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

// Cierra la conexion WebSocket actual y cancela cualquier reintento de reconexion pendiente
function disconnectWS() {
    clearTimeout(reconnectTimer);
    if (ws) { ws.close(); ws = null; }
}

// Envia al servidor por WebSocket una notificacion de que el usuario esta escribiendo, dirigida al destinatario actual
function sendTypingWS() {
    if (ws?.readyState === WebSocket.OPEN && recipientProfile) {
        ws.send(JSON.stringify({
            type: 'typing',
            from: currentUser.uid,
            to:   recipientProfile.uid
        }));
    }
}

// Muestra durante 3 segundos el indicador escribiendo en la cabecera del chat antes de volver a En linea
function showTypingStatus() {
    setStatus('escribiendo...', 'connected');
    clearTimeout(typingHideTimer);
    typingHideTimer = setTimeout(() => {
        if (recipientProfile) setStatus('En linea', 'connected');
    }, 3000);
}

// Crea y agrega al DOM la burbuja de un mensaje individual (texto o imagen) junto con su hora, alineada a la derecha si es propio o a la izquierda si es recibido
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

// Agrega al chat un mensaje informativo del sistema (por ejemplo Contacto conectado o Contacto desconectado)
function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className   = 'system-message';
    el.textContent = text;
    document.getElementById('messages').appendChild(el);
    scrollToBottom();
}

// Actualiza el texto y la clase css del indicador de estado de la cabecera del chat
function setStatus(text, className) {
    const el = document.getElementById('status');
    el.textContent = text;
    el.className   = className;
}

// Hace scroll automaticamente hasta el final del contenedor de mensajes
function scrollToBottom() {
    const c = document.getElementById('messages-container');
    c.scrollTop = c.scrollHeight;
}

// Convierte un timestamp en milisegundos a una hora con formato HH:MM en la zona horaria local
function formatTime(ts) {
    return new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

// Genera un id deterministico para la conversacion entre dos usuarios uniendo sus uid en orden alfabetico para que ambos lados obtengan el mismo
function conversationId(uid1, uid2) {
    return [uid1, uid2].sort().join('_');
}

// Obtiene desde Firestore el documento de perfil del uid indicado y devuelve un objeto con username y email
async function fetchProfile(uid) {
    try {
        const doc = await db.collection('users').doc(uid).get();
        if (doc.exists) return { uid: doc.id, ...doc.data() };
    } catch (_) {}
    return { uid, username: '', email: currentUser?.email ?? '' };
}

// Traduce los codigos de error de Firebase Auth a un mensaje claro en español que se le muestra al usuario
function authError(e) {
    const code = e.code || '';
    if (code.includes('invalid-email'))          return 'El correo no tiene un formato valido.';
    if (code.includes('wrong-password') ||
        code.includes('invalid-credential'))     return 'Correo o contraseña incorrectos.';
    if (code.includes('user-not-found'))         return 'No existe una cuenta con ese correo.';
    if (code.includes('email-already-in-use'))   return 'Ya existe una cuenta con ese correo.';
    if (code.includes('weak-password'))          return 'La contraseña es demasiado debil.';
    if (code.includes('network-request-failed')) return 'Sin conexion. Revisa tu internet.';
    if (code.includes('too-many-requests'))      return 'Demasiados intentos. Intenta mas tarde.';
    return 'Ocurrio un error. Intenta de nuevo.';
}

// Escapa los caracteres especiales de un string para evitar inyeccion de HTML cuando se interpola en innerHTML
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

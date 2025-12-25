const socket = io();

/* ---------- NOTIFICATION PERMISSION ---------- */
let notificationsEnabled = false;

async function requestNotificationPermission() {
    if ("Notification" in window) {
        const permission = await Notification.requestPermission();
        notificationsEnabled = permission === "granted";
        return notificationsEnabled;
    }
    return false;
}

function showNotification(title, body, friend) {
    if (notificationsEnabled && document.hidden) {
        const notification = new Notification(title, {
            body: body,
            icon: '🔒',
            tag: friend,
            requireInteraction: false
        });
        
        notification.onclick = () => {
            window.focus();
            // Auto-select the friend who sent the message
            const contactEl = document.getElementById(friend);
            if (contactEl) {
                contactEl.click();
            }
            notification.close();
        };
        
        // Auto close after 5 seconds
        setTimeout(() => notification.close(), 5000);
    }
}

// Request permission on load
requestNotificationPermission();

/* ---------- CRYPTO UTILITIES ---------- */
let keyPair = null;
let contactPublicKeys = {}; // friend_pid -> publicKey
let sharedSecrets = {}; // friend_pid -> AES key

// Generate RSA key pair for this user
async function generateKeyPair() {
    keyPair = await window.crypto.subtle.generateKey(
        {
            name: "RSA-OAEP",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: "SHA-256"
        },
        true,
        ["encrypt", "decrypt"]
    );
    return keyPair;
}

// Export public key to base64
async function exportPublicKey(publicKey) {
    const exported = await window.crypto.subtle.exportKey("spki", publicKey);
    return btoa(String.fromCharCode(...new Uint8Array(exported)));
}

// Import public key from base64
async function importPublicKey(base64Key) {
    const binaryKey = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0));
    return await window.crypto.subtle.importKey(
        "spki",
        binaryKey,
        {
            name: "RSA-OAEP",
            hash: "SHA-256"
        },
        true,
        ["encrypt"]
    );
}

// Generate shared AES key for a contact
async function generateSharedKey() {
    return await window.crypto.subtle.generateKey(
        {
            name: "AES-GCM",
            length: 256
        },
        true,
        ["encrypt", "decrypt"]
    );
}

// Export AES key to base64
async function exportAESKey(key) {
    const exported = await window.crypto.subtle.exportKey("raw", key);
    return btoa(String.fromCharCode(...new Uint8Array(exported)));
}

// Import AES key from base64
async function importAESKey(base64Key) {
    const binaryKey = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0));
    return await window.crypto.subtle.importKey(
        "raw",
        binaryKey,
        "AES-GCM",
        true,
        ["encrypt", "decrypt"]
    );
}

// Encrypt AES key with RSA public key
async function encryptAESKey(aesKey, publicKey) {
    const exported = await window.crypto.subtle.exportKey("raw", aesKey);
    const encrypted = await window.crypto.subtle.encrypt(
        { name: "RSA-OAEP" },
        publicKey,
        exported
    );
    return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

// Decrypt AES key with RSA private key
async function decryptAESKey(encryptedBase64) {
    const encrypted = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
    const decrypted = await window.crypto.subtle.decrypt(
        { name: "RSA-OAEP" },
        keyPair.privateKey,
        encrypted
    );
    return await window.crypto.subtle.importKey(
        "raw",
        decrypted,
        "AES-GCM",
        true,
        ["encrypt", "decrypt"]
    );
}

// Encrypt message with AES-GCM
async function encryptMessage(message, aesKey) {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    
    const encrypted = await window.crypto.subtle.encrypt(
        {
            name: "AES-GCM",
            iv: iv
        },
        aesKey,
        data
    );
    
    // Combine IV + encrypted data
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(encrypted), iv.length);
    
    return btoa(String.fromCharCode(...combined));
}

// Decrypt message with AES-GCM
async function decryptMessage(encryptedBase64, aesKey) {
    const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    
    const decrypted = await window.crypto.subtle.decrypt(
        {
            name: "AES-GCM",
            iv: iv
        },
        aesKey,
        data
    );
    
    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
}

/* ---------- PERMANENT ID ---------- */
let pid = localStorage.getItem("pid");
if (!pid) {
    pid = crypto.randomUUID();
    localStorage.setItem("pid", pid);
}

/* ---------- TEMP KEY (CHANGES EACH LOAD) ---------- */
let tempKey = crypto.randomUUID();
document.getElementById("myKey").innerText = tempKey;

/* ---------- GENERATE QR ---------- */
document.getElementById("qr").innerHTML = "";
new QRCode(document.getElementById("qr"), {
    text: tempKey,
    width: 180,
    height: 180
});

let activeFriend = null;
let contactNames = {}; // Store custom names: pid -> custom_name
let editingContact = null;
let deletingContact = null;
let typingTimeout = null;

// Load custom names from localStorage
function loadContactNames() {
    const saved = localStorage.getItem('contactNames');
    if (saved) {
        try {
            contactNames = JSON.parse(saved);
        } catch (e) {
            contactNames = {};
        }
    }
}

// Save custom names to localStorage
function saveContactNames() {
    localStorage.setItem('contactNames', JSON.stringify(contactNames));
}

/* ---------- INITIALIZE ENCRYPTION ---------- */
async function initCrypto() {
    await generateKeyPair();
    const publicKeyBase64 = await exportPublicKey(keyPair.publicKey);
    
    // Register with server, including public key
    socket.emit("register", { 
        pid, 
        temp: tempKey,
        publicKey: publicKeyBase64
    });
}

// Initialize on load
loadContactNames();
initCrypto();

/* ---------- SEND REQUEST (MANUAL) ---------- */
function sendRequest() {
    const key = document.getElementById("friendKey").value.trim();
    if (!key) {
        alert("Please enter a friend's key");
        return;
    }

    socket.emit("request_connect", {
        sender_pid: pid,
        target_temp: key
    });
    
    closeAddContact();
    document.getElementById("friendKey").value = "";
    
    alert("Connection request sent!");
}

/* ---------- QR SCANNER ---------- */
let qrScanner;

function startScan() {
    const scannerDiv = document.getElementById("scanner");
    scannerDiv.innerHTML = "";

    qrScanner = new Html5Qrcode("scanner");

    qrScanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 250 },
        scannedKey => {
            qrScanner.stop();
            scannerDiv.innerHTML = "";
            
            closeAddContact();

            socket.emit("request_connect", {
                sender_pid: pid,
                target_temp: scannedKey
            });

            alert("QR scanned successfully! Request sent.");
        },
        error => {}
    ).catch(err => {
        alert("Camera access denied or not available");
        console.error(err);
    });
}

/* ---------- INCOMING REQUEST ---------- */
socket.on("incoming_request", async data => {
    const sender = data.sender_pid;
    const senderPublicKey = data.publicKey;
    
    // Play notification sound
    playNotificationSound();
    
    if (confirm("Accept chat request from " + sender + "?")) {
        // Store their public key
        contactPublicKeys[sender] = await importPublicKey(senderPublicKey);
        
        // Generate shared AES key for this contact
        const sharedKey = await generateSharedKey();
        sharedSecrets[sender] = sharedKey;
        
        // Encrypt the AES key with their public key
        const encryptedKey = await encryptAESKey(sharedKey, contactPublicKeys[sender]);
        
        // Get our public key
        const myPublicKey = await exportPublicKey(keyPair.publicKey);
        
        socket.emit("accept_request", {
            acceptor: pid,
            sender,
            encryptedKey: encryptedKey,
            publicKey: myPublicKey
        });
        
        addContact(sender);
    }
});

/* ---------- ACCEPTED ---------- */
socket.on("request_accepted", async data => {
    const friend = data.friend_pid;
    const encryptedKey = data.encryptedKey;
    const friendPublicKey = data.publicKey;
    
    // Store their public key
    contactPublicKeys[friend] = await importPublicKey(friendPublicKey);
    
    // Decrypt the shared AES key
    sharedSecrets[friend] = await decryptAESKey(encryptedKey);
    
    addContact(friend);
});

/* ---------- KEY EXCHANGE (for existing contacts) ---------- */
socket.on("restore_contacts", async friends => {
    for (const friend of friends) {
        addContact(friend);
        
        // Request public key exchange if we don't have it
        if (!contactPublicKeys[friend]) {
            const myPublicKey = await exportPublicKey(keyPair.publicKey);
            socket.emit("request_key_exchange", {
                from: pid,
                to: friend,
                publicKey: myPublicKey
            });
        }
        
        // Load message history for this friend
        socket.emit("load_message_history", {
            user_pid: pid,
            friend_pid: friend
        });
    }
});

socket.on("key_exchange_request", async data => {
    const friend = data.from;
    const friendPublicKey = data.publicKey;
    
    // Store their public key
    contactPublicKeys[friend] = await importPublicKey(friendPublicKey);
    
    // Generate new shared key
    const sharedKey = await generateSharedKey();
    sharedSecrets[friend] = sharedKey;
    
    // Encrypt and send back
    const encryptedKey = await encryptAESKey(sharedKey, contactPublicKeys[friend]);
    const myPublicKey = await exportPublicKey(keyPair.publicKey);
    
    socket.emit("key_exchange_response", {
        from: pid,
        to: friend,
        encryptedKey: encryptedKey,
        publicKey: myPublicKey
    });
});

socket.on("key_exchange_response", async data => {
    const friend = data.from;
    const encryptedKey = data.encryptedKey;
    const friendPublicKey = data.publicKey;
    
    // Store their public key
    contactPublicKeys[friend] = await importPublicKey(friendPublicKey);
    
    // Decrypt shared key
    sharedSecrets[friend] = await decryptAESKey(encryptedKey);
    
    // Load message history after key exchange
    socket.emit("load_message_history", {
        user_pid: pid,
        friend_pid: friend
    });
});

/* ---------- MESSAGE HISTORY ---------- */
socket.on("message_history", async data => {
    const friend = data.friend_pid;
    const messages = data.messages;
    
    // Only load if this is the active chat
    if (friend !== activeFriend) return;
    
    const chatBox = document.getElementById("chatBox");
    chatBox.innerHTML = "";
    
    for (const msg of messages) {
        if (!sharedSecrets[friend]) continue;
        
        try {
            const decryptedText = await decryptMessage(msg.message, sharedSecrets[friend]);
            const sentByMe = msg.from === pid;
            
            displayMessage(decryptedText, sentByMe, msg.timestamp);
        } catch (e) {
            console.error("Failed to decrypt message:", e);
        }
    }
    
    chatBox.scrollTop = chatBox.scrollHeight;
});

/* ---------- CONTACTS ---------- */
function addContact(friend) {
    if (document.getElementById(friend)) return;

    const li = document.createElement("li");
    li.id = friend;
    
    const initial = friend.substring(0, 2).toUpperCase();
    const displayName = contactNames[friend] || (friend.substring(0, 20) + '...');
    
    li.innerHTML = `
        <div class="contact-avatar">${initial}</div>
        <div class="contact-info">
            <div class="contact-name">
                <span class="contact-name-text" id="name-${friend}">${displayName}</span>
                <button class="contact-edit-btn" onclick="editContactName('${friend}'); event.stopPropagation();" title="Edit name">✏️</button>
            </div>
            <div class="contact-status">Click to chat</div>
        </div>
        <div class="status-indicator" id="status-${friend}"></div>
    `;
    
    li.onclick = () => {
        activeFriend = friend;
        document.querySelectorAll('#contacts li').forEach(el => el.classList.remove('active'));
        li.classList.add('active');
        
        const displayName = contactNames[friend] || (friend.substring(0, 25) + '...');
        
        // Update chat header
        document.getElementById("chatContactName").innerText = displayName;
        document.getElementById("chatContactStatus").innerText = '🔒 End-to-end encrypted';
        document.getElementById("chatAvatar").innerText = initial;
        
        // Load message history for this friend
        socket.emit("load_message_history", {
            user_pid: pid,
            friend_pid: friend
        });
        
        // Mobile: open chat
        if (window.innerWidth <= 1000) {
            openChat(friend);
        }
    };
    document.getElementById("contacts").appendChild(li);
}

// Update contact name display
function updateContactDisplay(friend) {
    const nameEl = document.getElementById(`name-${friend}`);
    if (nameEl) {
        const displayName = contactNames[friend] || (friend.substring(0, 20) + '...');
        nameEl.textContent = displayName;
    }
    
    // Update chat header if this is active friend
    if (friend === activeFriend) {
        const displayName = contactNames[friend] || (friend.substring(0, 25) + '...');
        document.getElementById("chatContactName").innerText = displayName;
    }
}

/* ---------- CHAT ---------- */
async function sendMsg() {
    if (!activeFriend) {
        alert("Please select a contact first");
        return;
    }
    
    if (!sharedSecrets[activeFriend]) {
        alert("Encryption not established. Wait a moment and try again.");
        return;
    }

    const input = document.getElementById("msg");
    const msg = input.value.trim();
    if (!msg) return;

    // Encrypt message
    const encrypted = await encryptMessage(msg, sharedSecrets[activeFriend]);

    socket.emit("send_message", {
        from: pid,
        to: activeFriend,
        message: encrypted
    });

    input.value = "";
    
    // Stop typing indicator
    socket.emit("stop_typing", {
        from: pid,
        to: activeFriend
    });
}

// Handle Enter key in message input
document.getElementById("msg").addEventListener("keypress", (e) => {
    if (e.key === "Enter") sendMsg();
});

// Typing indicator
document.getElementById("msg").addEventListener("input", (e) => {
    if (!activeFriend) return;
    
    if (e.target.value.length > 0) {
        socket.emit("typing", {
            from: pid,
            to: activeFriend
        });
        
        // Clear existing timeout
        if (typingTimeout) clearTimeout(typingTimeout);
        
        // Stop typing after 3 seconds of inactivity
        typingTimeout = setTimeout(() => {
            socket.emit("stop_typing", {
                from: pid,
                to: activeFriend
            });
        }, 3000);
    } else {
        socket.emit("stop_typing", {
            from: pid,
            to: activeFriend
        });
    }
});

/* ---------- DISPLAY MESSAGE ---------- */
function displayMessage(text, sentByMe, timestamp) {
    const chat = document.getElementById("chatBox");
    
    const messageDiv = document.createElement("div");
    messageDiv.className = sentByMe ? "message sent" : "message received";
    
    const date = timestamp ? new Date(timestamp) : new Date();
    const timeStr = date.getHours().toString().padStart(2, '0') + ':' + 
                   date.getMinutes().toString().padStart(2, '0');
    
    messageDiv.innerHTML = `
        <div class="message-bubble">
            <div class="message-text">${escapeHtml(text)}</div>
            <div class="message-time">${timeStr}</div>
        </div>
    `;
    
    chat.appendChild(messageDiv);
    chat.scrollTop = chat.scrollHeight;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/* ---------- RECEIVE MESSAGE ---------- */
socket.on("receive_message", async data => {
    const sender = data.from;
    const encryptedMsg = data.message;
    const sentByMe = data.sent_by_me;
    const timestamp = data.timestamp;
    
    const friendPid = sentByMe ? activeFriend : sender;
    
    if (sentByMe && sender !== pid) return;
    
    if (!sentByMe && sender !== activeFriend) {
        // Show notification for messages from other contacts
        if (!sharedSecrets[sender]) return;
        
        try {
            const msg = await decryptMessage(encryptedMsg, sharedSecrets[sender]);
            const senderName = contactNames[sender] || sender.substring(0, 20);
            showNotification(senderName, msg, sender);
            playNotificationSound();
        } catch (e) {
            console.error("Failed to decrypt notification message:", e);
        }
        return;
    }
    
    if (!sharedSecrets[friendPid]) {
        console.error("No shared key for", friendPid);
        return;
    }
    
    try {
        const msg = await decryptMessage(encryptedMsg, sharedSecrets[friendPid]);
        displayMessage(msg, sentByMe, timestamp);
        
        // Show notification if not sent by me
        if (!sentByMe) {
            const senderName = contactNames[sender] || sender.substring(0, 20);
            showNotification(senderName, msg, sender);
            playNotificationSound();
        }
    } catch (e) {
        console.error("Decryption failed:", e);
        alert("Failed to decrypt message");
    }
});

/* ---------- TYPING INDICATOR ---------- */
socket.on("typing", data => {
    if (data.from === activeFriend) {
        document.getElementById("chatContactStatus").innerText = 'typing...';
    }
});

socket.on("stop_typing", data => {
    if (data.from === activeFriend) {
        const statusEl = document.getElementById(`status-${activeFriend}`);
        const isOnline = statusEl && statusEl.classList.contains('online');
        document.getElementById("chatContactStatus").innerText = 
            isOnline ? '🟢 Online • End-to-end encrypted' : '🔒 End-to-end encrypted';
    }
});

/* ---------- NOTIFICATION SOUND ---------- */
function playNotificationSound() {
    const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBTGH0fPTgjMGHm7A7+OZSA0PVKzn7KthFwlBmeHwuWoaBjCE0vLRgzUHGm+/7uKZSgwPVqzm6apfFglBmeHwuWoaBjCE0vLRgzUHGm+/7uKZSgwPVqzm6apfFglBmeHwuWoaBjCE0vLRgzUHGm+/7uKZSgwPVqzm6apfFglBmeHwuWoaBjCE0vLRgzUHGm+/7uKZSgwPVqzm6apfFglBmeHwuWoaBjCE0vLRgzUHGm+/7uKZSgwPVqzm6apfFglBmeHwuWoaBjCE0vLRgzUHGm+/7uKZSgwPVqzm6apfFglBmeHwuWoaBjCE0vLRgzUHGm+/7uKZSgwPVqzm6apfFglBmeHwuWoaBjCE0vLRgzUHGm+/7uKZSgwPVqzm6apfFglBmeHwuWoaBjCE0vLRgzUHGm+/7uKZSgwPVqzm6apfFglBmeHwuWoaBjCE0vLRgzUHGm+/7uKZSgwPVqzm6apfFglBmeHwuWoaBjCE0vLRgzUHGm+/7uKZSgwPVqzm6apfFg==');
    audio.volume = 0.3;
    audio.play().catch(e => console.log("Audio play failed:", e));
}

/* ---------- ERROR HANDLING ---------- */
socket.on("request_failed", data => {
    alert("Request failed: " + data.error);
});

socket.on("error", data => {
    alert("Error: " + data.message);
});

/* ---------- ONLINE STATUS ---------- */
socket.on("contact_online", friend => {
    const statusEl = document.getElementById(`status-${friend}`);
    if (statusEl) {
        statusEl.classList.add('online');
    }
    
    if (friend === activeFriend) {
        document.getElementById("chatContactStatus").innerText = '🟢 Online • End-to-end encrypted';
    }
});

socket.on("contact_offline", friend => {
    const statusEl = document.getElementById(`status-${friend}`);
    if (statusEl) {
        statusEl.classList.remove('online');
    }
    
    if (friend === activeFriend) {
        document.getElementById("chatContactStatus").innerText = '🔒 End-to-end encrypted';
    }
});

/* ---------- EDIT CONTACT NAME ---------- */
function editContactName(friend) {
    editingContact = friend;
    const currentName = contactNames[friend] || '';
    document.getElementById('editNameInput').value = currentName;
    document.getElementById('editNameModal').classList.add('active');
}

function closeEditName() {
    document.getElementById('editNameModal').classList.remove('active');
    editingContact = null;
}

function saveContactName() {
    const newName = document.getElementById('editNameInput').value.trim();
    
    if (!newName) {
        alert('Please enter a name');
        return;
    }
    
    if (editingContact) {
        contactNames[editingContact] = newName;
        saveContactNames();
        updateContactDisplay(editingContact);
        closeEditName();
    }
}

/* ---------- DELETE CHAT ---------- */
function deleteChat() {
    if (!activeFriend) {
        alert('No chat selected');
        return;
    }
    
    deletingContact = activeFriend;
    document.getElementById('deleteContactModal').classList.add('active');
}

function closeDeleteContact() {
    document.getElementById('deleteContactModal').classList.remove('active');
    deletingContact = null;
}

function confirmDeleteContact() {
    if (!deletingContact) return;
    
    // Notify server
    socket.emit("delete_contact", {
        user_pid: pid,
        contact_pid: deletingContact
    });
    
    // Remove from UI
    const contactEl = document.getElementById(deletingContact);
    if (contactEl) {
        contactEl.remove();
    }
    
    // Remove custom name
    delete contactNames[deletingContact];
    saveContactNames();
    
    // Clear chat if this was active
    if (activeFriend === deletingContact) {
        activeFriend = null;
        document.getElementById('chatBox').innerHTML = `
            <div class="empty-chat">
                <div class="empty-chat-icon">💬</div>
                <h3>WhatsApp-style E2EE Chat</h3>
                <p>Send and receive end-to-end encrypted messages<br>Your messages are secured with RSA-2048 + AES-256-GCM</p>
            </div>
        `;
        document.getElementById('chatContactName').innerText = 'Select a contact';
        
        if (window.innerWidth <= 1000) {
            closeChat();
        }
    }
    
    // Remove encryption keys
    delete sharedSecrets[deletingContact];
    delete contactPublicKeys[deletingContact];
    
    closeDeleteContact();
    
    alert('Contact deleted successfully');
}
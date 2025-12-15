const socket = io();

/* ---------- PERMANENT ID ---------- */
let pid = localStorage.getItem("pid");
if (!pid) {
    pid = crypto.randomUUID();
    localStorage.setItem("pid", pid);
}

/* ---------- TEMP KEY (CHANGES) ---------- */
let tempKey = crypto.randomUUID();
document.getElementById("myKey").innerText = tempKey;

/* ---------- REGISTER ---------- */
socket.emit("register", { pid, temp: tempKey });

let activeFriend = null;

/* ---------- REQUEST ---------- */
function sendRequest() {
    const key = document.getElementById("friendKey").value.trim();
    if (!key) return alert("Enter key");
    socket.emit("request_connect", {
        sender_pid: pid,
        target_temp: key
    });
}

socket.on("incoming_request", sender => {
    if (confirm("Accept chat request?")) {
        socket.emit("accept_request", {
            acceptor: pid,
            sender
        });
        addContact(sender);
    }
});

socket.on("request_accepted", friend => {
    addContact(friend);
});

/* ---------- CONTACTS ---------- */
function addContact(friend) {
    if (document.getElementById(friend)) return;

    const li = document.createElement("li");
    li.id = friend;
    li.innerText = friend;
    li.onclick = () => {
        activeFriend = friend;
        document.getElementById("chatBox").innerHTML = "";
    };
    document.getElementById("contacts").appendChild(li);
}

socket.on("restore_contacts", friends => {
    friends.forEach(addContact);
});

/* ---------- CHAT ---------- */
function sendMsg() {
    if (!activeFriend) return alert("Select contact");

    const input = document.getElementById("msg");
    const msg = input.value.trim();
    if (!msg) return;

    const encrypted = btoa(msg); // placeholder

    socket.emit("send_message", {
        from: pid,
        to: activeFriend,
        message: encrypted
    });

    input.value = "";
}

socket.on("receive_message", data => {
    const chat = document.getElementById("chatBox");
    const msg = atob(data.message);

    const p = document.createElement("p");
    p.innerText = (data.from === pid ? "You: " : "Friend: ") + msg;
    chat.appendChild(p);
});

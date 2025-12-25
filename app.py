from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, disconnect
import json
import os
from datetime import datetime

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret'  # Change this in production!
socketio = SocketIO(app, cors_allowed_origins="*")

# In-memory storage (use Redis/DB for production)
clients = {}        # permanent_id -> socket_id
temp_keys = {}      # temp_key -> permanent_id
contacts = {}       # permanent_id -> set(permanent_ids)
public_keys = {}    # permanent_id -> public_key (base64)
message_history = {} # permanent_id -> {friend_pid -> [messages]}

# File-based persistence
CONTACTS_FILE = 'contacts.json'
MESSAGES_FILE = 'messages.json'

def load_contacts():
    """Load contacts from file if exists"""
    global contacts
    if os.path.exists(CONTACTS_FILE):
        try:
            with open(CONTACTS_FILE, 'r') as f:
                data = json.load(f)
                contacts = {k: set(v) for k, v in data.items()}
        except:
            contacts = {}

def save_contacts():
    """Save contacts to file"""
    try:
        with open(CONTACTS_FILE, 'w') as f:
            data = {k: list(v) for k, v in contacts.items()}
            json.dump(data, f)
    except Exception as e:
        print(f"Error saving contacts: {e}")

def load_messages():
    """Load message history from file"""
    global message_history
    if os.path.exists(MESSAGES_FILE):
        try:
            with open(MESSAGES_FILE, 'r') as f:
                message_history = json.load(f)
        except:
            message_history = {}

def save_messages():
    """Save message history to file"""
    try:
        with open(MESSAGES_FILE, 'w') as f:
            json.dump(message_history, f)
    except Exception as e:
        print(f"Error saving messages: {e}")

# Load data on startup
load_contacts()
load_messages()

@app.route('/')
def index():
    return render_template('index.html')

@socketio.on('connect')
def handle_connect():
    print(f'Client connected: {request.sid}')

@socketio.on('disconnect')
def handle_disconnect():
    print(f'Client disconnected: {request.sid}')
    
    # Clean up disconnected client
    pid_to_remove = None
    for pid, sid in clients.items():
        if sid == request.sid:
            pid_to_remove = pid
            break
    
    if pid_to_remove:
        del clients[pid_to_remove]
        # Notify contacts that user is offline
        for contact_pid in contacts.get(pid_to_remove, set()):
            if contact_pid in clients:
                emit('contact_offline', pid_to_remove, to=clients[contact_pid])
        
        # Remove from temp_keys
        temp_to_remove = [k for k, v in temp_keys.items() if v == pid_to_remove]
        for temp in temp_to_remove:
            del temp_keys[temp]

@socketio.on('register')
def register(data):
    pid = data['pid']
    temp = data['temp']
    public_key = data.get('publicKey')

    clients[pid] = request.sid
    temp_keys[temp] = pid
    contacts.setdefault(pid, set())
    message_history.setdefault(pid, {})
    
    # Store public key
    if public_key:
        public_keys[pid] = public_key

    # Restore contacts on refresh
    emit('restore_contacts', list(contacts[pid]))
    
    # Notify contacts that this user is online
    for contact_pid in contacts[pid]:
        if contact_pid in clients:
            emit('contact_online', pid, to=clients[contact_pid])

@socketio.on('request_connect')
def request_connect(data):
    sender_pid = data['sender_pid']
    target_temp = data['target_temp']

    if target_temp not in temp_keys:
        emit('request_failed', {'error': 'User not found or offline'})
        return

    target_pid = temp_keys[target_temp]
    
    # Check if already contacts
    if target_pid in contacts.get(sender_pid, set()):
        emit('request_failed', {'error': 'Already in contacts'})
        return
    
    if target_pid not in clients:
        emit('request_failed', {'error': 'User offline'})
        return

    # Send request with sender's public key
    emit('incoming_request', {
        'sender_pid': sender_pid,
        'publicKey': public_keys.get(sender_pid)
    }, to=clients[target_pid])

@socketio.on('accept_request')
def accept_request(data):
    a = data['acceptor']
    b = data['sender']
    encrypted_key = data['encryptedKey']
    acceptor_public_key = data['publicKey']

    # Add bidirectional contacts
    contacts[a].add(b)
    contacts[b].add(a)
    
    # Initialize message history for both
    message_history.setdefault(a, {})
    message_history.setdefault(b, {})
    message_history[a].setdefault(b, [])
    message_history[b].setdefault(a, [])
    
    # Persist to file
    save_contacts()

    # Send encrypted key and public key to requester
    if b in clients:
        emit('request_accepted', {
            'friend_pid': a,
            'encryptedKey': encrypted_key,
            'publicKey': acceptor_public_key
        }, to=clients[b])
    
    # Confirm to acceptor
    if a in clients:
        emit('request_accepted', {
            'friend_pid': b,
            'encryptedKey': None,
            'publicKey': public_keys.get(b)
        }, to=clients[a])

@socketio.on('request_key_exchange')
def request_key_exchange(data):
    sender = data['from']
    receiver = data['to']
    public_key = data['publicKey']
    
    # Verify they are contacts
    if receiver not in contacts.get(sender, set()):
        return
    
    # Forward key exchange request
    if receiver in clients:
        emit('key_exchange_request', {
            'from': sender,
            'publicKey': public_key
        }, to=clients[receiver])

@socketio.on('key_exchange_response')
def key_exchange_response(data):
    sender = data['from']
    receiver = data['to']
    encrypted_key = data['encryptedKey']
    public_key = data['publicKey']
    
    # Verify they are contacts
    if receiver not in contacts.get(sender, set()):
        return
    
    # Forward key exchange response
    if receiver in clients:
        emit('key_exchange_response', {
            'from': sender,
            'encryptedKey': encrypted_key,
            'publicKey': public_key
        }, to=clients[receiver])

@socketio.on('send_message')
def send_message(data):
    sender = data['from']
    receiver = data['to']
    encrypted_message = data['message']

    # Verify they are contacts
    if receiver not in contacts.get(sender, set()):
        emit('error', {'message': 'Not in contact list'})
        return

    # Create message object with metadata
    message_obj = {
        'message': encrypted_message,
        'timestamp': datetime.now().isoformat(),
        'from': sender,
        'to': receiver
    }

    # Store in both users' history
    message_history.setdefault(sender, {})
    message_history.setdefault(receiver, {})
    message_history[sender].setdefault(receiver, [])
    message_history[receiver].setdefault(sender, [])
    
    message_history[sender][receiver].append(message_obj)
    message_history[receiver][sender].append(message_obj)
    
    # Persist messages
    save_messages()

    # Send to receiver if online (encrypted message)
    if receiver in clients:
        emit('receive_message', {
            'from': sender,
            'message': encrypted_message,
            'timestamp': message_obj['timestamp']
        }, to=clients[receiver])
    
    # Echo back to sender
    emit('receive_message', {
        'from': sender,
        'message': encrypted_message,
        'sent_by_me': True,
        'timestamp': message_obj['timestamp']
    }, to=clients[sender])

@socketio.on('load_message_history')
def load_message_history(data):
    user_pid = data['user_pid']
    friend_pid = data['friend_pid']
    
    # Get message history for this conversation
    history = message_history.get(user_pid, {}).get(friend_pid, [])
    
    emit('message_history', {
        'friend_pid': friend_pid,
        'messages': history
    })

@socketio.on('typing')
def handle_typing(data):
    sender = data['from']
    receiver = data['to']
    
    if receiver in clients and receiver in contacts.get(sender, set()):
        emit('typing', {'from': sender}, to=clients[receiver])

@socketio.on('stop_typing')
def handle_stop_typing(data):
    sender = data['from']
    receiver = data['to']
    
    if receiver in clients and receiver in contacts.get(sender, set()):
        emit('stop_typing', {'from': sender}, to=clients[receiver])

@socketio.on('delete_contact')
def delete_contact(data):
    user_pid = data['user_pid']
    contact_pid = data['contact_pid']
    
    # Remove from contacts
    if user_pid in contacts and contact_pid in contacts[user_pid]:
        contacts[user_pid].remove(contact_pid)
        save_contacts()
        
        emit('contact_deleted', {'contact_pid': contact_pid})

if __name__ == '__main__':
    socketio.run(app, debug=True, host="0.0.0.0", port=5000)
from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret'
socketio = SocketIO(app, cors_allowed_origins="*")

clients = {}        # permanent_id -> socket_id
temp_keys = {}      # temp_key -> permanent_id
contacts = {}       # permanent_id -> set(permanent_ids)

@app.route('/')
def index():
    return render_template('index.html')

@socketio.on('register')
def register(data):
    pid = data['pid']
    temp = data['temp']

    clients[pid] = request.sid
    temp_keys[temp] = pid
    contacts.setdefault(pid, set())

    # Restore contacts on refresh
    emit('restore_contacts', list(contacts[pid]))

@socketio.on('request_connect')
def request_connect(data):
    sender_pid = data['sender_pid']
    target_temp = data['target_temp']

    if target_temp not in temp_keys:
        return

    target_pid = temp_keys[target_temp]
    emit('incoming_request', sender_pid, to=clients[target_pid])

@socketio.on('accept_request')
def accept_request(data):
    a = data['acceptor']
    b = data['sender']

    contacts[a].add(b)
    contacts[b].add(a)

    emit('request_accepted', b, to=clients[a])
    emit('request_accepted', a, to=clients[b])

@socketio.on('send_message')
def send_message(data):
    sender = data['from']
    receiver = data['to']
    message = data['message']

    if receiver not in contacts.get(sender, set()):
        return

    emit('receive_message', {
        'from': sender,
        'message': message
    }, to=clients[receiver])

    emit('receive_message', {
        'from': sender,
        'message': message
    }, to=clients[sender])

if __name__ == '__main__':
    socketio.run(app, debug=True)

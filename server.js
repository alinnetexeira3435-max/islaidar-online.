
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const rooms = new Map();

// Localiza a pasta do jogo
const publicDir = path.join(__dirname, 'public');
const gameDir = fs.existsSync(path.join(publicDir, 'index.html'))
  ? publicDir
  : __dirname;

// Publica os arquivos do jogo
app.use(express.static(gameDir));

app.get('/', (req, res) => {
  res.sendFile(path.join(gameDir, 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ ok: true, game: 'ISLAIDAR Online' });
});

function cleanName(v) {
  return String(v || 'Sobrevivente')
    .replace(/[^\p{L}\p{N}_ -]/gu, '')
    .trim().slice(0, 16) || 'Sobrevivente';
}

io.on('connection', socket => {
  let currentRoom = null;

  socket.on('join-room', data => {
    const room = String(data?.room || 'ilha-islaidar').slice(0, 32);

    if (currentRoom) {
      socket.leave(currentRoom);
      rooms.get(currentRoom)?.delete(socket.id);
    }

    const members = rooms.get(room) || new Map();

    if (members.size >= 12) {
      socket.emit('room-full');
      return;
    }

    currentRoom = room;
    socket.join(room);

    const player = {
      id: socket.id,
      name: cleanName(data?.name),
      x: 0, y: 0, z: 0, yaw: 0,
      started: false
    };

    members.set(socket.id, player);
    rooms.set(room, members);

    socket.emit('room-state',
      [...members.values()]
        .filter(p => p.id !== socket.id)
        .map(p => ({ id: p.id, name: p.name }))
    );

    socket.to(room).emit('player-joined', {
      id: player.id,
      name: player.name
    });
  });

  socket.on('player-state', data => {
    const p = rooms.get(currentRoom)?.get(socket.id);
    if (!p || !data) return;

    for (const k of ['x', 'y', 'z', 'yaw']) {
      const n = Number(data[k]);
      if (Number.isFinite(n)) {
        p[k] = Math.max(-2000, Math.min(2000, n));
      }
    }

    p.started = !!data.started;

    socket.to(currentRoom).volatile.emit('player-update', {
      id: p.id, x: p.x, y: p.y, z: p.z,
      yaw: p.yaw, started: p.started
    });
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;

    const members = rooms.get(currentRoom);
    if (members) {
      members.delete(socket.id);
      socket.to(currentRoom).emit('player-left', socket.id);

      if (!members.size) rooms.delete(currentRoom);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ISLAIDAR Online na porta ${PORT}`);
});


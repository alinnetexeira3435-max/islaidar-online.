const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e5 });
const PORT = process.env.PORT || 3000;
const rooms = new Map();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, game: 'ISLAIDAR Online' }));
function cleanName(v) { return String(v || 'Sobrevivente').replace(/[^\p{L}\p{N}_ -]/gu, '').trim().slice(0,16) || 'Sobrevivente'; }
function roomPlayers(room) { return [...(rooms.get(room)?.values() || [])].map(p => ({ id:p.id, name:p.name })); }
io.on('connection', socket => {
  let currentRoom = null;
  socket.on('join-room', data => {
    const room = String(data?.room || 'ilha-islaidar').slice(0,32);
    if (currentRoom) socket.leave(currentRoom);
    currentRoom = room; socket.join(room);
    if (!rooms.has(room)) rooms.set(room, new Map());
    const members = rooms.get(room);
    if (members.size >= 12) { socket.emit('room-full'); return; }
    const player = { id:socket.id, name:cleanName(data?.name), x:0, y:0, z:0, yaw:0, started:false };
    members.set(socket.id, player);
    socket.emit('room-state', [...members.values()].filter(p=>p.id!==socket.id).map(p=>({id:p.id,name:p.name})));
    socket.to(room).emit('player-joined', {id:player.id,name:player.name});
  });
  socket.on('set-name', data => { const p=rooms.get(currentRoom)?.get(socket.id); if(!p)return; p.name=cleanName(data?.name); io.to(currentRoom).emit('player-joined',{id:p.id,name:p.name}); });
  socket.on('ready', () => { const p=rooms.get(currentRoom)?.get(socket.id); if(p)p.started=true; });
  socket.on('player-state', data => {
    const p=rooms.get(currentRoom)?.get(socket.id); if(!p || !data)return;
    for (const k of ['x','y','z','yaw']) { const n=Number(data[k]); if(Number.isFinite(n)) p[k]=Math.max(-2000,Math.min(2000,n)); }
    p.started=!!data.started;
    socket.to(currentRoom).volatile.emit('player-update',{id:p.id,x:p.x,y:p.y,z:p.z,yaw:p.yaw,started:p.started});
  });
  socket.on('disconnect', () => {
    if(!currentRoom)return; const members=rooms.get(currentRoom); if(members){members.delete(socket.id);socket.to(currentRoom).emit('player-left',socket.id);if(!members.size)rooms.delete(currentRoom);}
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`ISLAIDAR Online rodando na porta ${PORT}`));

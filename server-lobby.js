module.exports = (io, socket) => {
// ISLAIDAR ONLINE — amigos, equipe e chat da equipe.
// Cole DENTRO de io.on('connection', socket => { ... }) no seu server.js.
// Pré-requisito: nos seus handlers 'join-room' e 'set-name', salve o nome: socket.data.name = nome;

const T = (global.islaidarTeams ??= new Map());   // socket.id -> Set de ids da equipe (Set compartilhado)
const F = (global.islaidarFriends ??= new Map()); // nome em minúsculas -> Set de nomes de amigos
const low = n => String(n || '').toLowerCase();
const byName = n => [...io.sockets.sockets.values()].find(s => low(s.data.name) === low(n));
const friendsOf = () => [...(F.get(low(socket.data.name)) || [])].map(n => {
  const s = byName(n);
  return { id: s ? s.id : n, name: n, online: !!s };
});
const sendFriends = () => socket.emit('friends-state', { friends: friendsOf() });
const sendTeam = set => set.forEach(id => io.to(id).emit('team-update', {
  members: [...set].map(i => ({ id: i, name: io.sockets.sockets.get(i)?.data.name || '?' }))
}));
const leaveTeam = () => {
  const set = T.get(socket.id);
  if (!set) return;
  set.delete(socket.id); T.delete(socket.id);
  socket.emit('team-update', { members: [] });
  if (set.size) sendTeam(set);
};

setTimeout(sendFriends, 500);

socket.on('friend-add', ({ name } = {}) => {
  const me = low(socket.data.name), other = String(name || '').trim().slice(0, 16);
  if (!other || low(other) === me) return;
  if (!F.has(me)) F.set(me, new Set());
  F.get(me).add(other);
  sendFriends();
});

// Convite entra direto na equipe (sem tela de aceitar). Máximo de 4 jogadores.
socket.on('team-invite', ({ to } = {}) => {
  const target = io.sockets.sockets.get(to) || byName(to);
  if (!target || target.id === socket.id) return;
  const set = T.get(socket.id) || new Set([socket.id]);
  if (set.size >= 4 || set.has(target.id)) return;
  T.get(target.id)?.delete(target.id);
  set.add(target.id);
  set.forEach(id => T.set(id, set));
  sendTeam(set);
});

socket.on('team-chat', ({ text } = {}) => {
  const set = T.get(socket.id);
  if (!set) return;
  const msg = { name: socket.data.name || '?', text: String(text || '').slice(0, 120) };
  set.forEach(id => { if (id !== socket.id) io.to(id).emit('team-chat', msg); });
});

socket.on('team-leave', leaveTeam);
socket.on('disconnect', leaveTeam);

};

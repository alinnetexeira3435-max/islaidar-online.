// ISLAIDAR ONLINE — servidor: serve o jogo (jogo.html + lobby.html), contas, banco SQLite e socket.io.
// Variáveis: JWT_SECRET (obrigatória), GOOGLE_CLIENT_ID, FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, DB_PATH, PORT
const fs = require('fs'), express = require('express'), http = require('http'), path = require('path'), crypto = require('crypto');
const { Server } = require('socket.io'), jwt = require('jsonwebtoken'), Database = require('better-sqlite3');
const { OAuth2Client } = require('google-auth-library');
const { JWT_SECRET, GOOGLE_CLIENT_ID, FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, DB_PATH = 'islaidar.db', PORT = 3000 } = process.env;
if (!JWT_SECRET) { console.error('Defina JWT_SECRET'); process.exit(1); }

const db = new Database(DB_PATH); db.pragma('journal_mode=WAL');
db.exec(`CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, nick TEXT, guest_key TEXT UNIQUE, google_id TEXT UNIQUE,
  facebook_id TEXT UNIQUE, data TEXT DEFAULT '{}', created INTEGER, updated INTEGER)`);
const app = express(), server = http.createServer(app), io = new Server(server);
app.use(express.json({ limit: '20kb' }));

const safe = (v, d = 'Sobrevivente') => String(v || d).replace(/[^\p{L}\p{N}_ -]/gu, '').trim().slice(0, 16) || d;
const by = (col, v) => db.prepare(`SELECT * FROM accounts WHERE ${col}=?`).get(v); // col vem sempre do código
const newId = () => { for (;;) { const id = 'ISL-' + crypto.randomInt(1e7, 1e8); if (!by('id', id)) return id; } };
const create = f => {
  const id = newId(), t = Date.now();
  db.prepare('INSERT INTO accounts(id,nick,guest_key,google_id,facebook_id,created,updated) VALUES(?,?,?,?,?,?,?)')
    .run(id, safe(f.nick), f.guest_key || null, f.google_id || null, f.facebook_id || null, t, t);
  return by('id', id);
};
const view = a => ({ id: a.id, nick: a.nick, guest: !a.google_id && !a.facebook_id, google: !!a.google_id, facebook: !!a.facebook_id, data: JSON.parse(a.data || '{}') });
const session = a => ({ token: jwt.sign({ id: a.id }, JWT_SECRET, { expiresIn: '90d' }), account: view(a) });

// ---- verificação real dos provedores (o servidor nunca confia no cliente)
const gc = new OAuth2Client(GOOGLE_CLIENT_ID);
const verify = {
  async google({ credential }) {
    if (!GOOGLE_CLIENT_ID) throw { status: 503, message: 'Google não configurado no servidor' };
    const p = (await gc.verifyIdToken({ idToken: String(credential), audience: GOOGLE_CLIENT_ID })).getPayload();
    return { col: 'google_id', pid: p.sub, nick: p.given_name || p.name };
  },
  async facebook({ accessToken }) {
    if (!FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET) throw { status: 503, message: 'Facebook não configurado no servidor' };
    const g = 'https://graph.facebook.com/', t = encodeURIComponent(accessToken);
    const d = (await (await fetch(`${g}debug_token?input_token=${t}&access_token=${FACEBOOK_APP_ID}|${FACEBOOK_APP_SECRET}`)).json()).data;
    if (!d || !d.is_valid || d.app_id !== FACEBOOK_APP_ID) throw Error('token Facebook inválido');
    const me = await (await fetch(`${g}me?fields=id,first_name&access_token=${t}`)).json();
    if (!me.id || me.id !== d.user_id) throw Error('token Facebook inválido');
    return { col: 'facebook_id', pid: me.id, nick: me.first_name };
  }
};
const wrap = f => (req, res) => f(req, res).catch(e => {
  console.error(e.message); res.status(e.status || 401).json({ error: e.status ? e.message : 'Falha na autenticação' });
});
const auth = (req, res, next) => {
  try { req.acc = by('id', jwt.verify((req.headers.authorization || '').slice(7), JWT_SECRET).id); if (!req.acc) throw 0; next(); }
  catch (e) { res.status(401).json({ error: 'Sessão inválida' }); }
};
const provider = p => { if (!Object.hasOwn(verify, p)) throw { status: 404, message: 'Provedor desconhecido' }; return verify[p]; };

app.get('/api/config', (q, r) => r.json({ googleClientId: GOOGLE_CLIENT_ID || null, facebookAppId: FACEBOOK_APP_ID || null }));
app.get('/api/session', auth, (req, res) => res.json(session(req.acc)));

app.post('/api/auth/guest', wrap(async (req, res) => {
  const k = String(req.body.guestKey || '');
  let a = k.length >= 32 && by('guest_key', k);
  if (!a) a = create({ guest_key: crypto.randomBytes(24).toString('hex'), nick: 'Sobrevivente' });
  res.json({ ...session(a), guestKey: a.guest_key });
}));
app.post('/api/auth/:p', wrap(async (req, res) => {
  const v = await provider(req.params.p)(req.body);
  res.json(session(by(v.col, v.pid) || create({ nick: v.nick, [v.col]: v.pid })));
}));
// Vincula Google/Facebook à conta atual (ex.: convidado) sem perder o progresso
app.post('/api/link/:p', auth, wrap(async (req, res) => {
  const v = await provider(req.params.p)(req.body), o = by(v.col, v.pid);
  if ((o && o.id !== req.acc.id) || (req.acc[v.col] && req.acc[v.col] !== v.pid))
    throw { status: 409, message: 'Essa conta já está ligada a outro perfil de jogo' };
  db.prepare(`UPDATE accounts SET ${v.col}=?,updated=? WHERE id=?`).run(v.pid, Date.now(), req.acc.id);
  res.json(session(by('id', req.acc.id)));
}));

// Salva o progresso (valores validados; contadores nunca diminuem)
const n = (v, max = 1e9) => Math.max(0, Math.min(max, Math.floor(+v) || 0));
app.put('/api/profile', auth, (req, res) => {
  const o = JSON.parse(req.acc.data || '{}'), b = req.body || {}, os = o.stats || {}, bs = b.stats || {}, bl = b.lobby || {};
  const stats = {}; for (const k of ['kills', 'assists', 'partidas', 'vitorias', 'xp']) stats[k] = Math.max(n(os[k]), n(bs[k]));
  const lobby = { nome: safe(bl.nome), coins: n(bl.coins), dia: n(bl.dia), skin: safe(bl.skin, 'neon'),
    owned: (Array.isArray(bl.owned) ? bl.owned : ['neon']).slice(0, 40).map(x => safe(x, 'neon')),
    gun: n(bl.gun, 9), cofre: n(bl.cofre, 4e12), modo: safe(bl.modo, 'classico') };
  const data = { pts: Math.max(n(o.pts), n(b.pts)), stats, lobby };
  db.prepare('UPDATE accounts SET nick=?,data=?,updated=? WHERE id=?').run(lobby.nome, JSON.stringify(data), Date.now(), req.acc.id);
  res.json({ ok: true });
});
// Serve só estes dois arquivos (nunca o servidor nem o banco). Funciona com tudo na raiz ou dentro de public/
const dir = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
app.get(['/', '/jogo.html'], (q, r) => r.sendFile(path.join(dir, 'jogo.html')));
app.get('/lobby.html', (q, r) => r.sendFile(path.join(dir, 'lobby.html')));

// ---- tempo real: só entra quem tem sessão válida
io.use((s, next) => {
  try { const a = by('id', jwt.verify(String(s.handshake.auth.token || ''), JWT_SECRET).id); if (!a) throw 0; s.data.name = a.nick; next(); }
  catch (e) { next(new Error('auth')); }
});
const ROOM = 'ilha-islaidar';
const list = () => [...io.sockets.sockets.values()].filter(s => s.data.joined).map(s => ({ id: s.id, name: s.data.name }));
io.on('connection', socket => {
  require('./server-lobby.js')(io, socket);
  socket.on('join-room', ({ name } = {}) => {
    socket.data.name = safe(name, socket.data.name); socket.data.joined = true; socket.join(ROOM);
    socket.emit('room-state', list().filter(p => p.id !== socket.id));
    socket.to(ROOM).emit('player-joined', { id: socket.id, name: socket.data.name });
  });
  socket.on('set-name', ({ name } = {}) => {
    socket.data.name = safe(name, socket.data.name);
    socket.to(ROOM).emit('player-joined', { id: socket.id, name: socket.data.name });
  });
  socket.on('player-state', p => { if (p) socket.to(ROOM).volatile.emit('player-update', { id: socket.id, x: +p.x || 0, y: +p.y || 0, z: +p.z || 0, yaw: +p.yaw || 0, started: !!p.started }); });
  socket.on('disconnect', () => { if (socket.data.joined) socket.to(ROOM).emit('player-left', socket.id); });
});
server.listen(PORT, () => console.log('ISLAIDAR ONLINE na porta ' + PORT));

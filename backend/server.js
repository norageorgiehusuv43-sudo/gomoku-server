/**
 * 五子棋微信小程序 - 极简 WebSocket 房间中继后端
 * ------------------------------------------------------------
 * 职责（保持极简，符合"仅作为房间管理与双方落子中继"的定位）：
 *   1. 创建/加入房间（房主/访客是固定不变的"身份"，与黑白棋色是两回事）
 *   2. 双人准备状态同步，双方都 ready 后开局
 *   3. 落子广播（不做禁手/胜负复杂演算，胜负与禁手判定完全由前端 utils/rules.js 完成，
 *      前端算出结果后通过 game_over 消息告知服务器，服务器只负责转发给对方，
 *      这样可以保证前后端规则完全一致，服务器不需要重复实现一遍规则算法）
 *   4. 断线通知与断线重连后的棋局状态同步（sync_state）
 *   5. 一局结束后，双方可再次 ready 开始下一局，"谁先手"在房主/访客之间轮换
 *
 * 关于颜色分配（重要）：
 *   黑棋 = 本局先手，白棋 = 本局后手。"谁是黑棋"每一局都会变，不是固定
 *   绑定给某个人的身份。房间里真正稳定不变的身份是"房主(host，创建房间
 *   的人)"和"访客(guest，扫码/点列表加入的人)"。每一局开始时，服务器
 *   广播的是"这一局谁先手"（用 host/guest 表达，不是用颜色），双方各自
 *   据此换算出"我这一局是黑棋还是白棋"——这样"创建房间的人永远是黑棋"
 *   这种错误的固定绑定就不存在了：第 1 局默认房主先手（=黑棋），从第 2
 *   局起自动轮换，谁先手谁就是黑棋。
 *
 * 部署：Render -> Web Service -> Start Command: npm start
 * 环境变量：PORT（Render 会自动注入，本地默认 8080）
 */

const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

// ------------------------------------------------------------
// 基础 HTTP 服务（用于 Render 健康检查 + WebSocket 升级）
// ------------------------------------------------------------
const httpServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('wuziqi-ws-server is running');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server: httpServer });

// ------------------------------------------------------------
// 房间数据结构（全部保存在内存中，Render 免费实例重启会清空，
// 前端已做本地缓存兜底，不影响棋局本地续玩体验）
// ------------------------------------------------------------
// rooms: Map<roomId, RoomState>
// RoomState = {
//   id: string,
//   banRule: boolean,           // 是否开启禁手
//   seats: { host: SeatInfo|null, guest: SeatInfo|null },  // 固定身份，不代表颜色
//   ready: { host: boolean, guest: boolean },
//   board: number[15][15],      // 0 空 1 黑 2 白，仅用于断线重连同步
//   moves: [{x,y,color}],       // color 仍然是 'black'/'white'，board 本身就是颜色语义
//   turn: 'black' | 'white',
//   gameStarted: boolean,
//   gameOver: boolean,
//   winner: 'black' | 'white' | 'draw' | null,
//   roundNumber: number,
//   firstRoleThisRound: 'host' | 'guest',  // 本局谁先手（=谁是黑棋）
//   createdAt: number,
// }
// SeatInfo = { ws: WebSocket|null, token: string, connected: boolean }

const rooms = new Map();

const BOARD_SIZE = 15;
const ROLES = ['host', 'guest'];

function makeEmptyBoard() {
  const board = [];
  for (let i = 0; i < BOARD_SIZE; i++) {
    board.push(new Array(BOARD_SIZE).fill(0));
  }
  return board;
}

function genRoomId() {
  // 6 位数字房间号，便于口头传达
  let id;
  do {
    id = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(id));
  return id;
}

function genToken() {
  return crypto.randomBytes(12).toString('hex');
}

function send(ws, type, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type, payload: payload || {} }));
  } catch (e) {
    // 忽略单次发送失败，不影响整体服务
  }
}

/** 棋子颜色的对手方（黑/白互换，board 语义层面用得到，和身份 role 无关） */
function otherColor(color) {
  return color === 'black' ? 'white' : 'black';
}

/** 身份的对手方（房主/访客互换） */
function otherRole(role) {
  return role === 'host' ? 'guest' : 'host';
}

/** 某个身份在"本局"里对应的棋色：谁是本局先手谁就是黑棋 */
function colorOfRole(room, role) {
  return role === room.firstRoleThisRound ? 'black' : 'white';
}

/** 某个棋色在"本局"里对应的身份，用于根据落子颜色反查是谁下的 */
function roleOfColor(room, color) {
  return color === 'black' ? room.firstRoleThisRound : otherRole(room.firstRoleThisRound);
}

function broadcastToRoom(room, type, payload, excludeRole) {
  ROLES.forEach((role) => {
    if (role === excludeRole) return;
    const seat = room.seats[role];
    if (seat && seat.ws) send(seat.ws, type, payload);
  });
}

function roomSnapshot(room) {
  return {
    roomId: room.id,
    banRule: room.banRule,
    board: room.board,
    moves: room.moves,
    turn: room.turn,
    gameStarted: room.gameStarted,
    gameOver: room.gameOver,
    winner: room.winner,
    roundNumber: room.roundNumber,
    firstRole: room.firstRoleThisRound,
    ready: room.ready,
    hostConnected: !!(room.seats.host && room.seats.host.connected),
    guestConnected: !!(room.seats.guest && room.seats.guest.connected),
  };
}

/**
 * 只重置"棋盘内容与先后手轮转"，不碰 gameStarted/gameOver/ready 这些状态位
 * ——这些状态位由 handleReady 在真正确认双方都点击"再来一局"之后统一设置，
 * 避免和 handleGameOver 的收尾时机产生竞态。
 */
function prepareNextRoundContent(room) {
  room.board = makeEmptyBoard();
  room.moves = [];
  room.winner = null;
  // 轮流换先：本轮先手身份 = 上一轮先手身份的对方（谁先手谁就是黑棋）
  room.firstRoleThisRound = otherRole(room.firstRoleThisRound);
  room.roundNumber += 1;
}

// ------------------------------------------------------------
// 每条连接携带的上下文
// ------------------------------------------------------------
wss.on('connection', (ws) => {
  ws.ctx = { roomId: null, role: null, token: null };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      send(ws, 'error', { message: '消息格式错误' });
      return;
    }
    const { type, payload } = msg || {};
    if (!type) return;

    switch (type) {
      case 'list_rooms':
        handleListRooms(ws);
        break;
      case 'create_room':
        handleCreateRoom(ws, payload || {});
        break;
      case 'join_room':
        handleJoinRoom(ws, payload || {});
        break;
      case 'ready':
        handleReady(ws);
        break;
      case 'move':
        handleMove(ws, payload || {});
        break;
      case 'undo':
        handleUndo(ws);
        break;
      case 'chat':
        handleChat(ws, payload || {});
        break;
      case 'game_over':
        handleGameOver(ws, payload || {});
        break;
      case 'sync_request':
        handleSyncRequest(ws);
        break;
      case 'leave':
        handleLeave(ws);
        break;
      default:
        send(ws, 'error', { message: '未知消息类型: ' + type });
    }
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });

  ws.on('error', () => {
    handleDisconnect(ws);
  });
});

// ------------------------------------------------------------
// 处理函数
// ------------------------------------------------------------
// ------------------------------------------------------------
// 房间列表（取消"手动输入房间号"后，客户端在联机首页轮询这个接口
// 获取当前"仅房主在线、访客席位空缺、尚未开局"的可加入房间）
// ------------------------------------------------------------
function getOpenRoomsList() {
  const list = [];
  for (const room of rooms.values()) {
    const hostOnline = room.seats.host && room.seats.host.connected;
    const guestTaken = room.seats.guest && room.seats.guest.connected;
    if (hostOnline && !guestTaken && !room.gameStarted) {
      list.push({
        roomId: room.id,
        banRule: room.banRule,
        createdAt: room.createdAt,
      });
    }
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  return list.slice(0, 30);
}

function handleListRooms(ws) {
  send(ws, 'room_list', { rooms: getOpenRoomsList() });
}

function handleCreateRoom(ws, payload) {
  const banRule = !!payload.banRule;
  const roomId = genRoomId();
  const token = genToken();

  const room = {
    id: roomId,
    banRule,
    seats: {
      host: { ws, token, connected: true },
      guest: null,
    },
    ready: { host: false, guest: false },
    board: makeEmptyBoard(),
    moves: [],
    turn: 'black',
    gameStarted: false,
    gameOver: false,
    winner: null,
    roundNumber: 1,
    firstRoleThisRound: 'host', // 第 1 局默认房主先手（=黑棋）
    createdAt: Date.now(),
  };
  rooms.set(roomId, room);

  ws.ctx = { roomId, role: 'host', token };

  send(ws, 'room_created', {
    roomId,
    seat: 'host',
    token,
    banRule,
  });
}

function handleJoinRoom(ws, payload) {
  const { roomId, token } = payload;
  if (!roomId || !rooms.has(roomId)) {
    send(ws, 'join_error', { message: '房间不存在或已过期' });
    return;
  }
  const room = rooms.get(roomId);

  // 场景 1：携带 token 重连原有身份
  if (token) {
    const role = room.seats.host && room.seats.host.token === token
      ? 'host'
      : (room.seats.guest && room.seats.guest.token === token ? 'guest' : null);
    if (role) {
      room.seats[role].ws = ws;
      room.seats[role].connected = true;
      ws.ctx = { roomId, role, token };
      send(ws, 'joined', { roomId, seat: role, token, banRule: room.banRule, reconnected: true });
      send(ws, 'sync_state', roomSnapshot(room));
      const oppRole = otherRole(role);
      if (room.seats[oppRole] && room.seats[oppRole].ws) {
        send(room.seats[oppRole].ws, 'opponent_reconnected', {});
      }
      return;
    }
  }

  // 场景 2：作为新玩家加入（占据访客身份）
  if (room.seats.guest && room.seats.guest.connected) {
    send(ws, 'join_error', { message: '房间已满' });
    return;
  }
  const newToken = genToken();
  room.seats.guest = { ws, token: newToken, connected: true };
  ws.ctx = { roomId, role: 'guest', token: newToken };

  send(ws, 'joined', { roomId, seat: 'guest', token: newToken, banRule: room.banRule });
  send(ws, 'sync_state', roomSnapshot(room));

  if (room.seats.host && room.seats.host.ws) {
    send(room.seats.host.ws, 'opponent_joined', {});
  }
}

function handleReady(ws) {
  const room = getRoomOrNotify(ws);
  if (!room) return;
  const { role } = ws.ctx;
  if (room.gameStarted && !room.gameOver) return; // 对局进行中忽略

  room.ready[role] = true;
  broadcastToRoom(room, 'ready_state', { host: room.ready.host, guest: room.ready.guest });

  // 首局（尚未开始过）或上一局已结束、双方都再次点击了准备 -> 开始新一局
  if (room.ready.host && room.ready.guest && (!room.gameStarted || room.gameOver)) {
    if (room.gameStarted && room.gameOver) {
      // 这是"再来一局"：上一局确实已经结束，此时才真正重置棋盘、轮转先手、局数+1
      prepareNextRoundContent(room);
    }
    room.gameStarted = true;
    room.gameOver = false;
    room.turn = 'black'; // 每局黑棋（=本局先手方）永远先走
    broadcastToRoom(room, 'game_start', {
      firstRole: room.firstRoleThisRound,
      roundNumber: room.roundNumber,
    });
  }
}

function handleMove(ws, payload) {
  const room = getRoomOrNotify(ws);
  if (!room) return;
  const { role } = ws.ctx;
  const { x, y } = payload;

  if (!room.gameStarted || room.gameOver) {
    send(ws, 'move_error', { message: '对局尚未开始或已结束' });
    return;
  }

  const color = colorOfRole(room, role); // 这个身份在本局里是黑是白
  if (room.turn !== color) {
    send(ws, 'move_error', { message: '还未轮到你落子' });
    return;
  }
  if (
    typeof x !== 'number' || typeof y !== 'number' ||
    x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE
  ) {
    send(ws, 'move_error', { message: '落子坐标非法' });
    return;
  }
  if (room.board[x][y] !== 0) {
    send(ws, 'move_error', { message: '该位置已有棋子' });
    return;
  }

  // 服务器只做结构校验（越界/占用/轮次），禁手与胜负交给前端 rules.js 判定，
  // 前端判定完成后会另外发送 game_over 消息。
  const colorValue = color === 'black' ? 1 : 2;
  room.board[x][y] = colorValue;
  const moveIndex = room.moves.length + 1;
  room.moves.push({ x, y, color, moveIndex });
  room.turn = otherColor(color);

  broadcastToRoom(room, 'move', { x, y, color, moveIndex, nextTurn: room.turn });
}

/**
 * 悔棋：无需对方同意，任意一方随时可撤销"棋盘上最后一手"棋。
 * 撤销后回合交还给刚才落下这枚棋子的一方，让其重新落子。
 */
function handleUndo(ws) {
  const room = getRoomOrNotify(ws);
  if (!room) return;
  if (!room.gameStarted || room.gameOver) return;
  if (room.moves.length === 0) return;

  const last = room.moves.pop();
  room.board[last.x][last.y] = 0;
  room.turn = last.color;

  broadcastToRoom(room, 'undo', {
    x: last.x,
    y: last.y,
    color: last.color,
    nextTurn: room.turn,
  });
}

/**
 * 房间内文字聊天中继，仅转发不存储，不做敏感词过滤（casual 场景）。
 * 携带的是稳定不变的身份 role（host/guest），不是会跨局变化的颜色，
 * 客户端据此显示"我"/"对方"，不会因为颜色跨局变化而认错人。
 */
function handleChat(ws, payload) {
  const room = getRoomOrNotify(ws);
  if (!room) return;
  const text = String(payload.text || '').slice(0, 300).trim();
  if (!text) return;

  broadcastToRoom(room, 'chat', {
    text,
    role: ws.ctx.role,
    ts: Date.now(),
  });
}

function handleGameOver(ws, payload) {
  const room = getRoomOrNotify(ws);
  if (!room) return;
  if (room.gameOver) return; // 双方客户端各自独立上报，这里保证只处理一次

  const { winner, reason } = payload; // winner: 'black' | 'white' | 'draw'
  room.gameOver = true;
  room.winner = winner || 'draw';
  // 清空准备状态，等双方在结算页再次点击"准备/再来一局"
  room.ready.host = false;
  room.ready.guest = false;

  broadcastToRoom(room, 'game_over', { winner: room.winner, reason: reason || '' });

  // 注意：棋盘重置、轮换先手、局数 +1 不在这里做，而是延后到 handleReady
  // 里"双方都再次点击准备"的那一刻才真正执行，避免和这里的收尾产生竞态。
}

function handleSyncRequest(ws) {
  const room = getRoomOrNotify(ws);
  if (!room) return;
  send(ws, 'sync_state', roomSnapshot(room));
}

function handleLeave(ws) {
  const room = getRoomOrNotify(ws, true);
  if (!room) return;
  const { role } = ws.ctx;
  if (room.seats[role]) {
    room.seats[role].connected = false;
    room.seats[role].ws = null;
  }
  broadcastToRoom(room, 'opponent_disconnected', {}, role);
  cleanupRoomIfEmpty(room);
  ws.ctx = { roomId: null, role: null, token: null };
}

function handleDisconnect(ws) {
  const ctx = ws.ctx;
  if (!ctx || !ctx.roomId) return;
  const room = rooms.get(ctx.roomId);
  if (!room) return;
  const { role } = ctx;
  if (room.seats[role] && room.seats[role].ws === ws) {
    room.seats[role].connected = false;
    room.seats[role].ws = null;
    broadcastToRoom(room, 'opponent_disconnected', {}, role);
  }
  cleanupRoomIfEmpty(room);
}

function cleanupRoomIfEmpty(room) {
  const hostGone = !room.seats.host || !room.seats.host.connected;
  const guestGone = !room.seats.guest || !room.seats.guest.connected;
  if (hostGone && guestGone) {
    // 双方都已离线：延迟销毁，给一段时间允许重连（比如切后台/弱网抖动）
    setTimeout(() => {
      const r = rooms.get(room.id);
      if (!r) return;
      const stillHostGone = !r.seats.host || !r.seats.host.connected;
      const stillGuestGone = !r.seats.guest || !r.seats.guest.connected;
      if (stillHostGone && stillGuestGone) {
        rooms.delete(room.id);
      }
    }, 10 * 60 * 1000); // 10 分钟无人重连则销毁房间
  }
}

function getRoomOrNotify(ws, silent) {
  const ctx = ws.ctx;
  if (!ctx || !ctx.roomId || !rooms.has(ctx.roomId)) {
    if (!silent) send(ws, 'error', { message: '未加入任何房间' });
    return null;
  }
  return rooms.get(ctx.roomId);
}

// ------------------------------------------------------------
// 定期清理超过 24 小时的孤立房间，防止内存泄漏
// ------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms.entries()) {
    const hostGone = !room.seats.host || !room.seats.host.connected;
    const guestGone = !room.seats.guest || !room.seats.guest.connected;
    if (hostGone && guestGone && now - room.createdAt > 24 * 60 * 60 * 1000) {
      rooms.delete(id);
    }
  }
}, 60 * 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`[wuziqi-ws-server] listening on port ${PORT}`);
});

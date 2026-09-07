/**
 * 五子棋微信小程序 - 极简 WebSocket 房间中继后端
 * ------------------------------------------------------------
 * 职责（保持极简，符合"仅作为房间管理与双方落子中继"的定位）：
 *   1. 创建/加入房间（房主默认黑棋）
 *   2. 双人准备状态同步，双方都 ready 后开局
 *   3. 落子广播（不做禁手/胜负复杂演算，胜负与禁手判定完全由前端 utils/rules.js 完成，
 *      前端算出结果后通过 game_over 消息告知服务器，服务器只负责转发给对方，
 *      这样可以保证前后端规则完全一致，服务器不需要重复实现一遍规则算法）
 *   4. 断线通知与断线重连后的棋局状态同步（sync_state）
 *   5. 一局结束后，双方可再次 ready 开始下一局，黑白自动轮换
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
//   seats: { black: SeatInfo|null, white: SeatInfo|null },
//   ready: { black: boolean, white: boolean },
//   board: number[15][15],      // 0 空 1 黑 2 白，仅用于断线重连同步
//   moves: [{x,y,color}],
//   turn: 'black' | 'white',
//   gameStarted: boolean,
//   gameOver: boolean,
//   winner: 'black' | 'white' | 'draw' | null,
//   roundNumber: number,
//   firstColorThisRound: 'black' | 'white',
//   createdAt: number,
// }
// SeatInfo = { ws: WebSocket|null, token: string, connected: boolean }

const rooms = new Map();

const BOARD_SIZE = 15;

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

function otherColor(color) {
  return color === 'black' ? 'white' : 'black';
}

function broadcastToRoom(room, type, payload, excludeColor) {
  ['black', 'white'].forEach((color) => {
    if (color === excludeColor) return;
    const seat = room.seats[color];
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
    firstColorThisRound: room.firstColorThisRound,
    ready: room.ready,
    blackConnected: !!(room.seats.black && room.seats.black.connected),
    whiteConnected: !!(room.seats.white && room.seats.white.connected),
  };
}

function resetBoardForNewRound(room) {
  room.board = makeEmptyBoard();
  room.moves = [];
  room.gameStarted = false;
  room.gameOver = false;
  room.winner = null;
  room.ready.black = false;
  room.ready.white = false;
  // 轮流换先：本轮先手 = 上一轮先手的对方
  room.firstColorThisRound = otherColor(room.firstColorThisRound);
  room.turn = room.firstColorThisRound;
  room.roundNumber += 1;
}

// ------------------------------------------------------------
// 每条连接携带的上下文
// ------------------------------------------------------------
wss.on('connection', (ws) => {
  ws.ctx = { roomId: null, color: null, token: null };

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
function handleCreateRoom(ws, payload) {
  const banRule = !!payload.banRule;
  const roomId = genRoomId();
  const token = genToken();

  const room = {
    id: roomId,
    banRule,
    seats: {
      black: { ws, token, connected: true },
      white: null,
    },
    ready: { black: false, white: false },
    board: makeEmptyBoard(),
    moves: [],
    turn: 'black',
    gameStarted: false,
    gameOver: false,
    winner: null,
    roundNumber: 1,
    firstColorThisRound: 'black',
    createdAt: Date.now(),
  };
  rooms.set(roomId, room);

  ws.ctx = { roomId, color: 'black', token };

  send(ws, 'room_created', {
    roomId,
    seat: 'black',
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

  // 场景 1：携带 token 重连原有座位
  if (token) {
    const seatColor = room.seats.black && room.seats.black.token === token
      ? 'black'
      : (room.seats.white && room.seats.white.token === token ? 'white' : null);
    if (seatColor) {
      room.seats[seatColor].ws = ws;
      room.seats[seatColor].connected = true;
      ws.ctx = { roomId, color: seatColor, token };
      send(ws, 'joined', { roomId, seat: seatColor, token, banRule: room.banRule, reconnected: true });
      send(ws, 'sync_state', roomSnapshot(room));
      const oppColor = otherColor(seatColor);
      if (room.seats[oppColor] && room.seats[oppColor].ws) {
        send(room.seats[oppColor].ws, 'opponent_reconnected', {});
      }
      return;
    }
  }

  // 场景 2：作为新玩家加入（占据白棋座位）
  if (room.seats.white && room.seats.white.connected) {
    send(ws, 'join_error', { message: '房间已满' });
    return;
  }
  const newToken = genToken();
  room.seats.white = { ws, token: newToken, connected: true };
  ws.ctx = { roomId, color: 'white', token: newToken };

  send(ws, 'joined', { roomId, seat: 'white', token: newToken, banRule: room.banRule });
  send(ws, 'sync_state', roomSnapshot(room));

  if (room.seats.black && room.seats.black.ws) {
    send(room.seats.black.ws, 'opponent_joined', {});
  }
}

function handleReady(ws) {
  const room = getRoomOrNotify(ws);
  if (!room) return;
  const { color } = ws.ctx;
  if (room.gameStarted && !room.gameOver) return; // 对局进行中忽略

  room.ready[color] = true;
  broadcastToRoom(room, 'ready_state', { black: room.ready.black, white: room.ready.white });

  if (room.ready.black && room.ready.white && !room.gameStarted) {
    room.gameStarted = true;
    room.gameOver = false;
    room.turn = room.firstColorThisRound;
    broadcastToRoom(room, 'game_start', {
      firstColor: room.firstColorThisRound,
      roundNumber: room.roundNumber,
    });
  }
}

function handleMove(ws, payload) {
  const room = getRoomOrNotify(ws);
  if (!room) return;
  const { color } = ws.ctx;
  const { x, y } = payload;

  if (!room.gameStarted || room.gameOver) {
    send(ws, 'move_error', { message: '对局尚未开始或已结束' });
    return;
  }
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

function handleGameOver(ws, payload) {
  const room = getRoomOrNotify(ws);
  if (!room) return;
  if (room.gameOver) return;

  const { winner, reason } = payload; // winner: 'black' | 'white' | 'draw'
  room.gameOver = true;
  room.winner = winner || 'draw';

  broadcastToRoom(room, 'game_over', { winner: room.winner, reason: reason || '' });

  // 为下一局做准备：重置棋盘与准备状态，轮换先手
  resetBoardForNewRound(room);
}

function handleSyncRequest(ws) {
  const room = getRoomOrNotify(ws);
  if (!room) return;
  send(ws, 'sync_state', roomSnapshot(room));
}

function handleLeave(ws) {
  const room = getRoomOrNotify(ws, true);
  if (!room) return;
  const { color } = ws.ctx;
  if (room.seats[color]) {
    room.seats[color].connected = false;
    room.seats[color].ws = null;
  }
  broadcastToRoom(room, 'opponent_disconnected', {}, color);
  cleanupRoomIfEmpty(room);
  ws.ctx = { roomId: null, color: null, token: null };
}

function handleDisconnect(ws) {
  const ctx = ws.ctx;
  if (!ctx || !ctx.roomId) return;
  const room = rooms.get(ctx.roomId);
  if (!room) return;
  const { color } = ctx;
  if (room.seats[color] && room.seats[color].ws === ws) {
    room.seats[color].connected = false;
    room.seats[color].ws = null;
    broadcastToRoom(room, 'opponent_disconnected', {}, color);
  }
  cleanupRoomIfEmpty(room);
}

function cleanupRoomIfEmpty(room) {
  const blackGone = !room.seats.black || !room.seats.black.connected;
  const whiteGone = !room.seats.white || !room.seats.white.connected;
  if (blackGone && whiteGone) {
    // 双方都已离线：延迟销毁，给一段时间允许重连（比如切后台/弱网抖动）
    setTimeout(() => {
      const r = rooms.get(room.id);
      if (!r) return;
      const stillBlackGone = !r.seats.black || !r.seats.black.connected;
      const stillWhiteGone = !r.seats.white || !r.seats.white.connected;
      if (stillBlackGone && stillWhiteGone) {
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
    const blackGone = !room.seats.black || !room.seats.black.connected;
    const whiteGone = !room.seats.white || !room.seats.white.connected;
    if (blackGone && whiteGone && now - room.createdAt > 24 * 60 * 60 * 1000) {
      rooms.delete(id);
    }
  }
}, 60 * 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`[wuziqi-ws-server] listening on port ${PORT}`);
});

const { WebSocketServer } = require('ws');
const port = process.env.PORT || 8080;
const wss = new WebSocketServer({ port });

console.log(`五子棋服务已启动，端口: ${port}`);

wss.on('connection', (ws) => {
  console.log('有玩家加入');
  ws.on('message', (message) => {
    // 把落子信息广播给其他玩家
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === ws.OPEN) {
        client.send(message.toString());
      }
    });
  });
  ws.on('close', () => console.log('玩家退出'));
});

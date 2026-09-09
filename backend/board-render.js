/**
 * utils/board-render.js
 * ------------------------------------------------------------
 * 国际标准五子棋棋盘的 Canvas 2D 绘制封装，供
 * pages/online、pages/ai、pages/replay 三个页面共用，
 * 保证棋盘视觉风格与坐标换算逻辑完全一致。
 *
 * 规格：
 *   - 15 x 15 交叉线（225 个落子点），棋子落在交叉点上
 *   - 纯白棋盘背景，深灰细网格线
 *   - 5 个星位（天元 + 四星）
 *   - 黑/白棋子径向渐变 + 投影，立体感
 *   - 禁手点红色 ❌ 标记
 *   - 最后一步棋子中心红点标记（呼吸光圈由页面用 CSS 叠加层实现，见页面 wxml/wxss）
 */

const BOARD_SIZE = 15;
const MARGIN_RATIO = 0.08;

const COLOR_BG = '#FFFFFF';
const COLOR_GRID = '#333333';
const COLOR_STAR = '#333333';
const COLOR_FORBIDDEN = '#FF3B30';
const COLOR_LAST_DOT = '#FF3B30';
const COLOR_WIN_RING = '#FFA500';
const COLOR_HINT = '#2F80ED';

const STAR_POINTS = [
  [3, 3], [3, 11], [11, 3], [11, 11], [7, 7],
];

/** 获取设备像素比（做兼容处理） */
function getPixelRatio() {
  try {
    return wx.getWindowInfo().pixelRatio || 2;
  } catch (e) {
    try {
      return wx.getSystemInfoSync().pixelRatio || 2;
    } catch (e2) {
      return 2;
    }
  }
}

/**
 * 初始化 canvas（type="2d"），返回 { canvas, ctx, size, dpr, rect }
 * size 为 CSS 像素下的正方形边长
 * rect 为 canvas 相对于页面视口的 { left, top }，用于触摸坐标换算
 * （不同机型上 tap 事件的 detail.x/y 在 type="2d" canvas 上不完全可靠，
 *  所以统一改用 touchend + boundingClientRect 的方式手动换算，见页面 onBoardTap）
 */
function initCanvas(canvasId) {
  return new Promise((resolve, reject) => {
    const query = wx.createSelectorQuery();
    query
      .select('#' + canvasId)
      .fields({ node: true, size: true, rect: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          reject(new Error('未找到 canvas 节点: ' + canvasId));
          return;
        }
        const canvas = res[0].node;
        const size = Math.round(res[0].width);
        const dpr = getPixelRatio();
        canvas.width = size * dpr;
        canvas.height = size * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        resolve({
          canvas,
          ctx,
          size,
          dpr,
          rect: { left: res[0].left, top: res[0].top },
        });
      });
  });
}

function getLayout(size) {
  const margin = size * MARGIN_RATIO;
  const cellSize = (size - margin * 2) / (BOARD_SIZE - 1);
  return { margin, cellSize };
}

/** 交叉点坐标 (x=行, y=列) -> canvas CSS 像素坐标 */
function gridToPixel(size, x, y) {
  const { margin, cellSize } = getLayout(size);
  return {
    px: margin + y * cellSize,
    py: margin + x * cellSize,
  };
}

/** canvas 触摸像素坐标 -> 最近的交叉点 {x,y}，超出容差范围返回 null */
function pixelToGrid(size, px, py) {
  const { margin, cellSize } = getLayout(size);
  const rawY = (px - margin) / cellSize;
  const rawX = (py - margin) / cellSize;
  const x = Math.round(rawX);
  const y = Math.round(rawY);
  if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) return null;
  const dx = rawX - x;
  const dy = rawY - y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > 0.42) return null; // 点击容差：超过接近半格则视为无效点击
  return { x, y };
}

/**
 * 绘制棋盘整体
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} size CSS 像素边长
 * @param {number[][]} board 15x15 棋盘数组，0空 1黑 2白
 * @param {object} opts
 *   forbiddenPoints: [[x,y],...] 禁手点
 *   lastMove: {x,y} | null 最后一步
 *   winLine: [[x,y],...] | null 获胜连线（会画金色圆环高亮）
 *   showNumbers: boolean 是否显示手数序号（复盘用）
 *   moves: [{x,y,moveIndex}] 手数序号对照表（showNumbers=true 时需要）
 *   hintPoint: {x,y} | null 推荐落子点（画蓝色空心圆提示，不代表已落子）
 *   pendingPoint: {x,y,color:'black'|'white'} | null 预落子预览框（半透明
 *     棋子，第一次点击只显示这个，第二次点同一个位置才真正落子，防误触）
 */
function drawBoard(ctx, size, board, opts) {
  opts = opts || {};
  const { margin, cellSize } = getLayout(size);

  ctx.clearRect(0, 0, size, size);

  // 背景
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.08)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = COLOR_BG;
  roundRect(ctx, 2, 2, size - 4, size - 4, 8);
  ctx.fill();
  ctx.restore();

  // 边框
  ctx.strokeStyle = '#E0E0E0';
  ctx.lineWidth = 1;
  roundRect(ctx, 2, 2, size - 4, size - 4, 8);
  ctx.stroke();

  // 网格线
  ctx.strokeStyle = COLOR_GRID;
  ctx.lineWidth = 1;
  for (let i = 0; i < BOARD_SIZE; i++) {
    const pos = margin + i * cellSize;
    // 横线
    ctx.beginPath();
    ctx.moveTo(margin, pos);
    ctx.lineTo(size - margin, pos);
    ctx.stroke();
    // 竖线
    ctx.beginPath();
    ctx.moveTo(pos, margin);
    ctx.lineTo(pos, size - margin);
    ctx.stroke();
  }

  // 星位
  ctx.fillStyle = COLOR_STAR;
  STAR_POINTS.forEach(([x, y]) => {
    const { px, py } = gridToPixel(size, x, y);
    ctx.beginPath();
    ctx.arc(px, py, Math.max(2.5, cellSize * 0.07), 0, Math.PI * 2);
    ctx.fill();
  });

  // 获胜连线高亮（画在棋子下方）
  if (opts.winLine && opts.winLine.length >= 2) {
    const first = gridToPixel(size, opts.winLine[0][0], opts.winLine[0][1]);
    const last = gridToPixel(size, opts.winLine[opts.winLine.length - 1][0], opts.winLine[opts.winLine.length - 1][1]);
    ctx.save();
    ctx.strokeStyle = COLOR_WIN_RING;
    ctx.lineWidth = Math.max(3, cellSize * 0.12);
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(first.px, first.py);
    ctx.lineTo(last.px, last.py);
    ctx.stroke();
    ctx.restore();
  }

  // 棋子
  const stoneRadius = cellSize * 0.44;
  const moveIndexMap = {};
  if (opts.showNumbers && opts.moves) {
    opts.moves.forEach((m) => {
      moveIndexMap[m.x + '_' + m.y] = m.moveIndex;
    });
  }

  for (let x = 0; x < BOARD_SIZE; x++) {
    for (let y = 0; y < BOARD_SIZE; y++) {
      const v = board[x][y];
      if (v === 0) continue;
      const { px, py } = gridToPixel(size, x, y);
      drawStone(ctx, px, py, stoneRadius, v === 1 ? 'black' : 'white');

      if (opts.showNumbers) {
        const idx = moveIndexMap[x + '_' + y];
        if (idx) {
          ctx.save();
          ctx.fillStyle = v === 1 ? '#F5F5F5' : '#333333';
          ctx.font = `${Math.round(stoneRadius * 0.9)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(idx), px, py + 1);
          ctx.restore();
        }
      }
    }
  }

  // 获胜连线棋子外圈高亮
  if (opts.winLine && opts.winLine.length >= 2) {
    ctx.save();
    ctx.strokeStyle = COLOR_WIN_RING;
    ctx.lineWidth = 2;
    opts.winLine.forEach(([x, y]) => {
      const { px, py } = gridToPixel(size, x, y);
      ctx.beginPath();
      ctx.arc(px, py, stoneRadius + 3, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.restore();
  }

  // 禁手 ❌ 标记
  if (opts.forbiddenPoints && opts.forbiddenPoints.length) {
    ctx.save();
    ctx.strokeStyle = COLOR_FORBIDDEN;
    ctx.lineWidth = Math.max(2, cellSize * 0.09);
    ctx.lineCap = 'round';
    const half = cellSize * 0.24;
    opts.forbiddenPoints.forEach(([x, y]) => {
      const { px, py } = gridToPixel(size, x, y);
      ctx.beginPath();
      ctx.moveTo(px - half, py - half);
      ctx.lineTo(px + half, py + half);
      ctx.moveTo(px + half, py - half);
      ctx.lineTo(px - half, py + half);
      ctx.stroke();
    });
    ctx.restore();
  }

  // 最后一步：中心红点（呼吸光圈由页面 CSS 叠加层实现）
  if (opts.lastMove && board[opts.lastMove.x][opts.lastMove.y] !== 0) {
    const { px, py } = gridToPixel(size, opts.lastMove.x, opts.lastMove.y);
    ctx.save();
    ctx.fillStyle = COLOR_LAST_DOT;
    ctx.beginPath();
    ctx.arc(px, py, Math.max(2, stoneRadius * 0.22), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 推荐落子点：蓝色空心圆 + 中心小点，仅提示、不代表已落子
  if (opts.hintPoint && board[opts.hintPoint.x][opts.hintPoint.y] === 0) {
    const { px, py } = gridToPixel(size, opts.hintPoint.x, opts.hintPoint.y);
    ctx.save();
    ctx.strokeStyle = COLOR_HINT;
    ctx.lineWidth = Math.max(2, cellSize * 0.09);
    ctx.setLineDash ? ctx.setLineDash([cellSize * 0.12, cellSize * 0.08]) : null;
    ctx.beginPath();
    ctx.arc(px, py, stoneRadius * 0.7, 0, Math.PI * 2);
    ctx.stroke();
    if (ctx.setLineDash) ctx.setLineDash([]);
    ctx.fillStyle = COLOR_HINT;
    ctx.beginPath();
    ctx.arc(px, py, Math.max(2, stoneRadius * 0.16), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 预落子预览框：半透明的己方棋子 + 虚线外圈，第一次点击只显示这个，
  // 再次点击同一位置才真正落子，用来防止手滑误触
  if (opts.pendingPoint && board[opts.pendingPoint.x][opts.pendingPoint.y] === 0) {
    const { px, py } = gridToPixel(size, opts.pendingPoint.x, opts.pendingPoint.y);
    ctx.save();
    ctx.globalAlpha = 0.4;
    drawStone(ctx, px, py, stoneRadius, opts.pendingPoint.color === 'black' ? 'black' : 'white');
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = opts.pendingPoint.color === 'black' ? '#1A1A1A' : '#999999';
    ctx.lineWidth = Math.max(1.5, cellSize * 0.06);
    if (ctx.setLineDash) ctx.setLineDash([cellSize * 0.1, cellSize * 0.08]);
    ctx.beginPath();
    ctx.arc(px, py, stoneRadius + 3, 0, Math.PI * 2);
    ctx.stroke();
    if (ctx.setLineDash) ctx.setLineDash([]);
    ctx.restore();
  }
}

function drawStone(ctx, px, py, radius, color) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = radius * 0.35;
  ctx.shadowOffsetY = radius * 0.15;

  let gradient;
  if (color === 'black') {
    gradient = ctx.createRadialGradient(
      px - radius * 0.3, py - radius * 0.3, radius * 0.1,
      px, py, radius
    );
    gradient.addColorStop(0, '#5A5A5A');
    gradient.addColorStop(0.5, '#1A1A1A');
    gradient.addColorStop(1, '#000000');
  } else {
    gradient = ctx.createRadialGradient(
      px - radius * 0.3, py - radius * 0.3, radius * 0.1,
      px, py, radius
    );
    gradient.addColorStop(0, '#FFFFFF');
    gradient.addColorStop(0.7, '#F0F0F0');
    gradient.addColorStop(1, '#D8D8D8');
  }

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(px, py, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  if (color === 'white') {
    ctx.save();
    ctx.strokeStyle = '#BFBFBF';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

module.exports = {
  BOARD_SIZE,
  initCanvas,
  drawBoard,
  pixelToGrid,
  gridToPixel,
  getLayout,
};

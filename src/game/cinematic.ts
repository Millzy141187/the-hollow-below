import type { MonsterKind } from '../types';
import { mulberry32 } from './rng';

export interface CaughtScene {
  t: number;
  duration: number;
  kind: MonsterKind;
  seed: number;
  playerName: string;
}

type Rand = () => number;
type Rgb = readonly [number, number, number];

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function spacedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number,
  size: number,
  alpha: number
): void {
  if (alpha <= 0.001) return;
  ctx.save();
  ctx.font = `${size}px Georgia, 'Times New Roman', serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const chars = [...text];
  const widths = chars.map((char) => ctx.measureText(char).width);
  const total = widths.reduce((sum, width) => sum + width, 0) + spacing * Math.max(0, chars.length - 1);
  let cursor = x - total / 2;
  const draw = (offset: number, color: string): void => {
    ctx.fillStyle = color;
    let cx = cursor + offset;
    for (let i = 0; i < chars.length; i++) {
      ctx.fillText(chars[i]!, cx, y);
      cx += widths[i]! + spacing;
    }
  };
  ctx.shadowColor = 'rgba(120, 16, 12, 0.8)';
  ctx.shadowBlur = 24;
  draw(-2, `rgba(120, 22, 18, ${alpha * 0.7})`);
  draw(2, `rgba(34, 82, 88, ${alpha * 0.45})`);
  ctx.shadowBlur = 10;
  draw(0, `rgba(232, 220, 201, ${alpha})`);
  ctx.restore();
}

function mottle(
  ctx: CanvasRenderingContext2D,
  rand: Rand,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  count: number,
  color: Rgb,
  maxAlpha = 0.08
): void {
  for (let i = 0; i < count; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = Math.sqrt(rand());
    const x = cx + Math.cos(angle) * rx * dist;
    const y = cy + Math.sin(angle) * ry * dist;
    const rw = 1 + rand() * rx * 0.06;
    const rh = 0.5 + rand() * ry * 0.04;
    const alpha = 0.012 + rand() * maxAlpha;
    ctx.fillStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(x, y, rw, rh, rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
}

function veins(
  ctx: CanvasRenderingContext2D,
  rand: Rand,
  cx: number,
  cy: number,
  spreadX: number,
  spreadY: number,
  count: number,
  color: Rgb,
  alpha: number
): void {
  ctx.save();
  ctx.strokeStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    let x = cx + (rand() - 0.5) * spreadX;
    let y = cy + (rand() - 0.5) * spreadY;
    ctx.lineWidth = 0.45 + rand() * 0.9;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let j = 0; j < 3; j++) {
      x += (rand() - 0.5) * spreadX * 0.22;
      y += (rand() - 0.35) * spreadY * 0.16;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawTooth(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  length: number,
  tilt: number,
  color: string
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-width / 2, 0);
  ctx.bezierCurveTo(-width * 0.4, length * 0.52, -width * 0.16, length * 0.9, 0, length);
  ctx.bezierCurveTo(width * 0.16, length * 0.9, width * 0.4, length * 0.52, width / 2, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(63, 35, 24, 0.24)';
  ctx.fillRect(-width / 2, 0, width, 2.2);
  ctx.strokeStyle = 'rgba(255, 246, 226, 0.12)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(-width * 0.18, 1);
  ctx.quadraticCurveTo(-width * 0.08, length * 0.5, -width * 0.02, length * 0.8);
  ctx.stroke();
  ctx.restore();
}

function drawFinger(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  length: number,
  width: number,
  angle: number,
  skin: string,
  nail: string
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const shade = ctx.createLinearGradient(-width, 0, width, 0);
  shade.addColorStop(0, 'rgba(0, 0, 0, 0.48)');
  shade.addColorStop(0.4, 'rgba(255, 255, 255, 0.08)');
  shade.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.moveTo(-width / 2, 0);
  ctx.bezierCurveTo(-width * 0.68, length * 0.36, -width * 0.5, length * 0.82, -width * 0.22, length);
  ctx.quadraticCurveTo(0, length + width * 0.2, width * 0.22, length);
  ctx.bezierCurveTo(width * 0.5, length * 0.82, width * 0.68, length * 0.36, width / 2, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade;
  ctx.fill();
  ctx.strokeStyle = 'rgba(8, 5, 4, 0.5)';
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(-width * 0.42, length * 0.45);
  ctx.quadraticCurveTo(0, length * 0.54, width * 0.42, length * 0.45);
  ctx.stroke();
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = nail;
  ctx.beginPath();
  ctx.ellipse(0, length - width * 0.16, width * 0.13, width * 0.17, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#211510';
  ctx.beginPath();
  ctx.moveTo(-width * 0.18, length - width * 0.12);
  ctx.quadraticCurveTo(-width * 0.05, length + width * 0.55, 0, length + width * 0.85);
  ctx.quadraticCurveTo(width * 0.08, length + width * 0.45, width * 0.2, length - width * 0.15);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawHand(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  angle: number,
  skin: string,
  nail: string,
  rand: Rand
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(scale, scale);

  const arm = ctx.createLinearGradient(-42, 90, 42, -20);
  arm.addColorStop(0, '#0c0908');
  arm.addColorStop(0.6, '#1b120e');
  arm.addColorStop(1, '#2d1e17');
  ctx.fillStyle = arm;
  ctx.beginPath();
  ctx.moveTo(-48, 104);
  ctx.quadraticCurveTo(-36, 30, -27, -4);
  ctx.quadraticCurveTo(0, -18, 27, -4);
  ctx.quadraticCurveTo(36, 30, 48, 104);
  ctx.closePath();
  ctx.fill();

  const palm = ctx.createRadialGradient(-8, -10, 4, 0, 0, 42);
  palm.addColorStop(0, 'rgba(100, 74, 56, 0.48)');
  palm.addColorStop(0.5, 'rgba(47, 33, 26, 0.8)');
  palm.addColorStop(1, 'rgba(8, 6, 5, 0.96)');
  ctx.fillStyle = palm;
  ctx.beginPath();
  ctx.ellipse(0, -4, 24, 32, -0.04, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(7, 5, 4, 0.46)';
  ctx.beginPath();
  ctx.ellipse(4, 2, 17, 23, 0.08, 0, Math.PI * 2);
  ctx.fill();

  for (let i = 0; i < 4; i++) {
    const offset = (i - 1.5) * 10.5;
    const length = 52 - Math.abs(i - 1.5) * 6 + rand() * 3;
    drawFinger(
      ctx,
      offset,
      -28,
      length,
      8.8,
      -0.2 + i * 0.14,
      i % 2 === 0 ? '#2a1c16' : '#231813',
      '#584737'
    );
  }
  drawFinger(ctx, -29, 0, 40, 10.5, -0.95, '#231813', '#534231');
  drawFinger(ctx, 29, -4, 37, 9.5, 0.92, '#231813', '#534231');

  ctx.strokeStyle = 'rgba(230, 196, 158, 0.13)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-24, 66);
  ctx.quadraticCurveTo(-31, 20, -23, -16);
  ctx.stroke();
  ctx.restore();
}

function sunkenEye(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  iris: string,
  blind: boolean,
  rand: Rand
): void {
  const socket = ctx.createRadialGradient(x, y, 1, x, y, rx * 1.8);
  socket.addColorStop(0, '#030202');
  socket.addColorStop(0.62, '#080504');
  socket.addColorStop(1, 'rgba(24, 12, 9, 0)');
  ctx.fillStyle = socket;
  ctx.beginPath();
  ctx.ellipse(x, y, rx * 1.7, ry * 1.65, 0.02, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = blind ? '#746955' : '#544333';
  ctx.beginPath();
  ctx.ellipse(x, y + ry * 0.12, rx * 0.46, ry * 0.44, 0.02, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = blind ? 'rgba(181, 166, 137, 0.3)' : 'rgba(196, 126, 83, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(x, y + ry * 0.12, rx * 0.48, ry * 0.46, 0.02, 0, Math.PI * 2);
  ctx.stroke();

  if (blind) {
    ctx.fillStyle = 'rgba(220, 211, 191, 0.17)';
    for (let i = 0; i < 6; i++) {
      ctx.beginPath();
      ctx.ellipse(
        x + (rand() - 0.5) * rx * 0.6,
        y + (rand() - 0.5) * ry * 0.5,
        1 + rand() * 1.8,
        0.8 + rand() * 1.2,
        rand() * Math.PI,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(20, 15, 12, 0.32)';
    ctx.beginPath();
    ctx.ellipse(x, y + ry * 0.12, rx * 0.1, ry * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillStyle = iris;
    ctx.beginPath();
    ctx.ellipse(x - rx * 0.04, y + ry * 0.08, rx * 0.2, ry * 0.24, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#020202';
    ctx.beginPath();
    ctx.ellipse(x - rx * 0.03, y + ry * 0.08, rx * 0.075, ry * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 242, 216, 0.38)';
    ctx.beginPath();
    ctx.ellipse(x - rx * 0.14, y - ry * 0.02, rx * 0.055, ry * 0.055, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(8, 4, 3, 0.34)';
    ctx.beginPath();
    ctx.ellipse(x, y - ry * 0.16, rx * 0.45, ry * 0.24, 0, Math.PI, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = 'rgba(31, 20, 15, 0.9)';
  ctx.lineWidth = Math.max(1.1, rx * 0.12);
  ctx.beginPath();
  ctx.ellipse(x, y, rx * 0.72, ry * 0.7, 0.02, Math.PI * 0.98, Math.PI * 2.03);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(196, 159, 127, 0.18)';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.ellipse(x, y - ry * 0.12, rx * 0.63, ry * 0.52, 0.02, Math.PI * 1.02, Math.PI * 1.9);
  ctx.stroke();
}

function drawCrawlerFace(ctx: CanvasRenderingContext2D, p: number, rand: Rand): void {
  // Shoulders and haunches behind the skull.
  const behind = ctx.createRadialGradient(0, 34, 8, 0, 40, 190);
  behind.addColorStop(0, '#241a15');
  behind.addColorStop(0.65, '#0d0907');
  behind.addColorStop(1, 'rgba(4, 3, 3, 0)');
  ctx.fillStyle = behind;
  ctx.beginPath();
  ctx.ellipse(0, 38, 172, 124, 0.02, 0, Math.PI * 2);
  ctx.fill();

  // Main skull: deliberately uneven.
  ctx.fillStyle = '#090605';
  ctx.beginPath();
  ctx.moveTo(-116, 20);
  ctx.bezierCurveTo(-124, -42, -82, -84, -24, -92);
  ctx.bezierCurveTo(4, -96, 18, -101, 34, -94);
  ctx.bezierCurveTo(85, -82, 119, -40, 118, 22);
  ctx.bezierCurveTo(112, 70, 78, 99, 34, 107);
  ctx.lineTo(10, 96);
  ctx.lineTo(-18, 108);
  ctx.bezierCurveTo(-72, 104, -108, 68, -116, 20);
  ctx.closePath();
  ctx.fill();

  const skin = ctx.createRadialGradient(-34, -30, 6, -4, 8, 126);
  skin.addColorStop(0, '#8f7159');
  skin.addColorStop(0.24, '#69503e');
  skin.addColorStop(0.56, '#3e2b22');
  skin.addColorStop(0.82, '#1b120f');
  skin.addColorStop(1, '#080605');
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.moveTo(-98, -14);
  ctx.bezierCurveTo(-106, -48, -72, -72, -30, -74);
  ctx.bezierCurveTo(6, -76, 48, -64, 80, -42);
  ctx.bezierCurveTo(104, -20, 106, 16, 90, 42);
  ctx.bezierCurveTo(72, 68, 30, 80, -12, 74);
  ctx.bezierCurveTo(-56, 70, -96, 42, -98, -14);
  ctx.closePath();
  ctx.fill();

  // Cheek plates and brow ridge.
  ctx.fillStyle = 'rgba(22, 13, 10, 0.58)';
  ctx.beginPath();
  ctx.moveTo(-100, 8);
  ctx.quadraticCurveTo(-74, -34, -45, -31);
  ctx.quadraticCurveTo(-58, 22, -80, 56);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(102, 4);
  ctx.quadraticCurveTo(78, -36, 48, -34);
  ctx.quadraticCurveTo(62, 20, 84, 58);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = 'rgba(151, 116, 88, 0.24)';
  ctx.beginPath();
  ctx.moveTo(-91, -36);
  ctx.quadraticCurveTo(-44, -74, 16, -71);
  ctx.quadraticCurveTo(66, -62, 92, -29);
  ctx.quadraticCurveTo(44, -49, 0, -48);
  ctx.quadraticCurveTo(-46, -48, -91, -36);
  ctx.fill();
  ctx.strokeStyle = 'rgba(15, 9, 7, 0.7)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-101, -26);
  ctx.quadraticCurveTo(-52, -58, 8, -57);
  ctx.quadraticCurveTo(55, -53, 101, -23);
  ctx.stroke();

  // Four uneven, deep-set eyes.
  sunkenEye(ctx, -43, -28, 11, 14, '#8d3e2b', true, rand);
  sunkenEye(ctx, -16, -37, 7, 9, '#9c5434', false, rand);
  sunkenEye(ctx, 17, -37, 8, 10, '#9c5434', false, rand);
  sunkenEye(ctx, 43, -27, 11.5, 14.5, '#8f3f2b', false, rand);

  // Nostril slits and a ridge of exposed bone.
  ctx.fillStyle = '#120a08';
  ctx.beginPath();
  ctx.ellipse(-11, -2, 5, 2.8, -0.2, 0, Math.PI * 2);
  ctx.ellipse(11, -2, 5, 2.8, 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(206, 183, 151, 0.32)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(0, -20);
  ctx.lineTo(0, -5);
  ctx.moveTo(-6, -6);
  ctx.quadraticCurveTo(0, -9, 6, -6);
  ctx.stroke();

  // Torn lips, gums and throat.
  const open = 10 + smoothstep(0.12, 0.7, p) * 34;
  const mouthY = 34 + open * 0.26;
  ctx.fillStyle = '#250c0a';
  ctx.beginPath();
  ctx.moveTo(-77, 18);
  ctx.quadraticCurveTo(-48, 5, -17, 8);
  ctx.quadraticCurveTo(0, 11, 17, 8);
  ctx.quadraticCurveTo(50, 5, 79, 20);
  ctx.quadraticCurveTo(66, 45 + open * 0.38, 31, 47 + open * 0.36);
  ctx.quadraticCurveTo(0, 50 + open * 0.42, -32, 47 + open * 0.34);
  ctx.quadraticCurveTo(-67, 43 + open * 0.34, -77, 18);
  ctx.closePath();
  ctx.fill();

  const throat = ctx.createRadialGradient(0, mouthY, 2, 0, mouthY, 70);
  throat.addColorStop(0, '#020101');
  throat.addColorStop(0.7, '#0a0303');
  throat.addColorStop(1, '#260a08');
  ctx.fillStyle = throat;
  ctx.beginPath();
  ctx.ellipse(0, mouthY, 65, open, 0.01, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#4f211b';
  ctx.beginPath();
  ctx.ellipse(0, mouthY - open * 0.62, 58, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#55231d';
  ctx.beginPath();
  ctx.ellipse(0, mouthY + open * 0.66, 52, 7, 0, 0, Math.PI * 2);
  ctx.fill();

  const tongue = ctx.createLinearGradient(0, mouthY + open * 0.1, 0, mouthY + open * 0.88);
  tongue.addColorStop(0, '#5d2827');
  tongue.addColorStop(0.65, '#351416');
  tongue.addColorStop(1, '#1b090b');
  ctx.fillStyle = tongue;
  ctx.beginPath();
  ctx.moveTo(-25, mouthY + open * 0.2);
  ctx.quadraticCurveTo(-9, mouthY + open * 0.75, 3, mouthY + open * 0.84);
  ctx.quadraticCurveTo(18, mouthY + open * 0.8, 28, mouthY + open * 0.28);
  ctx.quadraticCurveTo(8, mouthY + open * 0.48, -2, mouthY + open * 0.38);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(220, 144, 133, 0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-11, mouthY + open * 0.38);
  ctx.quadraticCurveTo(0, mouthY + open * 0.58, 8, mouthY + open * 0.44);
  ctx.stroke();

  // Irregular, stained teeth with gaps and broken stumps.
  const teeth = 9;
  for (let i = 0; i < teeth; i++) {
    if (i === 3) continue;
    const x = (i - (teeth - 1) / 2) * 12.4;
    const y = mouthY - open * 0.87 + Math.abs(x) * 0.045;
    const length = 7 + ((i * 7) % 5) * 1.8 + rand() * 3;
    const broken = i === 4 || i === 7;
    drawTooth(
      ctx,
      x,
      y,
      broken ? 7 : 8.5 + rand() * 2,
      broken ? 3.5 : length,
      (rand() - 0.5) * 0.2,
      broken ? '#6c5d4a' : i % 3 === 0 ? '#a18d73' : '#b7a487'
    );
  }
  for (let i = 0; i < 7; i++) {
    if (i === 2) continue;
    const x = (i - 3) * 14.2;
    const y = mouthY + open * 0.85 - Math.abs(x) * 0.04;
    const length = -(6 + ((i * 5) % 4) * 1.7 + rand() * 2);
    drawTooth(ctx, x, y, 8 + rand() * 2, length, (rand() - 0.5) * 0.2, '#9b876d');
  }

  // Drool and blood.
  ctx.strokeStyle = 'rgba(207, 186, 158, 0.28)';
  for (let i = 0; i < 7; i++) {
    const x = (i - 3) * 14;
    const startY = mouthY + open * 0.72;
    ctx.lineWidth = 0.7 + rand() * 0.9;
    ctx.beginPath();
    ctx.moveTo(x, startY);
    ctx.quadraticCurveTo(x + 3, startY + 15 + rand() * 12, x + (rand() - 0.5) * 8, startY + 28 + rand() * 24);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(119, 25, 18, 0.55)';
  for (let i = 0; i < 4; i++) {
    const x = (i - 1.5) * 21;
    ctx.lineWidth = 1.2 + rand();
    ctx.beginPath();
    ctx.moveTo(x, mouthY + open * 0.7);
    ctx.quadraticCurveTo(x + 2, mouthY + open + 16, x - 2, mouthY + open + 33 + rand() * 14);
    ctx.stroke();
  }

  // Scars, pores and veins.
  mottle(ctx, rand, -4, 2, 88, 55, 92, [197, 160, 124], 0.075);
  mottle(ctx, rand, 22, 16, 67, 40, 55, [32, 16, 12], 0.12);
  veins(ctx, rand, -44, 10, 65, 40, 12, [94, 48, 42], 0.24);
  veins(ctx, rand, 45, 8, 58, 34, 10, [91, 48, 42], 0.2);
  ctx.strokeStyle = 'rgba(34, 17, 13, 0.6)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-67, 27);
  ctx.quadraticCurveTo(-53, 34, -44, 51);
  ctx.moveTo(72, 24);
  ctx.quadraticCurveTo(58, 34, 47, 52);
  ctx.stroke();

  // Wet sheen on the brow and cheek.
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const sheen = ctx.createRadialGradient(-46, -43, 2, -40, -38, 48);
  sheen.addColorStop(0, 'rgba(221, 190, 153, 0.16)');
  sheen.addColorStop(1, 'rgba(221, 190, 153, 0)');
  ctx.fillStyle = sheen;
  ctx.beginPath();
  ctx.ellipse(-40, -38, 50, 25, -0.18, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

}

function drawStalkerFace(ctx: CanvasRenderingContext2D, p: number, rand: Rand): void {
  // Too-wide shoulders and a neck that should not bend that way.
  ctx.fillStyle = '#080605';
  ctx.beginPath();
  ctx.moveTo(-178, 248);
  ctx.quadraticCurveTo(-132, 102, -57, 47);
  ctx.quadraticCurveTo(-23, 25, 0, 26);
  ctx.quadraticCurveTo(26, 24, 58, 47);
  ctx.quadraticCurveTo(134, 102, 178, 248);
  ctx.closePath();
  ctx.fill();

  const neck = ctx.createLinearGradient(-26, 18, 30, 104);
  neck.addColorStop(0, '#382a22');
  neck.addColorStop(0.6, '#1a120e');
  neck.addColorStop(1, '#090706');
  ctx.fillStyle = neck;
  ctx.beginPath();
  ctx.moveTo(-25, 28);
  ctx.quadraticCurveTo(-31, 64, -43, 92);
  ctx.quadraticCurveTo(0, 108, 44, 90);
  ctx.quadraticCurveTo(31, 63, 25, 27);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(177, 143, 111, 0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-16, 36);
  ctx.quadraticCurveTo(-15, 65, -20, 87);
  ctx.moveTo(14, 35);
  ctx.quadraticCurveTo(17, 65, 22, 88);
  ctx.stroke();

  // Head is tilted and not quite symmetrical.
  ctx.save();
  ctx.translate(0, -22);
  ctx.rotate(-0.028);

  ctx.fillStyle = '#0b0807';
  ctx.beginPath();
  ctx.moveTo(-53, 55);
  ctx.bezierCurveTo(-66, 6, -53, -64, -23, -92);
  ctx.bezierCurveTo(-5, -109, 24, -104, 43, -82);
  ctx.bezierCurveTo(65, -55, 67, 2, 48, 48);
  ctx.bezierCurveTo(34, 78, 4, 92, -23, 76);
  ctx.closePath();
  ctx.fill();

  const skin = ctx.createRadialGradient(-17, -38, 4, 5, -8, 96);
  skin.addColorStop(0, '#d7c9b2');
  skin.addColorStop(0.25, '#b7a58c');
  skin.addColorStop(0.58, '#796752');
  skin.addColorStop(0.82, '#3c3026');
  skin.addColorStop(1, '#17110e');
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.ellipse(0, -18, 46, 66, -0.015, 0, Math.PI * 2);
  ctx.fill();

  // Forehead shadow and cheek hollows.
  ctx.fillStyle = 'rgba(34, 26, 20, 0.42)';
  ctx.beginPath();
  ctx.ellipse(0, -67, 38, 20, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(-28, 4, 16, 31, 0.28, 0, Math.PI * 2);
  ctx.ellipse(28, 4, 15, 30, -0.28, 0, Math.PI * 2);
  ctx.fill();

  // Brow, eye sockets, nose and mouth.
  ctx.strokeStyle = 'rgba(35, 25, 19, 0.75)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-42, -44);
  ctx.quadraticCurveTo(-22, -58, 0, -55);
  ctx.quadraticCurveTo(24, -58, 43, -43);
  ctx.stroke();

  sunkenEye(ctx, -20, -33, 10, 14, '#7a382a', true, rand);
  sunkenEye(ctx, 21, -32, 9.5, 13.5, '#8e412d', false, rand);

  ctx.strokeStyle = 'rgba(86, 61, 45, 0.58)';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(0, -37);
  ctx.quadraticCurveTo(5, -18, -2, -7);
  ctx.stroke();
  ctx.fillStyle = 'rgba(25, 14, 11, 0.8)';
  ctx.beginPath();
  ctx.ellipse(-8, -4, 4.2, 2.4, 0.28, 0, Math.PI * 2);
  ctx.ellipse(8, -4, 4.2, 2.4, -0.28, 0, Math.PI * 2);
  ctx.fill();

  const open = 3 + smoothstep(0.16, 0.72, p) * 19;
  ctx.fillStyle = '#210c0a';
  ctx.beginPath();
  ctx.moveTo(-28, 24);
  ctx.quadraticCurveTo(-11, 15, 2, 17);
  ctx.quadraticCurveTo(15, 14, 30, 25);
  ctx.quadraticCurveTo(24, 34 + open * 0.55, 6, 38 + open * 0.6);
  ctx.quadraticCurveTo(0, 39 + open * 0.7, -7, 38 + open * 0.6);
  ctx.quadraticCurveTo(-24, 34 + open * 0.52, -28, 24);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#050202';
  ctx.beginPath();
  ctx.ellipse(0, 28 + open * 0.26, 19, open * 0.65, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#4c1e1a';
  ctx.beginPath();
  ctx.ellipse(0, 21, 20, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  for (let i = -4; i <= 4; i++) {
    if (i === -2 || i === 3) continue;
    const x = i * 4.2;
    drawTooth(ctx, x, 27 - open * 0.3, 5.4, 6 + (i % 2 === 0 ? 2 : 0), i * 0.03, '#b3a084');
    drawTooth(ctx, x, 31 + open * 0.52, 4.9, -5 - Math.abs(i) * 0.4, -i * 0.03, '#9d896e');
  }
  ctx.strokeStyle = 'rgba(129, 28, 20, 0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-16, 25);
  ctx.quadraticCurveTo(-23, 44, -18, 53);
  ctx.moveTo(17, 28);
  ctx.quadraticCurveTo(24, 42, 21, 48);
  ctx.stroke();

  // Matted hair, wet with something dark.
  ctx.lineCap = 'round';
  for (let i = 0; i < 22; i++) {
    const left = i % 2 === 0;
    const startX = left ? -39 + rand() * 16 : 23 + rand() * 16;
    const startY = -91 + rand() * 18;
    const endX = left ? -82 + rand() * 34 : 48 + rand() * 34;
    const endY = -54 + rand() * 79;
    ctx.strokeStyle = `rgba(${16 + Math.floor(rand() * 17)}, ${12 + Math.floor(rand() * 12)}, ${9 + Math.floor(rand() * 9)}, ${0.28 + rand() * 0.55})`;
    ctx.lineWidth = 0.7 + rand() * 2.1;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.quadraticCurveTo(
      startX + (rand() - 0.5) * 28,
      startY + 24 + rand() * 20,
      endX,
      endY
    );
    ctx.stroke();
  }

  for (let i = 0; i < 5; i++) {
    const startX = -22 + rand() * 44;
    const endX = -15 + rand() * 31;
    ctx.strokeStyle = `rgba(13, 10, 8, ${0.16 + rand() * 0.2})`;
    ctx.lineWidth = 0.6 + rand() * 1.2;
    ctx.beginPath();
    ctx.moveTo(startX, -94 + rand() * 10);
    ctx.quadraticCurveTo(startX + (rand() - 0.5) * 18, -68, endX, -45 + rand() * 22);
    ctx.stroke();
  }

  // Skin texture, veins and a blood tear.
  mottle(ctx, rand, 0, -8, 42, 59, 80, [221, 203, 176], 0.07);
  mottle(ctx, rand, 19, 20, 32, 35, 45, [52, 35, 26], 0.11);
  veins(ctx, rand, -19, 11, 45, 38, 10, [78, 53, 43], 0.23);
  veins(ctx, rand, 23, 8, 38, 31, 8, [78, 53, 43], 0.2);
  ctx.fillStyle = 'rgba(112, 20, 16, 0.56)';
  ctx.beginPath();
  ctx.moveTo(23, -17);
  ctx.quadraticCurveTo(27, 5, 22, 19);
  ctx.quadraticCurveTo(20, 25, 23, 29);
  ctx.quadraticCurveTo(26, 17, 27, 2);
  ctx.quadraticCurveTo(30, -8, 23, -17);
  ctx.fill();

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const sheen = ctx.createRadialGradient(-25, -45, 3, -20, -36, 42);
  sheen.addColorStop(0, 'rgba(238, 222, 198, 0.13)');
  sheen.addColorStop(1, 'rgba(238, 222, 198, 0)');
  ctx.fillStyle = sheen;
  ctx.beginPath();
  ctx.ellipse(-20, -36, 38, 27, -0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.restore();
}

function drawWailerFace(ctx: CanvasRenderingContext2D, p: number, rand: Rand): void {
  // Layered shroud, none of it quite touching the ground.
  for (let layer = 0; layer < 3; layer++) {
    const spread = 104 - layer * 13;
    const alpha = 0.38 + layer * 0.15;
    const cloth = ctx.createLinearGradient(-spread, -30, spread, 210);
    cloth.addColorStop(0, `rgba(31, 34, 33, ${alpha})`);
    cloth.addColorStop(0.45, `rgba(19, 22, 22, ${alpha})`);
    cloth.addColorStop(1, 'rgba(5, 7, 7, 0.92)');
    ctx.fillStyle = cloth;
    ctx.beginPath();
    ctx.moveTo(-spread, 212);
    ctx.quadraticCurveTo(-spread - 18, 74, -48 + layer * 5, 10 + layer * 8);
    ctx.quadraticCurveTo(0, -22 + layer * 4, 48 - layer * 5, 10 + layer * 8);
    ctx.quadraticCurveTo(spread + 18, 74, spread, 212);
    const hem = 212 - layer * 15;
    ctx.lineTo(spread * 0.73, hem - 29);
    ctx.lineTo(spread * 0.52, hem + 7);
    ctx.lineTo(spread * 0.31, hem - 31);
    ctx.lineTo(spread * 0.08, hem + 3);
    ctx.lineTo(-spread * 0.16, hem - 27);
    ctx.lineTo(-spread * 0.39, hem + 8);
    ctx.lineTo(-spread * 0.62, hem - 24);
    ctx.lineTo(-spread * 0.82, hem + 1);
    ctx.closePath();
    ctx.fill();
  }

  // Folds in the fabric.
  ctx.save();
  for (let i = -7; i <= 7; i++) {
    ctx.strokeStyle = `rgba(${125 + Math.floor(rand() * 35)}, ${131 + Math.floor(rand() * 30)}, ${126 + Math.floor(rand() * 25)}, ${0.07 + rand() * 0.12})`;
    ctx.lineWidth = 0.8 + rand() * 1.8;
    ctx.beginPath();
    ctx.moveTo(i * 10, -1 + rand() * 15);
    ctx.quadraticCurveTo(i * 13 + Math.sin(rand() * 5) * 8, 72, i * 18, 203);
    ctx.stroke();
  }
  ctx.restore();

  // Long pale hair floating around the mask.
  ctx.lineCap = 'round';
  for (let i = 0; i < 24; i++) {
    const startX = -29 + rand() * 58;
    const startY = -77 + rand() * 16;
    const endX = -81 + rand() * 162;
    const endY = -3 + rand() * 150;
    ctx.strokeStyle = `rgba(${154 + Math.floor(rand() * 40)}, ${148 + Math.floor(rand() * 36)}, ${134 + Math.floor(rand() * 30)}, ${0.1 + rand() * 0.22})`;
    ctx.lineWidth = 0.5 + rand() * 1.4;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.quadraticCurveTo(
      startX + Math.sin(rand() * 9) * 30,
      startY + 56 + rand() * 40,
      endX,
      endY
    );
    ctx.stroke();
  }

  // Cracked funeral mask.
  const mask = ctx.createRadialGradient(-12, -41, 4, 0, -17, 55);
  mask.addColorStop(0, '#eee1cc');
  mask.addColorStop(0.36, '#cbbb9f');
  mask.addColorStop(0.7, '#8d7d65');
  mask.addColorStop(0.9, '#4d4235');
  mask.addColorStop(1, '#211b16');
  ctx.fillStyle = mask;
  ctx.beginPath();
  ctx.moveTo(-31, -77);
  ctx.quadraticCurveTo(-3, -92, 31, -76);
  ctx.quadraticCurveTo(47, -40, 36, 8);
  ctx.quadraticCurveTo(27, 34, 5, 39);
  ctx.quadraticCurveTo(-21, 44, -36, 16);
  ctx.quadraticCurveTo(-48, -34, -31, -77);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(63, 48, 37, 0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-19, -78);
  ctx.quadraticCurveTo(4, -83, 27, -73);
  ctx.stroke();
  ctx.fillStyle = 'rgba(36, 26, 21, 0.38)';
  ctx.beginPath();
  ctx.ellipse(-22, 12, 13, 25, 0.12, 0, Math.PI * 2);
  ctx.ellipse(23, 10, 11, 23, -0.12, 0, Math.PI * 2);
  ctx.fill();

  // Hollow sockets and the void behind the mask.
  const sockets = ctx.createRadialGradient(0, -29, 3, 0, -25, 52);
  sockets.addColorStop(0, '#030303');
  sockets.addColorStop(0.6, '#060505');
  sockets.addColorStop(1, 'rgba(27, 20, 16, 0)');
  ctx.fillStyle = sockets;
  ctx.beginPath();
  ctx.ellipse(-12, -27, 14, 19, 0.1, 0, Math.PI * 2);
  ctx.ellipse(12, -27, 14, 19, -0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(208, 196, 169, 0.22)';
  ctx.beginPath();
  ctx.ellipse(12, -25, 3.6, 6.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // A mouth sewn shut, opening as the mask wakes.
  const open = 6 + smoothstep(0.18, 0.74, p) * 14;
  ctx.fillStyle = '#080605';
  ctx.beginPath();
  ctx.ellipse(0, 15, 9, open, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(52, 33, 25, 0.75)';
  ctx.lineWidth = 1.3;
  for (let i = -2; i <= 2; i++) {
    const y = 15 + i * 4.5;
    ctx.beginPath();
    ctx.moveTo(-9, y);
    ctx.lineTo(-3, y - 2);
    ctx.moveTo(9, y);
    ctx.lineTo(3, y - 2);
    ctx.stroke();
  }

  // Cracks and age.
  ctx.strokeStyle = 'rgba(64, 47, 35, 0.52)';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(-28, -57);
  ctx.lineTo(-19, -43);
  ctx.lineTo(-22, -27);
  ctx.moveTo(29, -60);
  ctx.lineTo(23, -46);
  ctx.lineTo(27, -34);
  ctx.lineTo(19, -22);
  ctx.moveTo(-8, -78);
  ctx.lineTo(-2, -59);
  ctx.lineTo(-7, -46);
  ctx.moveTo(9, 32);
  ctx.lineTo(4, 21);
  ctx.lineTo(10, 11);
  ctx.stroke();
  mottle(ctx, rand, 0, -20, 34, 48, 56, [72, 55, 40], 0.1);
  mottle(ctx, rand, -7, -39, 23, 19, 24, [255, 246, 224], 0.08);

  // Ritual pigment and gold leaf.
  ctx.fillStyle = 'rgba(146, 44, 34, 0.32)';
  ctx.beginPath();
  ctx.ellipse(0, -56, 17, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(194, 159, 84, 0.4)';
  for (let i = 0; i < 7; i++) {
    ctx.fillRect(-20 + rand() * 40, -74 + rand() * 12, 1 + rand() * 3, 1 + rand() * 2);
  }

}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  p: number,
  rand: Rand
): void {
  const base = ctx.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0, '#080605');
  base.addColorStop(0.48, '#100b09');
  base.addColorStop(1, '#040303');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // Out-of-focus masonry gives the close-up a place.
  ctx.save();
  ctx.filter = 'blur(5px)';
  const rowH = h / 9;
  for (let row = 0; row < 9; row++) {
    const offset = row % 2 ? -w * 0.09 : 0;
    for (let col = -1; col < 7; col++) {
      const x = offset + col * (w / 6);
      const y = row * rowH;
      const shade = 10 + rand() * 9;
      ctx.fillStyle = `hsl(22 9% ${shade}%)`;
      ctx.fillRect(x + 2, y + 2, w / 6 - 4, rowH - 4);
      ctx.fillStyle = 'rgba(190, 156, 120, 0.045)';
      ctx.fillRect(x + 2, y + 2, w / 6 - 4, 2);
      if (rand() > 0.62) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.24)';
        ctx.fillRect(x + 10 + rand() * 20, y + rowH * 0.4, 2, rowH * 0.5);
      }
    }
  }
  ctx.restore();

  // A cold arch behind it.
  ctx.save();
  const arch = ctx.createLinearGradient(w / 2, h * 0.05, w / 2, h * 0.7);
  arch.addColorStop(0, 'rgba(32, 36, 35, 0.18)');
  arch.addColorStop(1, 'rgba(0, 0, 0, 0.36)');
  ctx.fillStyle = arch;
  ctx.beginPath();
  ctx.moveTo(w * 0.24, h * 0.68);
  ctx.lineTo(w * 0.24, h * 0.38);
  ctx.quadraticCurveTo(w * 0.5, h * 0.03, w * 0.76, h * 0.38);
  ctx.lineTo(w * 0.76, h * 0.68);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(156, 139, 113, 0.08)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(w * 0.24, h * 0.68);
  ctx.lineTo(w * 0.24, h * 0.38);
  ctx.quadraticCurveTo(w * 0.5, h * 0.03, w * 0.76, h * 0.38);
  ctx.lineTo(w * 0.76, h * 0.68);
  ctx.stroke();
  ctx.restore();

  // Blood pool and drifting dust.
  const pool = ctx.createRadialGradient(w / 2, h * 0.79, 4, w / 2, h * 0.79, w * 0.42);
  pool.addColorStop(0, 'rgba(57, 10, 8, 0.44)');
  pool.addColorStop(0.55, 'rgba(31, 6, 6, 0.18)');
  pool.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = pool;
  ctx.beginPath();
  ctx.ellipse(w / 2, h * 0.79, w * 0.42, h * 0.11, 0, 0, Math.PI * 2);
  ctx.fill();

  for (let i = 0; i < 54; i++) {
    const x = rand() * w;
    const y = (rand() * h + p * 30) % h;
    ctx.fillStyle = `rgba(211, 194, 166, ${0.025 + rand() * 0.08})`;
    ctx.beginPath();
    ctx.arc(x, y, 0.4 + rand() * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawCaughtCutscene(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  scene: CaughtScene,
  reducedFx: boolean
): void {
  const p = Math.max(0, Math.min(1, scene.t / scene.duration));
  const rand = mulberry32(scene.seed);
  const bgRand = mulberry32(scene.seed ^ 0xa53c9e17);
  const dark = smoothstep(0.04, 0.36, p);
  const finalFade = smoothstep(0.94, 1, p);

  ctx.save();
  if (!reducedFx) {
    const force = (1 - smoothstep(0.2, 0.8, p)) * 5 + (p < 0.28 ? 7 : 0);
    ctx.translate((rand() - 0.5) * force, (rand() - 0.5) * force);
  }

  // The room is still there for a heartbeat, then the dark closes in.
  ctx.save();
  ctx.globalAlpha = smoothstep(0.03, 0.3, p) * 0.82;
  drawBackground(ctx, w, h, p, bgRand);
  ctx.restore();

  const flash = (1 - smoothstep(0.02, 0.16, p)) * (reducedFx ? 0.14 : 0.46);
  ctx.fillStyle = `rgba(2, 1, 2, ${0.16 + dark * 0.64})`;
  ctx.fillRect(-20, -20, w + 40, h + 40);
  if (flash > 0.002) {
    ctx.fillStyle = `rgba(126, 11, 8, ${flash})`;
    ctx.fillRect(-20, -20, w + 40, h + 40);
  }
  if (!reducedFx && p > 0.15 && p < 0.2) {
    const blink = 1 - Math.abs(p - 0.175) / 0.025;
    if (blink > 0) {
      ctx.fillStyle = `rgba(226, 216, 196, ${blink * 0.12})`;
      ctx.fillRect(-20, -20, w + 40, h + 40);
    }
  }

  const glow = ctx.createRadialGradient(w / 2, h * 0.45, 8, w / 2, h * 0.45, Math.max(w, h) * 0.58);
  glow.addColorStop(0, 'rgba(91, 38, 28, 0.26)');
  glow.addColorStop(0.56, 'rgba(27, 12, 12, 0.12)');
  glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  const edge = ctx.createRadialGradient(
    w / 2,
    h * 0.45,
    Math.min(w, h) * 0.24,
    w / 2,
    h * 0.45,
    Math.max(w, h) * 0.72
  );
  edge.addColorStop(0, 'rgba(0, 0, 0, 0)');
  edge.addColorStop(0.72, 'rgba(0, 0, 0, 0.3)');
  edge.addColorStop(1, 'rgba(0, 0, 0, 0.72)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, w, h);

  // Blood on the lens, with a few running tails.
  for (let i = 0; i < 11; i++) {
    const x = rand() * w;
    const y = rand() * h * 0.7;
    const r = 8 + rand() * 48;
    ctx.fillStyle = `rgba(${48 + Math.floor(rand() * 40)}, ${8 + Math.floor(rand() * 12)}, 8, ${0.1 + rand() * 0.16})`;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.25 + rand() * 0.48), rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
    if (i % 3 === 0) {
      ctx.strokeStyle = `rgba(84, 12, 9, ${0.08 + rand() * 0.12})`;
      ctx.lineWidth = 1 + rand() * 2;
      ctx.beginPath();
      ctx.moveTo(x, y + r * 0.3);
      ctx.quadraticCurveTo(x + 3, y + r + 8, x - 2, y + r + 24 + rand() * 26);
      ctx.stroke();
    }
  }

  // The thing itself.
  ctx.save();
  const scale = (Math.min(w, h) / 620) * (0.78 + smoothstep(0.04, 0.7, p) * 1.0);
  ctx.translate(w / 2, h * 0.46);
  ctx.rotate((rand() - 0.5) * 0.045 + Math.sin(p * 7.2) * 0.008);
  ctx.scale(scale, scale);
  ctx.globalAlpha = smoothstep(0.06, 0.3, p) * (1 - smoothstep(0.92, 1, p) * 0.45);
  if (scene.kind === 'crawler') drawCrawlerFace(ctx, p, rand);
  else if (scene.kind === 'wailer') drawWailerFace(ctx, p, rand);
  else drawStalkerFace(ctx, p, rand);
  ctx.restore();

  // Blurred foreground hands close the frame.
  if (p > 0.3) {
    const reach = smoothstep(0.3, 0.8, p);
    ctx.save();
    ctx.globalAlpha = reach * 0.6;
    ctx.filter = 'blur(3px)';
    drawHand(ctx, w * 0.06, h * 0.76, (Math.min(w, h) / 620) * 1.15, 0.42, '#160f0c', '#6c5c48', rand);
    drawHand(ctx, w * 0.94, h * 0.78, (Math.min(w, h) / 620) * 1.15, -0.45, '#140e0b', '#685844', rand);
    ctx.restore();
  }

  // Letterbox.
  const bars = smoothstep(0.02, 0.24, p) * h * 0.105;
  ctx.fillStyle = '#020202';
  ctx.fillRect(0, 0, w, bars);
  ctx.fillRect(0, h - bars, w, bars);

  // Caption shade.
  const shade = ctx.createLinearGradient(0, h * 0.58, 0, h);
  shade.addColorStop(0, 'rgba(0, 0, 0, 0)');
  shade.addColorStop(0.6, 'rgba(0, 0, 0, 0.26)');
  shade.addColorStop(1, 'rgba(0, 0, 0, 0.62)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, h * 0.58, w, h * 0.42);

  // Captions, one at a time.
  ctx.save();
  ctx.globalAlpha = 1;
  const mainSize = Math.min(44, w * 0.06);
  const midSize = Math.min(26, w * 0.038);
  const smallSize = Math.min(15, w * 0.022);
  const a1 = smoothstep(0.12, 0.2, p) * (1 - smoothstep(0.32, 0.4, p));
  const a2 = smoothstep(0.42, 0.5, p) * (1 - smoothstep(0.63, 0.71, p));
  const a3 = smoothstep(0.74, 0.82, p) * (1 - smoothstep(0.96, 1, p));
  spacedText(ctx, 'IT FOUND YOU', w / 2, h * 0.7, 7, mainSize, a1);
  spacedText(ctx, 'THE DARK DOES NOT SHARE', w / 2, h * 0.78, 5, midSize, a2);
  spacedText(ctx, 'THE HOLLOW KEEPS WHAT IT TAKES', w / 2, h * 0.855, 3, smallSize + 1, a3);
  const name = scene.playerName.trim().toUpperCase();
  if (name && p > 0.87) {
    spacedText(
      ctx,
      `IT REMEMBERS ${name}`,
      w / 2,
      h * 0.915,
      2.5,
      smallSize,
      smoothstep(0.87, 0.93, p) * (1 - smoothstep(0.985, 1, p))
    );
  }
  ctx.restore();

  // Grain, scratches and scanlines.
  for (let i = 0; i < 120; i++) {
    const x = rand() * w;
    const y = rand() * h;
    ctx.fillStyle = `rgba(220, 210, 190, ${rand() * 0.05})`;
    ctx.fillRect(x, y, 1, rand() * 2 + 0.5);
  }
  ctx.strokeStyle = 'rgba(205, 190, 166, 0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const x = rand() * w;
    ctx.beginPath();
    ctx.moveTo(x, bars);
    ctx.lineTo(x + (rand() - 0.5) * 30, h - bars);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(0, 0, 0, 0.075)';
  for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);

  if (finalFade > 0) {
    ctx.fillStyle = `rgba(0, 0, 0, ${finalFade})`;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();
}

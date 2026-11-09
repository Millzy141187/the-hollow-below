import type { MonsterKind } from '../types';
import { mulberry32 } from './rng';

export interface CaughtScene {
  t: number;
  duration: number;
  kind: MonsterKind;
  seed: number;
  playerName: string;
}

export type JumpScareSource = 'monster' | 'apparition' | 'fuse';

export interface JumpScareScene {
  t: number;
  duration: number;
  kind: MonsterKind;
  seed: number;
  source: JumpScareSource;
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

function drawSuitedDemonFace(
  ctx: CanvasRenderingContext2D,
  p: number,
  rand: Rand,
  kind: MonsterKind
): void {
  const crawler = kind === 'crawler';
  const wailer = kind === 'wailer';
  const headScaleX = crawler ? 1.08 : wailer ? 0.88 : 1;
  const headScaleY = crawler ? 0.92 : wailer ? 1.08 : 1;
  const hornLength = crawler ? 0.72 : wailer ? 1.08 : 1;

  // The suit arrives before the face does.
  const suit = ctx.createLinearGradient(-210, 105, 150, 340);
  suit.addColorStop(0, '#302925');
  suit.addColorStop(0.32, '#1a1614');
  suit.addColorStop(0.72, '#0d0a0a');
  suit.addColorStop(1, '#050404');
  ctx.fillStyle = suit;
  const shoulders = new Path2D();
  shoulders.moveTo(-214, 344);
  shoulders.quadraticCurveTo(-202, 194, -124, 126);
  shoulders.quadraticCurveTo(-76, 84, 0, 84);
  shoulders.quadraticCurveTo(76, 84, 124, 126);
  shoulders.quadraticCurveTo(202, 194, 214, 344);
  shoulders.closePath();
  ctx.fill(shoulders);

  ctx.save();
  ctx.clip(shoulders);
  ctx.strokeStyle = 'rgba(190, 159, 133, 0.11)';
  ctx.lineWidth = 1.2;
  for (let x = -190; x <= 190; x += 13) {
    ctx.beginPath();
    ctx.moveTo(x, 90);
    ctx.lineTo(x + 14, 350);
    ctx.stroke();
  }
  ctx.restore();

  // Black shirt and a red tie pulled too tight.
  ctx.fillStyle = '#070606';
  ctx.beginPath();
  ctx.moveTo(-39, 82);
  ctx.lineTo(0, 143);
  ctx.lineTo(39, 82);
  ctx.lineTo(20, 76);
  ctx.lineTo(0, 108);
  ctx.lineTo(-20, 76);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#352d28';
  ctx.beginPath();
  ctx.moveTo(-118, 142);
  ctx.lineTo(-25, 104);
  ctx.lineTo(-8, 224);
  ctx.lineTo(-76, 196);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(118, 142);
  ctx.lineTo(25, 104);
  ctx.lineTo(8, 224);
  ctx.lineTo(76, 196);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(211, 190, 164, 0.14)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-117, 143);
  ctx.lineTo(-25, 106);
  ctx.moveTo(117, 143);
  ctx.lineTo(25, 106);
  ctx.stroke();

  ctx.fillStyle = '#a51f1d';
  ctx.beginPath();
  ctx.moveTo(0, 112);
  ctx.lineTo(20, 139);
  ctx.lineTo(11, 250);
  ctx.lineTo(0, 225);
  ctx.lineTo(-10, 250);
  ctx.lineTo(-20, 139);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#d23a2d';
  ctx.beginPath();
  ctx.moveTo(0, 112);
  ctx.lineTo(10, 127);
  ctx.lineTo(0, 143);
  ctx.lineTo(-10, 127);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 128, 95, 0.36)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-1, 145);
  ctx.lineTo(1, 238);
  ctx.stroke();

  // Pocket square, the only clean thing in the frame.
  ctx.fillStyle = '#8f1d1a';
  ctx.beginPath();
  ctx.moveTo(-153, 238);
  ctx.lineTo(-137, 228);
  ctx.lineTo(-128, 246);
  ctx.lineTo(-142, 255);
  ctx.closePath();
  ctx.fill();

  // The neck is far too long.
  ctx.fillStyle = '#4a100d';
  ctx.beginPath();
  ctx.moveTo(-35, 55);
  ctx.quadraticCurveTo(-40, 103, -55, 145);
  ctx.lineTo(55, 145);
  ctx.quadraticCurveTo(40, 103, 35, 55);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(23, 5, 4, 0.58)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(-26, 67);
  ctx.quadraticCurveTo(-33, 102, -43, 134);
  ctx.moveTo(26, 67);
  ctx.quadraticCurveTo(33, 102, 43, 134);
  ctx.stroke();

  ctx.save();
  ctx.scale(headScaleX, headScaleY);

  // Pointed ears, then the horns behind the skull.
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.scale(side, 1);
    ctx.fillStyle = '#641611';
    ctx.beginPath();
    ctx.moveTo(73, -27);
    ctx.quadraticCurveTo(111, -59, 127, -37);
    ctx.quadraticCurveTo(111, 1, 86, 20);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(31, 5, 4, 0.65)';
    ctx.beginPath();
    ctx.moveTo(82, -23);
    ctx.quadraticCurveTo(103, -40, 113, -30);
    ctx.quadraticCurveTo(102, -9, 88, 7);
    ctx.closePath();
    ctx.fill();

    const horn = ctx.createLinearGradient(42, -82, 110, -240);
    horn.addColorStop(0, '#31241d');
    horn.addColorStop(0.35, '#100c0a');
    horn.addColorStop(0.78, '#050404');
    horn.addColorStop(1, '#020202');
    ctx.fillStyle = horn;
    ctx.beginPath();
    ctx.moveTo(49, -84);
    ctx.bezierCurveTo(91, -133 * hornLength, 108, -190 * hornLength, 95, -238 * hornLength);
    ctx.bezierCurveTo(76, -198 * hornLength, 52, -158 * hornLength, 20, -112);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(226, 196, 158, 0.2)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(50, -91);
    ctx.bezierCurveTo(82, -135 * hornLength, 97, -184 * hornLength, 88, -224 * hornLength);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(5, 4, 3, 0.7)';
    ctx.lineWidth = 4;
    for (let i = 1; i <= 3; i++) {
      const y = -112 - i * 32 * hornLength;
      ctx.beginPath();
      ctx.moveTo(52 + i * 9, y);
      ctx.quadraticCurveTo(70 + i * 8, y + 9, 82 + i * 5, y + 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Narrow skull, high cheekbones, a jaw that opens too far.
  const head = ctx.createRadialGradient(-31, -60, 8, 0, 0, 158);
  head.addColorStop(0, '#c24632');
  head.addColorStop(0.25, '#92261e');
  head.addColorStop(0.56, '#5e130f');
  head.addColorStop(0.82, '#2b0807');
  head.addColorStop(1, '#100202');
  ctx.fillStyle = head;
  const skull = new Path2D();
  skull.moveTo(-77, -17);
  skull.bezierCurveTo(-84, -77, -45, -111, 0, -109);
  skull.bezierCurveTo(45, -111, 84, -77, 77, -17);
  skull.bezierCurveTo(76, 28, 55, 66, 26, 88);
  skull.quadraticCurveTo(0, 104, -26, 88);
  skull.bezierCurveTo(-55, 66, -76, 28, -77, -17);
  skull.closePath();
  ctx.fill(skull);

  // Temporal hollows and brow ridge.
  ctx.fillStyle = 'rgba(25, 4, 4, 0.4)';
  ctx.beginPath();
  ctx.ellipse(-59, -14, 15, 35, -0.2, 0, Math.PI * 2);
  ctx.ellipse(59, -14, 15, 35, 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(23, 4, 3, 0.68)';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(-74, -54);
  ctx.quadraticCurveTo(-33, -78, 0, -72);
  ctx.quadraticCurveTo(34, -78, 73, -51);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(226, 106, 78, 0.2)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-69, -61);
  ctx.quadraticCurveTo(-30, -84, 3, -77);
  ctx.quadraticCurveTo(39, -82, 68, -58);
  ctx.stroke();

  // Hollow sockets. No eyes, only an appetite.
  for (const side of [-1, 1]) {
    const x = side * 35;
    const y = -24;
    const socket = ctx.createRadialGradient(x, y, 2, x, y, 41);
    socket.addColorStop(0, '#000000');
    socket.addColorStop(0.62, '#030202');
    socket.addColorStop(1, 'rgba(29, 5, 5, 0.05)');
    ctx.fillStyle = socket;
    ctx.beginPath();
    ctx.ellipse(x, y, 26, 38, side * 0.14, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(49, 7, 6, 0.9)';
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.ellipse(x, y, 26.5, 38.5, side * 0.14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(197, 62, 44, 0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(x, y - 3, 23, 33, side * 0.14, Math.PI * 1.05, Math.PI * 1.75);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 70, 38, 0.13)';
    ctx.beginPath();
    ctx.arc(x + side * 3, y + 7, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Nose slits.
  ctx.fillStyle = '#210505';
  ctx.beginPath();
  ctx.ellipse(-10, 20, 4.5, 8, -0.18, 0, Math.PI * 2);
  ctx.ellipse(10, 20, 4.5, 8, 0.18, 0, Math.PI * 2);
  ctx.fill();

  const open =
    (crawler ? 35 : wailer ? 38 : 25) + smoothstep(0.08, 0.7, p) * (crawler ? 34 : 29);
  const mouthTop = 40;
  const mouthBottom = 78 + open;
  ctx.fillStyle = '#1b0504';
  const mouth = new Path2D();
  mouth.moveTo(-80, 34);
  mouth.quadraticCurveTo(-42, 13, 0, 21);
  mouth.quadraticCurveTo(42, 13, 80, 34);
  mouth.quadraticCurveTo(69, 58 + open, 31, 76 + open);
  mouth.quadraticCurveTo(0, 89 + open, -31, 76 + open);
  mouth.quadraticCurveTo(-69, 58 + open, -80, 34);
  mouth.closePath();
  ctx.fill(mouth);
  ctx.fillStyle = '#4d0f0c';
  ctx.beginPath();
  ctx.ellipse(0, mouthTop + open * 0.34, 70, 14 + open * 0.12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#3e0b0a';
  ctx.beginPath();
  ctx.ellipse(0, mouthBottom - 2, 57, 10, 0, 0, Math.PI * 2);
  ctx.fill();

  // A tongue that does not belong in a mouth.
  const tongue = ctx.createLinearGradient(0, mouthTop + open * 0.25, 0, mouthBottom);
  tongue.addColorStop(0, '#5b2220');
  tongue.addColorStop(0.6, '#361013');
  tongue.addColorStop(1, '#1a0709');
  ctx.fillStyle = tongue;
  ctx.beginPath();
  ctx.moveTo(-27, mouthTop + open * 0.3);
  ctx.quadraticCurveTo(-8, mouthTop + open * 0.66, 4, mouthBottom - 8);
  ctx.quadraticCurveTo(20, mouthTop + open * 0.63, 31, mouthTop + open * 0.27);
  ctx.quadraticCurveTo(6, mouthTop + open * 0.43, -3, mouthTop + open * 0.38);
  ctx.closePath();
  ctx.fill();

  // Needle teeth, packed edge to edge.
  const topTeeth = 12;
  for (let i = 0; i < topTeeth; i++) {
    if (i === 4 || i === 9) continue;
    const x = (i - (topTeeth - 1) / 2) * 11;
    const y = mouthTop + Math.abs(x) * 0.07;
    const length = 17 + ((i * 7) % 5) * 3 + rand() * 4;
    const broken = i === 2 || i === 10;
    drawTooth(
      ctx,
      x,
      y,
      7.6 + rand() * 2.2,
      broken ? 9 : length,
      (rand() - 0.5) * 0.12,
      broken ? '#665b4c' : i % 3 === 0 ? '#b3a48d' : '#d0c3aa'
    );
  }
  const bottomTeeth = 10;
  for (let i = 0; i < bottomTeeth; i++) {
    if (i === 3 || i === 7) continue;
    const x = (i - (bottomTeeth - 1) / 2) * 12.4;
    const y = mouthBottom - 2 - Math.abs(x) * 0.04;
    const length = 14 + ((i * 5) % 4) * 2.8 + rand() * 3;
    drawTooth(
      ctx,
      x,
      y,
      8.1 + rand() * 2,
      -length,
      (rand() - 0.5) * 0.12,
      i % 4 === 0 ? '#aa9a81' : '#c6b89e'
    );
  }

  // Gums, drool, and blood at the corners.
  ctx.strokeStyle = 'rgba(196, 169, 137, 0.24)';
  for (let i = 0; i < 8; i++) {
    const x = (i - 3.5) * 15;
    const startY = mouthTop + open * 0.48;
    ctx.lineWidth = 1.1 + rand() * 1.6;
    ctx.beginPath();
    ctx.moveTo(x, startY);
    ctx.quadraticCurveTo(
      x + (rand() - 0.5) * 10,
      startY + 22 + rand() * 20,
      x + (rand() - 0.5) * 9,
      startY + 45 + rand() * 36
    );
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(119, 22, 16, 0.64)';
  for (let i = 0; i < 5; i++) {
    const x = (i - 2) * 24;
    ctx.lineWidth = 2 + rand() * 2;
    ctx.beginPath();
    ctx.moveTo(x, mouthBottom - 6);
    ctx.quadraticCurveTo(x + 4, mouthBottom + 27, x - 3, mouthBottom + 48 + rand() * 26);
    ctx.stroke();
  }

  // Smile creases and a chin that has seen too much.
  ctx.strokeStyle = 'rgba(32, 5, 4, 0.72)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-74, 32);
  ctx.quadraticCurveTo(-91, 50, -82, 82);
  ctx.moveTo(74, 32);
  ctx.quadraticCurveTo(91, 50, 82, 82);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(224, 103, 77, 0.22)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-68, 39);
  ctx.quadraticCurveTo(-80, 55, -74, 74);
  ctx.moveTo(68, 39);
  ctx.quadraticCurveTo(80, 55, 74, 74);
  ctx.stroke();

  // Pores, veins and the wet shine of skin.
  mottle(ctx, rand, 0, 3, 67, 84, 120, [222, 116, 90], 0.06);
  mottle(ctx, rand, 21, 28, 45, 48, 60, [28, 5, 4], 0.13);
  veins(ctx, rand, -42, 22, 65, 58, 15, [75, 18, 15], 0.24);
  veins(ctx, rand, 43, 18, 56, 52, 13, [71, 17, 15], 0.21);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const sheen = ctx.createRadialGradient(-42, -69, 3, -36, -58, 64);
  sheen.addColorStop(0, 'rgba(255, 214, 184, 0.18)');
  sheen.addColorStop(1, 'rgba(255, 214, 184, 0)');
  ctx.fillStyle = sheen;
  ctx.beginPath();
  ctx.ellipse(-34, -58, 66, 35, -0.18, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.restore();
}

function drawCrawlerFace(ctx: CanvasRenderingContext2D, p: number, rand: Rand): void {
  drawSuitedDemonFace(ctx, p, rand, 'crawler');
}

function drawStalkerFace(ctx: CanvasRenderingContext2D, p: number, rand: Rand): void {
  drawSuitedDemonFace(ctx, p, rand, 'stalker');
}

function drawWailerFace(ctx: CanvasRenderingContext2D, p: number, rand: Rand): void {
  drawSuitedDemonFace(ctx, p, rand, 'wailer');
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

export function drawJumpScare(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  scene: JumpScareScene,
  reducedFx: boolean
): void {
  const p = Math.max(0, Math.min(1, scene.t / scene.duration));
  const rand = mulberry32(scene.seed);
  const frameRand = mulberry32((scene.seed ^ (Math.floor(scene.t * 60) * 0x9e3779b9)) >>> 0);
  const appear = smoothstep(0, 0.16, p);
  const fade = 1 - smoothstep(0.68, 1, p);
  const flash = Math.max(0, 1 - smoothstep(0, 0.14, p));
  const tint = scene.source === 'apparition' ? [28, 68, 70] : [126, 18, 13];

  ctx.save();
  if (!reducedFx) {
    const jolt = (1 - smoothstep(0.04, 0.5, p)) * 13;
    ctx.translate((frameRand() - 0.5) * jolt, (frameRand() - 0.5) * jolt);
  }

  ctx.fillStyle = '#020203';
  ctx.fillRect(-30, -30, w + 60, h + 60);

  if (flash > 0.001) {
    ctx.fillStyle = `rgba(238, 226, 204, ${flash * (reducedFx ? 0.05 : 0.26)})`;
    ctx.fillRect(-30, -30, w + 60, h + 60);
  }
  const pulse = p > 0.06 && p < 0.22 ? 1 - Math.abs(p - 0.14) / 0.08 : 0;
  if (pulse > 0) {
    ctx.fillStyle = `rgba(${tint[0]}, ${tint[1]}, ${tint[2]}, ${pulse * (reducedFx ? 0.06 : 0.2)})`;
    ctx.fillRect(-30, -30, w + 60, h + 60);
  }

  const glow = ctx.createRadialGradient(w / 2, h * 0.46, 6, w / 2, h * 0.46, Math.max(w, h) * 0.62);
  glow.addColorStop(0, `rgba(${tint[0]}, ${tint[1]}, ${tint[2]}, ${0.3 * fade})`);
  glow.addColorStop(0.52, `rgba(${tint[0] * 0.5}, ${tint[1] * 0.5}, ${tint[2] * 0.5}, ${0.13 * fade})`);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  const scale = (Math.min(w, h) / 235) * (0.72 + smoothstep(0.01, 0.28, p) * 0.44);
  ctx.translate(w / 2, h * 0.47 + (1 - appear) * h * 0.035);
  ctx.rotate((rand() - 0.5) * 0.03 + Math.sin(p * 17) * 0.006);
  ctx.scale(scale, scale);
  ctx.globalAlpha = appear * fade;
  if (scene.kind === 'crawler') drawCrawlerFace(ctx, p, rand);
  else if (scene.kind === 'wailer') drawWailerFace(ctx, p, rand);
  else drawStalkerFace(ctx, p, rand);
  ctx.restore();

  if (!reducedFx && p > 0.2) {
    const reach = smoothstep(0.2, 0.58, p) * (1 - smoothstep(0.78, 1, p));
    ctx.save();
    ctx.globalAlpha = reach * 0.38;
    ctx.filter = 'blur(4px)';
    drawHand(ctx, w * 0.02, h * 0.87, (Math.min(w, h) / 620) * 1.65, 0.55, '#120c09', '#6c5c48', frameRand);
    drawHand(ctx, w * 0.98, h * 0.9, (Math.min(w, h) / 620) * 1.65, -0.55, '#120c09', '#6c5c48', frameRand);
    ctx.restore();
  }

  for (let i = 0; i < 130; i++) {
    const x = frameRand() * w;
    const y = frameRand() * h;
    ctx.fillStyle = `rgba(220, 210, 190, ${frameRand() * 0.045})`;
    ctx.fillRect(x, y, 1, 0.6 + frameRand() * 2.2);
  }
  ctx.fillStyle = 'rgba(0, 0, 0, 0.075)';
  for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);

  const edge = ctx.createRadialGradient(
    w / 2,
    h * 0.47,
    Math.min(w, h) * 0.26,
    w / 2,
    h * 0.47,
    Math.max(w, h) * 0.72
  );
  edge.addColorStop(0, 'rgba(0,0,0,0)');
  edge.addColorStop(0.6, 'rgba(0,0,0,0.24)');
  edge.addColorStop(1, `rgba(0,0,0,${0.82 * fade})`);
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, w, h);

  if (scene.source !== 'apparition') {
    const after = smoothstep(0.62, 0.78, p) * (1 - smoothstep(0.82, 1, p));
    if (after > 0.01) {
      ctx.fillStyle = `rgba(132, 18, 12, ${after * (reducedFx ? 0.05 : 0.18)})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  if (!reducedFx && p > 0.08 && p < 0.14) {
    const y = h * (0.2 + frameRand() * 0.55);
    ctx.fillStyle = 'rgba(190, 180, 160, 0.08)';
    ctx.fillRect(0, y, w, 2 + frameRand() * 5);
  }

  ctx.restore();
}

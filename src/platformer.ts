/**
 * Animación de guiño: una carrera de plataformas de 8 bits dibujada a mano.
 *
 * Por qué está dibujada y no es un vídeo: el bus USB del panel comprime cada
 * frame antes de mandarlo, así que **el contenido decide los fps**. Medido en
 * este hardware, 1920x462:
 *
 *   arte plano de 8 bits  ->   83 KB por frame  ->  12 fps
 *   imagen fotográfica    ->  517 KB por frame  ->   5 fps
 *
 * Un clip de vídeo real se arrastra; los colores planos van finos. Además el
 * panel es un rectángulo de 4,2:1, que es una ventana pésima para un vídeo
 * (sale una postal diminuta entre dos franjas negras) y en cambio es la forma
 * exacta de un nivel de scroll lateral. De ahí que el guiño por defecto se
 * dibuje aquí en vez de decodificarse.
 *
 * El arte es original, en la paleta del propio panel. Ver docs/instalacion.md.
 */
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';

/** Lado del tile, en píxeles de panel. 7 filas de 66 = 462, la altura exacta. */
const T = 66;
const ROWS = 7;
/** Fila del suelo. Todo lo demás se apoya encima. */
const GROUND_ROW = 6;

/**
 * El nivel, en tiles. Una fila por altura, de arriba abajo.
 *
 *   `#` suelo/bloque macizo   `B` ladrillo   `?` bloque sorpresa
 *   `P` esquina superior izquierda de una tubería (2 de ancho, baja hasta el suelo)
 *   `e` bicho (se apoya en el suelo)          `F` mástil        `C` castillo
 *
 * Reglas que el nivel debe cumplir, y que `platformer.test.ts` verifica:
 * los huecos no pasan de 3 tiles y las tuberías no pasan de 3 de alto, que es
 * lo que alcanza el salto. Si te pasas, el corredor se cae y el guiño se
 * convierte en un vídeo de un tipo muriéndose en bucle.
 */
const MAP: string[] = [
  //        1         2         3         4         5         6         7         8         9
  //234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890
  '                                                                                                    ',
  '                                                                                              C     ',
  '                       B?B?B                                                                        ',
  '     B?B                                                                                            ',
  '                                                                                         F          ',
  '                   e             PP                  e    PP                  e          F          ',
  '#######################################   ######################  #################  ###############',
];

/** Píxeles que avanza el corredor por frame. */
const SPEED = 24.75;
/** Gravedad y empuje del salto, en píxeles/frame. Alcanzan 3,7 tiles de alto y 4,1 de largo. */
const GRAVITY = 16;
const JUMP_V = 88;
/** Rebote al pisar un bicho. */
const STOMP_V = 46;
/**
 * Píxeles que avanza el corredor mientras dura un salto.
 *
 * Se **mide** integrando el mismo salto que hace la simulación, en vez de usar
 * la fórmula continua `2·v/g`. A 12 fps la integración es muy gruesa y la
 * fórmula se equivoca en casi un frame entero: con ella el corredor aterrizaba
 * un píxel corto de la cabeza del bicho y se lo comía al frame siguiente.
 */
function measureJumpReach(): number {
  let y = GROUND_ROW * T;
  let vy = -JUMP_V;
  let frames = 0;
  do {
    vy += GRAVITY;
    y += vy;
    frames++;
  } while (!(vy > 0 && y >= GROUND_ROW * T));
  return frames * SPEED;
}
const JUMP_REACH = measureJumpReach();
/** Velocidad de los bichos, hacia la izquierda. */
const BUG_SPEED = 4;

const COLS = MAP[0]!.length;
export const LEVEL_WIDTH = COLS * T;

/** Ancho del castillo y altura de su tejado. La simulación necesita el ancho
 * para saber dónde está la puerta, así que vive aquí y no dentro del dibujo. */
const CASTLE_W = 5 * T;
const CASTLE_TOP = 2.3 * T;

const SKY = '#5C94FC';
const SKY_DEEP = '#2A5FC8';

interface Pipe { col: number; top: number }
interface Bug { col: number }
interface Block { col: number; row: number; kind: 'B' | '?' | '#' }

interface Level {
  blocks: Block[];
  pipes: Pipe[];
  bugs: Bug[];
  /** Columnas sin suelo. */
  gaps: Set<number>;
  flagCol: number;
  castleCol: number;
}

function parseLevel(): Level {
  const blocks: Block[] = [];
  const pipes: Pipe[] = [];
  const bugs: Bug[] = [];
  const gaps = new Set<number>();
  let flagCol = -1;
  let castleCol = -1;

  for (let row = 0; row < ROWS; row++) {
    const line = MAP[row]!.padEnd(COLS, ' ');
    for (let col = 0; col < COLS; col++) {
      const ch = line[col]!;
      if (ch === '#') blocks.push({ col, row, kind: '#' });
      else if (ch === 'B' || ch === '?') blocks.push({ col, row, kind: ch });
      else if (ch === 'P') {
        // Sólo la esquina superior izquierda marca la tubería; el resto del
        // dibujo se deriva, así el mapa no repite el cuerpo cuatro veces.
        if (line[col - 1] !== 'P' && (MAP[row - 1]?.[col] ?? ' ') !== 'P') pipes.push({ col, top: row });
      } else if (ch === 'e') bugs.push({ col });
      else if (ch === 'F' && flagCol < 0) flagCol = col;
      else if (ch === 'C' && castleCol < 0) castleCol = col;
    }
  }
  for (let col = 0; col < COLS; col++) {
    if (MAP[GROUND_ROW]!.padEnd(COLS, ' ')[col] !== '#') gaps.add(col);
  }
  return { blocks, pipes, bugs, gaps, flagCol, castleCol };
}

export const LEVEL = parseLevel();

/** Huecos contiguos agrupados en tramos `[primera, última]`. */
export function gapGroups(): [number, number][] {
  const cols = [...LEVEL.gaps].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const c of cols) {
    const last = out[out.length - 1];
    if (last && c === last[1] + 1) last[1] = c;
    else out.push([c, c]);
  }
  return out;
}

/** Y (píxeles) de la superficie sobre la que se anda en una columna dada. */
function surfaceAt(x: number): number {
  const col = Math.floor(x / T);
  if (col < 0 || col >= COLS) return GROUND_ROW * T;
  // Encima de una tubería se pisa su boca, no el suelo: caer *dentro* del
  // cilindro es el detalle que delata que esto no es un juego de verdad.
  for (const p of LEVEL.pipes) {
    if (col >= p.col && col < p.col + 2) return p.top * T;
  }
  if (LEVEL.gaps.has(col)) return Number.POSITIVE_INFINITY; // hueco: no hay dónde pisar
  return GROUND_ROW * T;
}

/**
 * Puntos de despegue, calculados a partir de los obstáculos.
 *
 * Se precalculan en vez de decidirse con un "¿hay algo delante?" en vivo
 * porque cada obstáculo quiere su propia antelación: un hueco se salta desde
 * el borde y una tubería desde más lejos, para pasar por encima del sombrero.
 *
 * Los bichos no salen aquí: andan, así que su distancia depende del momento y
 * se persiguen en vivo dentro de la simulación.
 */
function jumpTriggers(): number[] {
  const t: number[] = [];
  // Tubería: se aterriza al menos medio tile pasada, nunca encima ni dentro.
  for (const p of LEVEL.pipes) t.push(p.col * T + 2.6 * T - JUMP_REACH);
  // Hueco: se despega lo más tarde posible, pero nunca tan tarde que el salto
  // no llegue al otro lado. Con huecos estrechos manda el borde; con los
  // anchos, el alcance.
  for (const [from, to] of gapGroups()) {
    t.push(Math.max(from * T - 0.6 * T, (to + 1) * T + 0.4 * T - JUMP_REACH));
  }
  return t.sort((a, b) => a - b);
}

const TRIGGERS = jumpTriggers();

/** Disparador de cada hueco, por columna de inicio: el destino cancela justo ese. */
const GAP_TRIGGER = new Map<number, number>(
  gapGroups().map(([from, to]) => [from, Math.max(from * T - 0.6 * T, (to + 1) * T + 0.4 * T - JUMP_REACH)]),
);

export type Phase = 'run' | 'slide' | 'walk' | 'hold' | 'muere' | 'reintento';

/**
 * Cómo acaba esta pasada.
 *
 * El guiño se repite cada cuarto de hora: si siempre saliera la misma carrera
 * perfecta, a la tercera vez ya nadie levanta la vista. Así que cada pase se
 * siembra con la hora y el corredor la pifia en un sitio distinto, o la
 * completa de vez en cuando, que es lo que hace que completarla tenga gracia.
 */
export type Fate =
  | { kind: 'completa' }
  | { kind: 'hueco'; col: number }
  | { kind: 'bicho'; index: number };



/**
 * Reparto de finales. `completa` sale dos veces de cada N para que sea el caso
 * raro pero no excepcional: el premio de mirar al panel en el momento justo.
 */
export function fateFor(seed: number): Fate {
  const stumbles: Fate[] = [
    // Los primeros obstáculos se descartan: caerse a los dos segundos de
    // empezar no da tiempo ni a darse cuenta de que hay una animación.
    ...gapGroups().map(([col]) => col).filter((c) => c > 20).map((col) => ({ kind: 'hueco', col }) as const),
    ...LEVEL.bugs.map((b, index) => ({ kind: 'bicho', index }) as const).filter((_, i) => LEVEL.bugs[i]!.col > 20),
  ];
  if (stumbles.length === 0) return { kind: 'completa' };
  const pick = ((seed % (stumbles.length + 2)) + stumbles.length + 2) % (stumbles.length + 2);
  return pick < 2 ? { kind: 'completa' } : stumbles[pick - 2]!;
}

export interface Frame {
  /** Esquina izquierda de la cámara, en píxeles de mundo. */
  camera: number;
  heroX: number;
  /** Y de los pies. */
  heroY: number;
  airborne: boolean;
  phase: Phase;
  /** Bichos aplastados: índice -> frame en que ocurrió. */
  squashed: Map<number, number>;
  /** Posición de cada bicho vivo, en píxeles. */
  bugX: number[];
  /** 0..1, cuánto ha subido la bandera del castillo. */
  castleFlag: number;
  coins: number;
  index: number;
}

const SLIDE_FRAMES = 12;
/** Tope del paseo final; lo normal es que lo corte antes la puerta del castillo. */
const WALK_FRAMES = 60;
const HOLD_FRAMES = 14;
const CARD_FRAMES = 16;
/** Empuje del salto de la muerte, el respingo antes de caerse de la pantalla. */
const DEATH_V = 58;

/**
 * Simula la carrera entera y devuelve un frame por paso.
 *
 * Determinista a partir de la semilla: sin `Math.random` ni reloj. Eso permite
 * que el test afirme que el corredor sólo se cae donde el destino dice, y no
 * por un fallo de puntería del disparador de saltos.
 */
export function simulate(width: number, seed = 0): Frame[] {
  const fate = fateFor(seed);
  const frames: Frame[] = [];
  const flagX = LEVEL.flagCol * T;
  /** Puerta del castillo: donde termina el paseo y el corredor desaparece dentro. */
  const doorX = LEVEL.castleCol * T + CASTLE_W / 2;

  let x = 2 * T;
  let y = GROUND_ROW * T;
  let vy = 0;
  let airborne = false;
  let nextTrigger = 0;
  let coins = 0;
  const squashed = new Map<number, number>();
  const bugX = LEVEL.bugs.map((b) => b.col * T);
  /** Bichos a los que ya se les ha lanzado un salto; no se intenta dos veces. */
  const attempted = new Set<number>();

  const maxCamera = Math.max(0, LEVEL_WIDTH - width);
  const cameraFor = (hx: number) => Math.max(0, Math.min(maxCamera, hx - width * 0.34));

  let phase: Phase = 'run';
  let index = 0;
  let phaseFrame = 0;
  let castleFlag = 0;
  let camera = cameraFor(x);

  // Tope de seguridad: el nivel es finito, pero un mapa mal editado no debe
  // colgar el daemon en un bucle infinito.
  for (let guard = 0; guard < 4000; guard++) {
    if (phase === 'run') {
      x += SPEED;

      // Un salto por bicho, disparado en cuanto entra en alcance. La condición
      // es "ya está a tiro", no "está justo a esta distancia": el corredor se
      // acerca a saltos de casi 30 px y una ventana estrecha se salta de largo
      // sin llegar a verla.
      const closing = JUMP_REACH * ((SPEED + BUG_SPEED) / SPEED);
      let bugAhead = false;
      for (let i = 0; i < bugX.length; i++) {
        if (squashed.has(i) || attempted.has(i)) continue;
        if (bugX[i]! - x > closing) continue;
        attempted.add(i);
        // El destino elegido para esta pasada: aquí no se salta, y el bicho se
        // lo lleva por delante.
        if (fate.kind === 'bicho' && fate.index === i) continue;
        bugAhead = true;
      }

      let staticTrigger = false;
      while (nextTrigger < TRIGGERS.length && x >= TRIGGERS[nextTrigger]!) {
        const skip = fate.kind === 'hueco' && TRIGGERS[nextTrigger]! === GAP_TRIGGER.get(fate.col);
        if (!skip) staticTrigger = true;
        nextTrigger++;
      }

      if (!airborne && (staticTrigger || bugAhead)) {
        vy = -JUMP_V;
        airborne = true;
      }

      if (airborne) {
        vy += GRAVITY;
        y += vy;
        if (vy > 0) {
          for (let i = 0; i < bugX.length; i++) {
            if (squashed.has(i)) continue;
            if (Math.abs(bugX[i]! - x) < T * 0.8 && y >= GROUND_ROW * T - T * 0.6) {
              squashed.set(i, index);
              vy = -STOMP_V;
              coins += 100;
            }
          }
        }
        const floor = surfaceAt(x);
        if (vy > 0 && y >= floor) {
          y = floor;
          vy = 0;
          airborne = false;
        }
      }

      // Chocar de frente con un bicho, en el suelo, es el final de la pasada.
      if (!airborne) {
        for (let i = 0; i < bugX.length; i++) {
          if (squashed.has(i)) continue;
          if (Math.abs(bugX[i]! - x) < T * 0.55) {
            phase = 'muere';
            vy = -DEATH_V;
            phaseFrame = 0;
          }
        }
      }

      // Quedarse sin suelo bajo los pies: un hueco, o el borde de una tubería
      // sobre la que se acaba de aterrizar. Sin esto el corredor sigue andando
      // por el aire a la altura de la boca de la tubería.
      if (!airborne && y < surfaceAt(x)) {
        airborne = true;
        vy = 0;
      }
      if (y > ROWS * T) {
        phase = 'muere';
        phaseFrame = 0;
      }

      for (let i = 0; i < bugX.length; i++) {
        if (!squashed.has(i) && bugX[i]! - x < width * 0.7) bugX[i] = bugX[i]! - BUG_SPEED;
      }

      if (phase === 'run' && x >= flagX) {
        x = flagX;
        y = 2.2 * T;
        phase = 'slide';
        phaseFrame = 0;
        coins += 500;
      }
      camera = cameraFor(x);
    } else if (phase === 'muere') {
      // La cámara se queda quieta: el corredor se cae de la escena, no la escena de él.
      vy += GRAVITY;
      y += vy;
      phaseFrame++;
      if (y > ROWS * T + 260) {
        phase = 'reintento';
        phaseFrame = 0;
      }
    } else if (phase === 'reintento') {
      if (++phaseFrame > CARD_FRAMES) break;
    } else if (phase === 'slide') {
      y = 2.2 * T + (GROUND_ROW * T - 2.2 * T) * (phaseFrame / SLIDE_FRAMES);
      camera = cameraFor(flagX + width * 0.2);
      if (++phaseFrame > SLIDE_FRAMES) {
        phase = 'walk';
        phaseFrame = 0;
        y = GROUND_ROW * T;
      }
    } else if (phase === 'walk') {
      x += SPEED * 0.75;
      camera = cameraFor(flagX + width * 0.2);
      castleFlag = Math.min(1, (x - flagX) / (doorX - flagX));
      if (x >= doorX || ++phaseFrame > WALK_FRAMES) {
        phase = 'hold';
        phaseFrame = 0;
      }
    } else {
      castleFlag = 1;
      if (++phaseFrame > HOLD_FRAMES) break;
    }

    frames.push({
      camera,
      heroX: x,
      heroY: y,
      airborne,
      phase,
      squashed: new Map(squashed),
      bugX: [...bugX],
      castleFlag,
      coins,
      index,
    });
    index++;
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Dibujo
// ---------------------------------------------------------------------------

/**
 * Fuente de 5x7 para el marcador. Va aquí en vez de usar DejaVu porque una
 * tipografía suavizada al lado de sprites de bloques canta muchísimo, y porque
 * así la animación no depende de que existan las fuentes de la config.
 * Cada glifo son 7 filas de 5 bits.
 */
const GLYPHS: Record<string, string> = {
  A: '01110 10001 10001 11111 10001 10001 10001',
  B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110',
  D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111',
  F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111',
  H: '10001 10001 10001 11111 10001 10001 10001',
  I: '11111 00100 00100 00100 00100 00100 11111',
  J: '00111 00010 00010 00010 00010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001',
  L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001',
  N: '10001 11001 10101 10011 10001 10001 10001',
  O: '01110 10001 10001 10001 10001 10001 01110',
  P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101',
  R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110',
  T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110',
  V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 11011 10001',
  X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100',
  Z: '11111 00001 00010 00100 01000 10000 11111',
  '0': '01110 10011 10101 10101 11001 10001 01110',
  '1': '00100 01100 00100 00100 00100 00100 01110',
  '2': '01110 10001 00001 00110 01000 10000 11111',
  '3': '11111 00010 00100 00010 00001 10001 01110',
  '4': '00010 00110 01010 10010 11111 00010 00010',
  '5': '11111 10000 11110 00001 00001 10001 01110',
  '6': '00110 01000 10000 11110 10001 10001 01110',
  '7': '11111 00001 00010 00100 01000 01000 01000',
  '8': '01110 10001 10001 01110 10001 10001 01110',
  '9': '01110 10001 10001 01111 00001 00010 01100',
  '?': '01110 10001 00001 00110 00100 00000 00100',
  '!': '00100 00100 00100 00100 00100 00000 00100',
  '.': '00000 00000 00000 00000 00000 00000 00100',
  '-': '00000 00000 00000 11111 00000 00000 00000',
  ' ': '00000 00000 00000 00000 00000 00000 00000',
};

function drawPixelText(ctx: SKRSContext2D, text: string, x: number, y: number, px: number, color: string): void {
  ctx.fillStyle = color;
  let cx = x;
  for (const ch of text.toUpperCase()) {
    // Sin el recuadro, una letra que falte se traga en silencio y el texto
    // queda con huecos sin que nadie se entere.
    const glyph = GLYPHS[ch] ?? '11111 10001 10001 10001 10001 10001 11111';
    {
      const rows = glyph.split(' ');
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r]!;
        for (let c = 0; c < row.length; c++) {
          if (row[c] === '1') ctx.fillRect(cx + c * px, y + r * px, px, px);
        }
      }
    }
    cx += 6 * px;
  }
}

/**
 * El corredor, 12x16 en la paleta del panel: gorra y camiseta ámbar, peto
 * teal. Es el arquetipo del género, no un personaje concreto de nadie.
 */
const HERO_COLORS: Record<string, string> = {
  A: '#FFB020', // gorra y camiseta
  S: '#F2C9A0', // piel
  K: '#2A1A12', // ojo
  O: '#2E8A82', // peto
  N: '#1F6259', // sombra del peto
  B: '#4A2E1E', // botas
  H: '#8A5A2B', // pelo
};

const HERO_BODY = [
  '....AAAAA...',
  '...AAAAAAAA.',
  '...HHSSSKS..',
  '...HSSSSKSS.',
  '...HSSSSSSS.',
  '....SSSSSS..',
  '.....SSSS...',
  '..AAAAAAAA..',
  '.AAAOAAAOAA.',
  'AAAAOOOOAAAA',
  'AAAAOOOOAAAA',
];

const HERO_LEGS = [
  ['.AAAOOOOAAA.', '...OOOOOO...', '...OO..OO...', '..BBB..BBB..', '..BBB..BBB..'],
  ['.AAAOOOOAAA.', '...OOOOOO...', '..OO....OO..', '.BBB......BB', '.BBB......BB'],
  ['.AAAOOOOAAA.', '...OOOOOO...', '....OOOO....', '...BBBBBB...', '...BBBBBB...'],
];

const HERO_LEGS_AIR = ['.AAAOOOOAAA.', '..NOOOOOON..', '.OO......OO.', 'BBB.......BB', 'BBB.........'];

/** La pose de la derrota: brazos arriba, ojos en cruz, cayéndose del nivel. */
const HERO_DEAD = [
  'A..........A',
  'AA.......AA.',
  '.AA.AAAAA.A.',
  '..AAAAAAAA..',
  '..SKSSSSKS..',
  '..SSKSSKSS..',
  '..SKSSSSKS..',
  '...SSSSSS...',
  '..AAAAAAAA..',
  '.AAAOOOOAAA.',
  '.AAAOOOOAAA.',
  '..OOOOOOOO..',
  '..OO....OO..',
  '..BB....BB..',
  '.BBB....BBB.',
  '............',
];

/** Lado del píxel del sprite: 12 de ancho -> ~1,1 tiles. */
const HERO_PX = 7;
const HERO_W = 12 * HERO_PX;
const HERO_H = 16 * HERO_PX;

function drawSprite(ctx: SKRSContext2D, rows: string[], x: number, y: number, px: number, colors: Record<string, string>): void {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    for (let c = 0; c < row.length; c++) {
      const color = colors[row[c]!];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x + c * px, y + r * px, px, px);
    }
  }
}

function drawHero(ctx: SKRSContext2D, f: Frame): void {
  // En 'hold' ya ha entrado por la puerta del castillo.
  if (f.phase === 'hold') return;
  const x = Math.round(f.heroX - f.camera - HERO_W / 2);
  const y = Math.round(f.heroY - HERO_H);
  if (f.phase === 'muere') {
    drawSprite(ctx, HERO_DEAD, x, y, HERO_PX, HERO_COLORS);
    return;
  }
  const legs = f.airborne || f.phase === 'slide' ? HERO_LEGS_AIR : HERO_LEGS[Math.floor(f.index / 2) % HERO_LEGS.length]!;
  drawSprite(ctx, HERO_BODY, x, y, HERO_PX, HERO_COLORS);
  drawSprite(ctx, legs, x, y + HERO_BODY.length * HERO_PX, HERO_PX, HERO_COLORS);
}

/** El cartel negro de "te queda una vida", calcado en espíritu al del original. */
function drawRetryCard(ctx: SKRSContext2D, width: number, height: number): void {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  const px = 6;
  const cx = width / 2;
  const centre = (t: string, p: number) => cx - (t.length * 6 * p) / 2;
  drawPixelText(ctx, 'MUNDO 1-1', centre('MUNDO 1-1', px), height * 0.26, px, '#FFFFFF');
  // La cabeza del corredor y las vidas que le quedan, como grupo centrado.
  const headPx = 7;
  const lives = 'X  2';
  const groupW = 12 * headPx + 30 + lives.length * 6 * px;
  const left = cx - groupW / 2;
  drawSprite(ctx, HERO_BODY.slice(0, 7), left, height * 0.48, headPx, HERO_COLORS);
  drawPixelText(ctx, lives, left + 12 * headPx + 30, height * 0.52, px, '#FFFFFF');
  drawPixelText(ctx, 'OTRA VEZ SERA', centre('OTRA VEZ SERA', 3), height * 0.82, 3, '#627180');
}

const BUG_COLORS: Record<string, string> = { X: '#B84A3A', D: '#2A1A12', W: '#EFEFEF', F: '#7A2E22' };
const BUG = [
  '..XXXXXX..',
  '.XXXXXXXX.',
  'XXWDXXDWXX',
  'XXWDXXDWXX',
  'XXXXXXXXXX',
  '.XXXXXXXX.',
  '..FF..FF..',
  '.FFF..FFF.',
];
const BUG_FLAT = ['..........', '..........', '..........', '..........', '..XXXXXX..', '.XXXXXXXX.', 'XXXXXXXXXX', '.FF....FF.'];
const BUG_PX = 6;

function drawBugs(ctx: SKRSContext2D, f: Frame): void {
  for (let i = 0; i < f.bugX.length; i++) {
    const squashedAt = f.squashed.get(i);
    // Un bicho aplastado se queda un momento y desaparece, como manda el género.
    if (squashedAt !== undefined && f.index - squashedAt > 8) continue;
    const rows = squashedAt !== undefined ? BUG_FLAT : BUG;
    const x = Math.round(f.bugX[i]! - f.camera - (BUG[0]!.length * BUG_PX) / 2);
    if (x < -100 || x > 2100) continue;
    drawSprite(ctx, rows, x, GROUND_ROW * T - rows.length * BUG_PX, BUG_PX, BUG_COLORS);
  }
}

function drawBlock(ctx: SKRSContext2D, b: Block, sx: number, y: number, frameIndex: number): void {
  if (b.kind === '#') {
    ctx.fillStyle = '#C84C0C';
    ctx.fillRect(sx, y, T, T);
    ctx.fillStyle = '#8A3308';
    // Aparejo de ladrillo: dos hiladas trabadas.
    for (let r = 0; r < 2; r++) {
      ctx.fillRect(sx, y + r * (T / 2) + T / 2 - 3, T, 3);
      ctx.fillRect(sx + (r % 2 ? T / 4 : (T * 3) / 4) - 1.5, y + r * (T / 2), 3, T / 2);
    }
    return;
  }
  if (b.kind === 'B') {
    ctx.fillStyle = '#B5651D';
    ctx.fillRect(sx, y, T, T);
    ctx.fillStyle = '#7A3E10';
    ctx.fillRect(sx, y, T, 4);
    ctx.fillRect(sx, y + T / 2 - 2, T, 4);
    ctx.fillRect(sx + T / 2 - 2, y + 4, 4, T / 2 - 6);
    ctx.fillRect(sx + T / 4 - 2, y + T / 2 + 2, 4, T / 2 - 2);
    ctx.fillRect(sx + (T * 3) / 4 - 2, y + T / 2 + 2, 4, T / 2 - 2);
    return;
  }
  // Bloque sorpresa: parpadea, que es media gracia del original.
  const lit = Math.floor(frameIndex / 3) % 4;
  ctx.fillStyle = ['#E8A21C', '#FFB020', '#E8A21C', '#B87A10'][lit]!;
  ctx.fillRect(sx, y, T, T);
  ctx.fillStyle = '#7A4E08';
  ctx.fillRect(sx, y, T, 4);
  ctx.fillRect(sx, y + T - 4, T, 4);
  ctx.fillRect(sx, y, 4, T);
  ctx.fillRect(sx + T - 4, y, 4, T);
  drawPixelText(ctx, '?', sx + T / 2 - 10, y + T / 2 - 14, 4, '#7A4E08');
}

function drawPipe(ctx: SKRSContext2D, p: Pipe, sx: number): void {
  const top = p.top * T;
  const h = (GROUND_ROW - p.top) * T;
  ctx.fillStyle = '#04380F';
  ctx.fillRect(sx - 4, top - 4, 2 * T + 8, h + 4);
  ctx.fillStyle = '#00A800';
  ctx.fillRect(sx + 6, top + T * 0.42, 2 * T - 12, h - T * 0.42);
  ctx.fillRect(sx, top, 2 * T, T * 0.42);
  ctx.fillStyle = '#00D000';
  ctx.fillRect(sx + 12, top + 6, 14, T * 0.42 - 12);
  ctx.fillRect(sx + 18, top + T * 0.42, 12, h - T * 0.42);
  ctx.fillStyle = '#006000';
  ctx.fillRect(sx + 2 * T - 16, top, 10, T * 0.42);
  ctx.fillRect(sx + 2 * T - 22, top + T * 0.42, 10, h - T * 0.42);
}

/** Nubes y colinas, a media velocidad, para que el fondo tenga profundidad. */
function drawBackdrop(ctx: SKRSContext2D, camera: number, width: number): void {
  const grad = ctx.createLinearGradient(0, 0, 0, ROWS * T);
  grad.addColorStop(0, SKY_DEEP);
  grad.addColorStop(0.55, SKY);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, ROWS * T);

  const par = camera * 0.35;
  // Verde propio, más apagado: con el mismo `#00A800` de las tuberías, una
  // tubería delante de una colina desaparecía y sólo se le veían los brillos.
  ctx.fillStyle = '#1E7C34';
  for (let i = 0; i < 14; i++) {
    const x = ((i * 640 - par) % (LEVEL_WIDTH * 0.6) + LEVEL_WIDTH * 0.6) % (LEVEL_WIDTH * 0.6) - 200;
    const r = i % 2 ? 150 : 96;
    ctx.beginPath();
    ctx.arc(x, GROUND_ROW * T, r, Math.PI, 0);
    ctx.arc(x + r * 0.75, GROUND_ROW * T, r * 0.7, Math.PI, 0);
    ctx.fill();
  }

  const cpar = camera * 0.18;
  ctx.fillStyle = '#FFFFFF';
  for (let i = 0; i < 12; i++) {
    const x = ((i * 730 + 120 - cpar) % (LEVEL_WIDTH * 0.5) + LEVEL_WIDTH * 0.5) % (LEVEL_WIDTH * 0.5) - 150;
    const y = 40 + (i % 3) * 46;
    const s = i % 2 ? 1 : 0.75;
    for (const [dx, dy, r] of [[0, 0, 26], [30, -12, 34], [64, 0, 26], [32, 10, 30]] as const) {
      ctx.beginPath();
      ctx.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawFlagAndCastle(ctx: SKRSContext2D, f: Frame, width: number): void {
  const poleX = LEVEL.flagCol * T - f.camera + T * 0.4;
  if (poleX > -80 && poleX < width + 80) {
    ctx.fillStyle = '#00A800';
    ctx.fillRect(poleX, 1.6 * T, 8, GROUND_ROW * T - 1.6 * T);
    ctx.fillStyle = '#DADADA';
    ctx.fillRect(poleX - 10, 1.4 * T, 28, 20);
    // La bandera baja con el corredor mientras se desliza.
    const drop = f.phase === 'run' ? 0 : Math.min(1, (f.heroY - 2.2 * T) / (GROUND_ROW * T - 2.2 * T));
    const fy = 1.9 * T + drop * (GROUND_ROW * T - 2.9 * T);
    ctx.fillStyle = '#2E8A82';
    ctx.beginPath();
    ctx.moveTo(poleX, fy);
    ctx.lineTo(poleX - 62, fy + 22);
    ctx.lineTo(poleX, fy + 44);
    ctx.closePath();
    ctx.fill();
  }

  const cx = LEVEL.castleCol * T - f.camera;
  if (cx > -400 && cx < width + 400) {
    const cw = CASTLE_W;
    const top = CASTLE_TOP;
    ctx.fillStyle = '#C84C0C';
    ctx.fillRect(cx, top, cw, GROUND_ROW * T - top);
    ctx.fillStyle = '#8A3308';
    // Almenas.
    for (let i = 0; i < 5; i++) if (i % 2 === 0) ctx.fillRect(cx + i * (cw / 5), top - 22, cw / 5, 22);
    ctx.fillRect(cx + cw / 2 - T * 0.45, GROUND_ROW * T - T * 1.4, T * 0.9, T * 1.4);
    ctx.fillStyle = '#2A1A12';
    ctx.fillRect(cx + cw / 2 - T * 0.3, GROUND_ROW * T - T * 1.1, T * 0.6, T * 1.1);
    // Mástil del castillo: la bandera sube al terminar.
    const px = cx + cw / 2;
    ctx.fillStyle = '#DADADA';
    ctx.fillRect(px - 3, top - 96, 6, 96);
    if (f.castleFlag > 0) {
      const fy = top - 18 - f.castleFlag * 58;
      ctx.fillStyle = '#FFB020';
      ctx.fillRect(px + 3, fy, 54, 34);
    }
  }
}

/** Texto del marcador con sombra: en blanco puro las nubes se lo tragaban. */
function hud(ctx: SKRSContext2D, text: string, x: number, y: number, px: number): void {
  drawPixelText(ctx, text, x + px, y + px, px, 'rgba(0,0,0,0.45)');
  drawPixelText(ctx, text, x, y, px, '#FFFFFF');
}

function drawHud(ctx: SKRSContext2D, f: Frame, total: number, width: number): void {
  const px = 4;
  const y = 22;
  const line2 = y + 9 * px;
  const centre = (t: string, cx: number) => cx - (t.length * 6 * px) / 2;
  hud(ctx, 'AIMONITOR', 40, y, px);
  hud(ctx, String(f.coins).padStart(6, '0'), 40, line2, px);
  hud(ctx, 'MUNDO', centre('MUNDO', width / 2), y, px);
  hud(ctx, '1-1', centre('1-1', width / 2), line2, px);
  const left = Math.max(0, Math.ceil(((total - f.index) / total) * 400));
  hud(ctx, 'TIEMPO', centre('TIEMPO', width - 160), y, px);
  hud(ctx, String(left).padStart(3, '0'), centre(String(left).padStart(3, '0'), width - 160), line2, px);
}

/** Pinta un frame ya simulado sobre el contexto dado. */
export function drawFrame(ctx: SKRSContext2D, f: Frame, total: number, width: number, height: number): void {
  if (f.phase === 'reintento') {
    drawRetryCard(ctx, width, height);
    return;
  }
  ctx.save();
  // El panel mide 462 exactos, pero si algún día reporta otra altura la escena
  // se escala en vez de recortarse.
  const scale = height / (ROWS * T);
  ctx.scale(1, scale);
  const w = width;

  drawBackdrop(ctx, f.camera, w);

  for (const b of LEVEL.blocks) {
    const sx = b.col * T - f.camera;
    if (sx < -T || sx > w) continue;
    drawBlock(ctx, b, sx, b.row * T, f.index);
  }
  for (const p of LEVEL.pipes) {
    const sx = p.col * T - f.camera;
    if (sx < -2 * T || sx > w) continue;
    drawPipe(ctx, p, sx);
  }
  drawFlagAndCastle(ctx, f, w);
  drawBugs(ctx, f);
  drawHero(ctx, f);
  drawHud(ctx, f, total, w);
  ctx.restore();
}

/**
 * Rasterizador perezoso: entrega los frames de uno en uno.
 *
 * No se cachean en disco a propósito. Rasterizar un frame cuesta bastante
 * menos que mandarlo por USB (~80 ms), así que dibujar el siguiente mientras
 * viaja el actual sale gratis. Cachear costaría decenas de MB por variante y
 * mataría justo lo que le da la gracia: que cada pasada sea distinta.
 */
export function animation(width: number, height: number, seed = 0) {
  const frames = simulate(width, seed);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  return {
    count: frames.length,
    fate: fateFor(seed),
    async frame(i: number): Promise<Buffer> {
      drawFrame(ctx, frames[i]!, frames.length, width, height);
      return canvas.encode('png');
    },
  };
}

/**
 * Minimal QR Code encoder (model 2, byte mode, error correction level M, versions 1 to 10, so
 * up to 213 bytes). Enough for an `otpauth://` setup URI without a new dependency. Verified in
 * `qr.test.ts` by decoding the output with `jsqr`.
 *
 * Follows ISO/IEC 18004: data bits -> Reed-Solomon per block -> interleave -> function patterns
 * -> zigzag placement -> best of 8 masks by penalty score -> format and version information.
 */

/** [data codewords per block, EC codewords per block, blocks in group 1, data cw in group 2 blocks, blocks in group 2] per version 1..10, level M. */
const BLOCKS_M: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [16, 10, 1, 0, 0],
  [28, 16, 1, 0, 0],
  [44, 26, 1, 0, 0],
  [32, 18, 2, 0, 0],
  [43, 24, 2, 0, 0],
  [27, 16, 4, 0, 0],
  [31, 18, 4, 0, 0],
  [38, 22, 2, 39, 2],
  [36, 22, 3, 37, 2],
  [43, 26, 4, 44, 1],
];

const ALIGNMENT_CENTERS: ReadonlyArray<readonly number[]> = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

export const QR_MAX_BYTES = 213;

function dataCodewords(version: number): number {
  const [g1, , n1, g2, n2] = BLOCKS_M[version - 1] as (typeof BLOCKS_M)[number];
  return g1 * n1 + g2 * n2;
}

function byteCapacity(version: number): number {
  const countBits = version >= 10 ? 16 : 8;
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits) / 8);
}

// --- Reed-Solomon over GF(256) with polynomial 0x11D ---------------------------------------------

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j] as number, root);
      if (j + 1 < degree) result[j] = (result[j] as number) ^ (result[j + 1] as number);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] = (result[i] as number) ^ gfMultiply(coef, factor);
    });
  }
  return result;
}

// --- Bit helpers ---------------------------------------------------------------------------------

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function utf8(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

// --- Matrix construction -------------------------------------------------------------------------

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
    this.isFunction = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
  }

  set(x: number, y: number, dark: boolean, fn = true): void {
    (this.modules[y] as boolean[])[x] = dark;
    if (fn) (this.isFunction[y] as boolean[])[x] = true;
  }

  get(x: number, y: number): boolean {
    return (this.modules[y] as boolean[])[x] as boolean;
  }

  drawFunctionPatterns(): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(n - 4, 3);
    this.drawFinder(3, n - 4);
    const centers = ALIGNMENT_CENTERS[this.version - 1] as readonly number[];
    centers.forEach((cy, i) => {
      centers.forEach((cx, j) => {
        const onFinder =
          (i === 0 && j === 0) ||
          (i === 0 && j === centers.length - 1) ||
          (i === centers.length - 1 && j === 0);
        if (!onFinder) this.drawAlignment(cx, cy);
      });
    });
    this.drawFormat(0); // reserve the format areas
    this.drawVersion();
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        this.set(x, y, dist !== 2 && dist !== 4);
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  /** Level M has indicator bits 00. */
  drawFormat(mask: number): void {
    const data = (0 << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    const n = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(i));
    this.set(8, n - 8, true); // always-dark module
  }

  private drawVersion(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  drawCodewords(data: number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!(this.isFunction[y] as boolean[])[x] && i < data.length * 8) {
            this.set(x, y, (((data[i >>> 3] as number) >>> (7 - (i & 7))) & 1) !== 0, false);
            i++;
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if ((this.isFunction[y] as boolean[])[x]) continue;
        let invert: boolean;
        switch (mask) {
          case 0:
            invert = (x + y) % 2 === 0;
            break;
          case 1:
            invert = y % 2 === 0;
            break;
          case 2:
            invert = x % 3 === 0;
            break;
          case 3:
            invert = (x + y) % 3 === 0;
            break;
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          case 5:
            invert = ((x * y) % 2) + ((x * y) % 3) === 0;
            break;
          case 6:
            invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          default:
            invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
        }
        if (invert) (this.modules[y] as boolean[])[x] = !this.get(x, y);
      }
    }
  }

  penalty(): number {
    const n = this.size;
    let result = 0;
    const lines: boolean[][] = [];
    for (let y = 0; y < n; y++) lines.push(this.modules[y] as boolean[]);
    for (let x = 0; x < n; x++) lines.push(this.modules.map((row) => row[x] as boolean));
    for (const line of lines) {
      // N1: runs of 5 or more; N3: 1:1:3:1:1 finder-like patterns.
      let run = 1;
      for (let i = 1; i <= n; i++) {
        if (i < n && line[i] === line[i - 1]) {
          run++;
        } else {
          if (run >= 5) result += 3 + (run - 5);
          run = 1;
        }
      }
      const text = line.map((d) => (d ? "1" : "0")).join("");
      for (const pattern of ["10111010000", "00001011101"]) {
        let at = text.indexOf(pattern);
        while (at !== -1) {
          result += 40;
          at = text.indexOf(pattern, at + 1);
        }
      }
    }
    // N2: 2x2 blocks of one colour.
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = this.get(x, y);
        if (c === this.get(x + 1, y) && c === this.get(x, y + 1) && c === this.get(x + 1, y + 1)) {
          result += 3;
        }
      }
    }
    // N4: dark/light balance.
    const dark = this.modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
    const percent = (dark * 100) / (n * n);
    result += Math.floor(Math.abs(percent - 50) / 5) * 10;
    return result;
  }
}

// --- Public API ----------------------------------------------------------------------------------

/** Dark modules as `matrix[y][x]`, or `null` when `text` does not fit (more than 213 bytes). */
export function encodeQr(text: string): boolean[][] | null {
  const bytes = utf8(text);
  const version = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((v) => byteCapacity(v) >= bytes.length);
  if (!version) return null;

  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, version >= 10 ? 16 : 8);
  for (const byte of bytes) appendBits(bits, byte, 8);
  const capacityBits = dataCodewords(version) * 8;
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(bits, pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  }

  const [g1, ecLen, n1, g2, n2] = BLOCKS_M[version - 1] as (typeof BLOCKS_M)[number];
  const divisor = rsDivisor(ecLen);
  const dataBlocks: number[][] = [];
  let offset = 0;
  for (let b = 0; b < n1 + n2; b++) {
    const length = b < n1 ? g1 : g2;
    dataBlocks.push(data.slice(offset, offset + length));
    offset += length;
  }
  const ecBlocks = dataBlocks.map((block) => rsRemainder(block, divisor));
  const interleaved: number[] = [];
  for (let i = 0; i < Math.max(g1, g2); i++) {
    for (const block of dataBlocks) if (i < block.length) interleaved.push(block[i] as number);
  }
  for (let i = 0; i < ecLen; i++)
    for (const block of ecBlocks) interleaved.push(block[i] as number);

  const matrix = new Matrix(version);
  matrix.drawFunctionPatterns();
  matrix.drawCodewords(interleaved);

  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    matrix.applyMask(mask);
    matrix.drawFormat(mask);
    const penalty = matrix.penalty();
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    matrix.applyMask(mask); // XOR again to undo
  }
  matrix.applyMask(bestMask);
  matrix.drawFormat(bestMask);
  return matrix.modules;
}

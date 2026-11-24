// Tiny stack VM for make.fun's tiny-stack-vm-01 bounty (kit ISA v1).
// Runs each program of a set (program.bin + input.bin under /input/<id>/)
// and writes /output/<id>/stdout.bin and /output/<id>/exit.txt.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUTPUT_MAX = 65536;

function run(p: Uint8Array, inp: Uint8Array): { out: Uint8Array; code: number } {
  const D = new Int32Array(256); // data stack
  const C = new Int32Array(64); // call stack (return addresses)
  const M = new Int32Array(256); // memory words
  const out = new Uint8Array(OUTPUT_MAX);
  let sp = 0;
  let cp = 0;
  let pc = 0;
  let ip = 0;
  let steps = 0;
  let olen = 0;
  const n = p.length;

  // End the program, keeping the output written so far.
  const end = (code: number): { out: Uint8Array; code: number } => ({
    out: out.subarray(0, olen),
    code,
  });

  for (;;) {
    if (steps === 1000000) return end(10); // step limit
    if (pc < 0 || pc >= n) return end(9); // pc outside the program
    const op = p[pc];
    // Immediate bytes: PUSH8 1, PUSH32 4, JMP/JZ/JNZ/CALL 2, else 0.
    const imm = op === 0x01 ? 1 : op === 0x02 ? 4 : op >= 0x30 && op <= 0x33 ? 2 : 0;
    const known =
      op <= 0x07 ||
      (op >= 0x10 && op <= 0x22) ||
      (op >= 0x30 && op <= 0x34) ||
      op === 0x40 ||
      op === 0x41 ||
      (op >= 0x50 && op <= 0x53);
    if (!known) return end(5); // unknown opcode
    if (pc + imm >= n) return end(9); // immediate cut off by the program's end
    steps++;
    const next = pc + 1 + imm;
    pc = next;

    // Binary arithmetic / comparison / logic: pops two, pushes one.
    if (op >= 0x10 && op <= 0x22 && op !== 0x17 && op !== 0x1b) {
      if (sp < 2) return end(2);
      const b = D[sp - 1];
      const a = D[sp - 2];
      let r: number;
      if (op === 0x10) r = (a + b) | 0;
      else if (op === 0x11) r = (a - b) | 0;
      else if (op === 0x12) r = Math.imul(a, b);
      else if (op === 0x13) {
        if (b === 0) return end(4);
        r = a === -2147483648 && b === -1 ? a : (a / b) | 0;
      } else if (op === 0x14) {
        if (b === 0) return end(4);
        r = b === -1 ? 0 : (a % b) | 0;
      } else if (op === 0x15) {
        if (b === 0) return end(4);
        r = Math.floor((a >>> 0) / (b >>> 0)) | 0;
      } else if (op === 0x16) {
        if (b === 0) return end(4);
        r = ((a >>> 0) % (b >>> 0)) | 0;
      } else if (op === 0x18) r = a & b;
      else if (op === 0x19) r = a | b;
      else if (op === 0x1a) r = a ^ b;
      else if (op === 0x1c) r = a << (b & 31);
      else if (op === 0x1d) r = a >> (b & 31);
      else if (op === 0x1e) r = (a >>> (b & 31)) | 0;
      else if (op === 0x20) r = a === b ? 1 : 0;
      else if (op === 0x21) r = a < b ? 1 : 0;
      else r = a >>> 0 < (b >>> 0) ? 1 : 0; // LTU
      D[sp - 2] = r;
      sp--;
      continue;
    }

    switch (op) {
      case 0x00: // HALT
        return end(0);
      case 0x01: // PUSH8, sign-extended
        if (sp + 1 > 256) return end(3);
        D[sp++] = (p[next - 1] << 24) >> 24;
        break;
      case 0x02: // PUSH32, little-endian
        if (sp + 1 > 256) return end(3);
        D[sp++] = p[next - 4] | (p[next - 3] << 8) | (p[next - 2] << 16) | (p[next - 1] << 24);
        break;
      case 0x03: // POP
        if (sp < 1) return end(2);
        sp--;
        break;
      case 0x04: // DUP
        if (sp < 1) return end(2);
        if (sp + 1 > 256) return end(3);
        D[sp] = D[sp - 1];
        sp++;
        break;
      case 0x05: // SWAP
        if (sp < 2) return end(2);
        {
          const t = D[sp - 1];
          D[sp - 1] = D[sp - 2];
          D[sp - 2] = t;
        }
        break;
      case 0x06: // OVER
        if (sp < 2) return end(2);
        if (sp + 1 > 256) return end(3);
        D[sp] = D[sp - 2];
        sp++;
        break;
      case 0x07: // ROT
        if (sp < 3) return end(2);
        {
          const a = D[sp - 3];
          D[sp - 3] = D[sp - 2];
          D[sp - 2] = D[sp - 1];
          D[sp - 1] = a;
        }
        break;
      case 0x17: // NEG (wraps: -(-2147483648) is -2147483648)
        if (sp < 1) return end(2);
        D[sp - 1] = -D[sp - 1] | 0;
        break;
      case 0x1b: // NOT
        if (sp < 1) return end(2);
        D[sp - 1] = ~D[sp - 1];
        break;
      case 0x30: // JMP: 2-byte signed offset from the next instruction
      case 0x31: // JZ
      case 0x32: {
        // JNZ
        const rel = ((p[next - 2] | (p[next - 1] << 8)) << 16) >> 16;
        let take = true;
        if (op !== 0x30) {
          if (sp < 1) return end(2);
          const v = D[--sp];
          take = op === 0x31 ? v === 0 : v !== 0;
        }
        if (take) pc = next + rel;
        break;
      }
      case 0x33: // CALL: 2-byte unsigned target
        if (cp === 64) return end(7);
        C[cp++] = next;
        pc = p[next - 2] | (p[next - 1] << 8);
        break;
      case 0x34: // RET
        if (cp === 0) return end(8);
        pc = C[--cp];
        break;
      case 0x40: // LOAD
        if (sp < 1) return end(2);
        {
          const addr = D[sp - 1];
          if (addr < 0 || addr >= 256) return end(6);
          D[sp - 1] = M[addr];
        }
        break;
      case 0x41: // STORE: ( v addr -- ), the top of stack is the address
        if (sp < 2) return end(2);
        {
          const addr = D[sp - 1];
          const v = D[sp - 2];
          if (addr < 0 || addr >= 256) return end(6);
          sp -= 2;
          M[addr] = v;
        }
        break;
      case 0x50: {
        // PRINT: decimal ASCII, no padding, no newline
        if (sp < 1) return end(2);
        const s = String(D[sp - 1]);
        if (olen + s.length > OUTPUT_MAX) return end(11);
        sp--;
        for (let i = 0; i < s.length; i++) out[olen++] = s.charCodeAt(i);
        break;
      }
      case 0x51: // PUTC: one byte, v AND 255
        if (sp < 1) return end(2);
        if (olen + 1 > OUTPUT_MAX) return end(11);
        out[olen++] = D[--sp] & 255;
        break;
      case 0x52: // IN: next input byte, -1 once the input is used up
        if (sp + 1 > 256) return end(3);
        D[sp++] = ip < inp.length ? inp[ip++] : -1;
        break;
      case 0x53: // EXIT: exit code is the low byte
        if (sp < 1) return end(2);
        return end(D[--sp] & 255);
      default:
        return end(5);
    }
  }
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const r = run(
    new Uint8Array(readFileSync(join(I, id, 'program.bin'))),
    new Uint8Array(readFileSync(join(I, id, 'input.bin'))),
  );
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'stdout.bin'), r.out);
  writeFileSync(join(O, id, 'exit.txt'), `${r.code}\n`);
}

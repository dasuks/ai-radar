import { randomBytes } from "node:crypto";
import type { RandomSource } from "../../ports/system/index.js";

export class NodeRandom implements RandomSource {
  bytes(n: number): Uint8Array {
    return randomBytes(n);
  }
}

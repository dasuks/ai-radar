import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** All Discord entrypoints share a lock so the durable delivery journal has one writer. */
export async function withDiscordLock<T>(storeDir: string, action: () => Promise<T>): Promise<T> {
  mkdirSync(storeDir, { recursive: true });
  const path = join(storeDir, "discord-send.lock");
  let fd: number;
  try { fd = openSync(path, "wx"); }
  catch { throw new Error("Discord delivery lock exists or cannot be created. Inspect discord-send.lock; remove a stale lock only after verifying no delivery is running."); }
  try { writeFileSync(fd, String(process.pid)); }
  finally { closeSync(fd); }
  try { return await action(); }
  finally { unlinkSync(path); }
}

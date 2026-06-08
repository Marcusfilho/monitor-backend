// src/services/sessionStore.ts
// SESSION_STORE_V1 — sessões de técnico persistidas no SQLite
// Mesmo padrão do snapshotStore.ts — openDb() por operação, fecha sempre no finally.

let Database: any = null;
try { Database = require("better-sqlite3"); } catch { /* fallback: só memória */ }
import path from "path";

const DB_PATH =
  (process.env.SQLITE_DB_PATH || "").trim() ||
  path.join(process.cwd(), "data", "monitor.db");

export interface SessionEntry {
  clients:   any[];
  username:  string;
  expiresAt: number;
}

// ─── init ────────────────────────────────────────────────────────────────────

export function initSessionTable(): void {
  if (!Database) return;
  const db = new Database(DB_PATH);
  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        username   TEXT NOT NULL,
        clients    TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `).run();
  } finally {
    db.close();
  }
}

// ─── operações ───────────────────────────────────────────────────────────────

export function setSession(token: string, entry: SessionEntry): void {
  if (!Database) return;
  const db = new Database(DB_PATH);
  try {
    db.prepare(`
      INSERT OR REPLACE INTO sessions (token, username, clients, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(token, entry.username, JSON.stringify(entry.clients), entry.expiresAt);
  } finally {
    db.close();
  }
}

export function getSession(token: string): SessionEntry | null {
  if (!Database) return null;
  const db = new Database(DB_PATH);
  try {
    const row = db.prepare(
      `SELECT username, clients, expires_at FROM sessions WHERE token = ?`
    ).get(token) as any;
    if (!row) return null;
    return {
      username:  row.username,
      clients:   JSON.parse(row.clients),
      expiresAt: row.expires_at,
    };
  } finally {
    db.close();
  }
}

export function deleteSession(token: string): void {
  if (!Database) return;
  const db = new Database(DB_PATH);
  try {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
  } finally {
    db.close();
  }
}

export function purgeExpiredSessions(): void {
  if (!Database) return;
  const db = new Database(DB_PATH);
  try {
    const { changes } = db.prepare(
      `DELETE FROM sessions WHERE expires_at < ?`
    ).run(Date.now());
    if (changes > 0) console.log(`[sessionStore] ${changes} sessões expiradas removidas`);
  } finally {
    db.close();
  }
}

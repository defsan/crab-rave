import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type DB = InstanceType<typeof Database>;

const INDEXABLE_EXTS = new Set([
  ".md", ".txt", ".ts", ".js", ".json",
  ".py", ".sh", ".yaml", ".yml", ".toml", ".csv",
]);
const ALWAYS_SKIP = new Set([
  "node_modules", ".git", "dist", ".next",
  "__pycache__", ".cache", "tool_calls",
]);

export interface SearchResult {
  source: string;
  content: string;
  score: number;
}

function expandPath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export class MemoryDb {
  private db: DB;
  private workfolder: string;
  private indexed = false;

  constructor(workfolder: string) {
    this.workfolder = path.resolve(expandPath(workfolder));
    mkdirSync(this.workfolder, { recursive: true });
    const dbPath = path.join(this.workfolder, ".memory.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        source  TEXT    NOT NULL,
        content TEXT    NOT NULL,
        tags    TEXT    NOT NULL DEFAULT '',
        created INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        tags,
        content=memories,
        content_rowid=id
      );

      CREATE TABLE IF NOT EXISTS file_hashes (
        path       TEXT    PRIMARY KEY,
        hash       TEXT    NOT NULL,
        indexed_at INTEGER NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags)
        VALUES (new.id, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.id, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.id, old.content, old.tags);
        INSERT INTO memories_fts(rowid, content, tags)
        VALUES (new.id, new.content, new.tags);
      END;
    `);
  }

  insert(source: string, content: string, tags = ""): void {
    this.db
      .prepare("INSERT INTO memories (source, content, tags, created) VALUES (?, ?, ?, ?)")
      .run(source, content.trim(), tags.trim(), Date.now());
  }

  search(query: string, limit = 5): SearchResult[] {
    // Sanitize for FTS5 — strip chars that have special meaning in FTS5 syntax
    const sanitized = query.replace(/["'*()[\]{}\^~:|]/g, " ").trim();
    if (!sanitized) return [];

    try {
      return this.db
        .prepare(`
          SELECT m.source, m.content, bm25(memories_fts) AS score
          FROM memories_fts
          JOIN memories m ON m.id = memories_fts.rowid
          WHERE memories_fts MATCH ?
          ORDER BY bm25(memories_fts)
          LIMIT ?
        `)
        .all(sanitized, limit) as SearchResult[];
    } catch {
      // Malformed FTS5 query — return empty rather than crash
      return [];
    }
  }

  indexFile(filePath: string): number {
    const relPath = path.relative(this.workfolder, filePath);

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return 0;
    }

    if (raw.includes("\0")) return 0; // binary file

    const hash = createHash("sha256").update(raw).digest("hex");
    const existing = this.db
      .prepare("SELECT hash FROM file_hashes WHERE path = ?")
      .get(relPath) as { hash: string } | undefined;

    if (existing?.hash === hash) return 0; // unchanged, skip

    // Remove stale chunks for this file
    this.db.prepare("DELETE FROM memories WHERE source = ?").run(relPath);

    const chunks = this.chunkContent(raw);
    const stmt = this.db.prepare(
      "INSERT INTO memories (source, content, tags, created) VALUES (?, ?, ?, ?)",
    );
    const insertAll = this.db.transaction((chunks: string[]) => {
      const now = Date.now();
      for (const chunk of chunks) stmt.run(relPath, chunk, "", now);
    });
    insertAll(chunks);

    this.db
      .prepare("INSERT OR REPLACE INTO file_hashes (path, hash, indexed_at) VALUES (?, ?, ?)")
      .run(relPath, hash, Date.now());

    return chunks.length;
  }

  private chunkContent(content: string): string[] {
    // Split at markdown headings first, then by paragraph if sections are too long
    const MAX_CHUNK = 2000;
    const sections = content
      .split(/(?=^#{1,3} )/m)
      .map((s) => s.trim())
      .filter((s) => s.length >= 20);

    if (sections.length === 0) {
      return content.trim().length >= 20 ? [content.trim().slice(0, MAX_CHUNK)] : [];
    }

    const chunks: string[] = [];
    for (const section of sections) {
      if (section.length <= MAX_CHUNK) {
        chunks.push(section);
        continue;
      }
      // Long section: split by blank lines
      const paras = section.split(/\n\n+/);
      let buf = "";
      for (const para of paras) {
        if (buf && (buf + "\n\n" + para).length > MAX_CHUNK) {
          if (buf.trim()) chunks.push(buf.trim());
          buf = para;
        } else {
          buf = buf ? buf + "\n\n" + para : para;
        }
      }
      if (buf.trim()) chunks.push(buf.trim());
    }
    return chunks;
  }

  indexDirectory(maxFiles = 300): number {
    let total = 0;

    const walk = (dir: string): void => {
      if (total >= maxFiles) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (ALWAYS_SKIP.has(entry) || entry === ".memory.db") continue;
        const full = path.join(dir, entry);
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            walk(full);
          } else if (INDEXABLE_EXTS.has(path.extname(entry).toLowerCase())) {
            total += this.indexFile(full);
          }
        } catch {
          // skip unreadable entries
        }
      }
    };

    walk(this.workfolder);
    return total;
  }

  /** Run indexDirectory once per process lifetime (hash check makes it cheap). */
  ensureIndexed(): void {
    if (!this.indexed) {
      this.indexDirectory();
      this.indexed = true;
    }
  }

  close(): void {
    this.db.close();
  }
}

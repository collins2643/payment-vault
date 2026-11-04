import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type AuditEvent = {
  version: 1;
  type: "request.started" | "request.completed" | "request.closed"
    | "settlement.attempted" | "settlement.succeeded" | "settlement.unconfirmed";
  at: string;
  requestId: string;
  attemptId?: string;
  method: string;
  route: string;
  network: string;
  deploymentId?: string;
  serviceId?: string;
  environmentId?: string;
  ingress?: "loopback" | "network";
  phase?: string;
  amount?: string;
  asset?: string;
  payTo?: string;
  transaction?: string;
  payer?: string;
  status?: number;
  durationMs?: number;
};

function inside(parent: string, child: string) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Railway must use an actual mounted volume, not an ephemeral look-alike path. */
export function auditPath(env: NodeJS.ProcessEnv = process.env): string {
  const railway = Boolean(env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_DEPLOYMENT_ID);
  if ((railway || env.NODE_ENV === "production") && !env.AUDIT_DB_PATH) {
    throw new Error("AUDIT_DB_PATH is required in production");
  }
  const path = env.AUDIT_DB_PATH ?? resolve(".audit/payment-audit.sqlite");
  if (!isAbsolute(path)) throw new Error("AUDIT_DB_PATH must be an absolute filesystem path");
  if (railway) {
    const mount = env.RAILWAY_VOLUME_MOUNT_PATH;
    if (!mount || !isAbsolute(mount) || !existsSync(mount) || !inside(resolve(mount), resolve(path))) {
      throw new Error("AUDIT_DB_PATH must be inside an attached Railway volume");
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!inside(realpathSync(mount), resolve(realpathSync(dirname(path)), path.split(sep).at(-1)!))) {
      throw new Error("Audit path escapes the Railway volume through a symlink");
    }
  }
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error("Audit database must not be a symlink");
  }
  return path;
}

/** Append-only application interface; administrators with filesystem access can still edit it. */
export class AuditStore {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        transaction_hash TEXT,
        event_type TEXT NOT NULL,
        event_json TEXT NOT NULL CHECK(json_valid(event_json))
      );
      CREATE INDEX IF NOT EXISTS audit_request ON audit_events(request_id);
      CREATE INDEX IF NOT EXISTS audit_transaction ON audit_events(transaction_hash);
      PRAGMA user_version = 1;
    `);
  }
  append(event: AuditEvent) {
    this.db.prepare(
      "INSERT INTO audit_events (request_id, transaction_hash, event_type, event_json) VALUES (?, ?, ?, ?)",
    ).run(event.requestId, event.transaction ?? null, event.type, JSON.stringify(event));
  }
  close() { this.db.close(); }
}

/** Opens an existing database read-only. A transaction filter returns the whole request lifecycle. */
export function readAudit(path: string, filter: { requestId?: string; transaction?: string } = {}) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    let sql = "SELECT id, event_json FROM audit_events";
    const values: string[] = [];
    if (filter.requestId) {
      sql += " WHERE request_id = ?";
      values.push(filter.requestId);
    } else if (filter.transaction) {
      sql += " WHERE request_id IN (SELECT request_id FROM audit_events WHERE transaction_hash = ?)";
      values.push(filter.transaction);
    }
    sql += " ORDER BY id";
    return db.prepare(sql).all(...values).map(row => ({
      sequence: Number(row.id), ...JSON.parse(String(row.event_json)) as AuditEvent,
    }));
  } finally { db.close(); }
}

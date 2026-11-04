import { resolve } from "node:path";
import { readAudit } from "./audit-store.ts";

const args = process.argv.slice(2);
try {
  if (args.length && (args.length !== 2 || !["--request-id", "--tx"].includes(args[0]))) {
    throw new Error("Usage: npm run audit:export -- [--request-id UUID | --tx HASH]");
  }
  if (args[0] === "--request-id" && !/^[a-f0-9-]{36}$/i.test(args[1])) {
    throw new Error("Invalid request ID");
  }
  if (args[0] === "--tx" && !/^[a-f0-9]{64}$/i.test(args[1])) {
    throw new Error("Invalid Stellar transaction hash");
  }
  const rows = readAudit(process.env.AUDIT_DB_PATH ?? resolve(".audit/payment-audit.sqlite"), {
    requestId: args[0] === "--request-id" ? args[1] : undefined,
    transaction: args[0] === "--tx" ? args[1].toLowerCase() : undefined,
  });
  for (const row of rows) console.log(JSON.stringify(row));
} catch {
  console.error("Audit export failed. Check arguments, the database path, and file permissions.");
  process.exitCode = 1;
}

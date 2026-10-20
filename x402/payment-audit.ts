import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import type { x402ResourceServer } from "@x402/core/server";
import { AuditStore, type AuditEvent } from "./audit-store.ts";

type Options = {
  network: string;
  deploymentId?: string;
  serviceId?: string;
  environmentId?: string;
  // Static server-owned route names only. Never record an arbitrary URL or query string.
  routes?: readonly string[];
  onWriteFailure?: (record: { type: string; requestId: string | null; transaction: string | null }) => void;
};
type State = { base: Omit<AuditEvent, "type" | "at">; started: number; attemptId?: string };
const address = (value: unknown) =>
  typeof value === "string" && /^[GC][A-Z2-7]{55}$/.test(value) ? value : undefined;
const amount = (value: unknown) =>
  typeof value === "string" && /^\d{1,40}$/.test(value) ? value : undefined;
const hash = (value: unknown) =>
  typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value) ? value.toLowerCase() : undefined;
const id = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value) ? value : undefined;

export function createPaymentAudit(store: Pick<AuditStore, "append">, options: Options) {
  const context = new AsyncLocalStorage<State>();
  const routes = options.routes ?? ["GET /weather"];
  let healthy = true;
  const report = options.onWriteFailure ?? ((record) => console.error(JSON.stringify(record)));
  function fail(state?: State, transaction?: string) {
    healthy = false;
    // Deliberately exclude exception messages, headers, payloads, and configuration.
    try { report({ type: "audit_write_failed", requestId: state?.base.requestId ?? null, transaction: transaction ?? null }); }
    catch { /* Do not turn a logging failure into an unhandled response-listener exception. */ }
  }
  function append(state: State, type: AuditEvent["type"], data: Partial<AuditEvent> = {}) {
    store.append({ ...state.base, ...data, type, at: new Date().toISOString() });
  }
  const middleware: RequestHandler = (req, res, next) => {
    // Express/x402 route matching is case-insensitive and accepts trailing slashes.
    const route = req.path.toLowerCase().replace(/\/+$/, "") || "/";
    if (!routes.includes(`${req.method} ${route}`)) return next();
    const state: State = {
      base: {
        version: 1, requestId: randomUUID(), method: req.method, route,
        network: options.network,
        deploymentId: id(options.deploymentId),
        serviceId: id(options.serviceId),
        environmentId: id(options.environmentId),
        ingress: ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")
          ? "loopback" : "network",
      },
      started: performance.now(),
    };
    res.setHeader("X-Request-ID", state.base.requestId);
    if (!healthy) { res.status(503).json({ error: "Payment audit unavailable" }); return; }
    try { append(state, "request.started"); }
    catch { fail(state); res.status(503).json({ error: "Payment audit unavailable" }); return; }
    let finished = false;
    const complete = (type: "request.completed" | "request.closed") => {
      if (finished) return;
      finished = true;
      try {
        append(state, type, {
          status: type === "request.completed" ? res.statusCode : undefined,
          durationMs: Math.round(performance.now() - state.started),
        });
      } catch { fail(state); }
    };
    res.once("finish", () => complete("request.completed"));
    res.once("close", () => complete("request.closed"));
    context.run(state, next);
  };
  function attach(server: x402ResourceServer) {
    server.onBeforeSettle(async ({ requirements, phase }) => {
      const state = context.getStore();
      if (!state || !healthy) return { abort: true, reason: "audit_unavailable" };
      state.attemptId = randomUUID();
      try {
        append(state, "settlement.attempted", {
          attemptId: state.attemptId, phase,
          amount: amount(requirements.amount), asset: address(requirements.asset),
          payTo: address(requirements.payTo),
        });
      } catch {
        fail(state);
        // x402 swallows ordinary hook exceptions. Return its explicit abort directive.
        return { abort: true, reason: "audit_unavailable" };
      }
    });
    server.onAfterSettle(async ({ result, requirements, phase }) => {
      if (!result.success) return;
      const state = context.getStore();
      const transaction = hash(result.transaction);
      if (!state || !state.attemptId || !transaction) { fail(state, transaction); return; }
      try {
        append(state, "settlement.succeeded", {
          attemptId: state.attemptId, phase, transaction,
          amount: amount(result.amount ?? requirements.amount),
          asset: address(requirements.asset), payTo: address(requirements.payTo),
          payer: address(result.payer),
        });
      } catch {
        // Settlement may already be final. Never retry it merely because storage failed.
        fail(state, transaction);
      }
    });
    server.onSettleFailure(async ({ phase }) => {
      const state = context.getStore();
      if (!state) { fail(); return; }
      try {
        // A timeout can mean the remote payment succeeded. Do not label it "not paid".
        append(state, "settlement.unconfirmed", { attemptId: state.attemptId, phase });
      } catch { fail(state); }
    });
    return server;
  }
  return { middleware, attach, isHealthy: () => healthy };
}

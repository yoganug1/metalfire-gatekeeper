import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBody, verifySignature } from "./hmac.js";
import { SeenStore } from "./seenStore.js";
import { decideGatekeeper } from "./gatekeeper.js";
import { proveDecision } from "./prover.js";
import { verifyIncomingProof } from "./verify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET = process.env.AGENT_GAMES_HMAC_SECRET;
if (!SECRET) { console.error("AGENT_GAMES_HMAC_SECRET is required"); process.exit(1); }

const WASM = process.env.GATEKEEPER_WASM || path.join(__dirname, "..", "circuits", "gatekeeper.wasm");
const ZKEY = process.env.GATEKEEPER_ZKEY || path.join(__dirname, "..", "circuits", "gatekeeper_final.zkey");
const seen = new SeenStore(process.env.SEEN_STORE || path.join(__dirname, "..", "data", "seen.json"));
const MAX_SKEW_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;

// Per-task in-flight lock: a second delivery of the same task_id waits for the
// first response instead of proving twice before the seen-set is persisted.
const pending = new Map(); // task_id -> Promise<void>

function sendSigned(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "x-agent-games-signature": signBody(SECRET, body) });
  res.end(body);
}

async function handleGatekeeper(envelope, res) {
  const { task_id: taskId, issued_at: issuedAt, deadline_at: deadlineAt, input } = envelope;
  if (!taskId || !input) return sendSigned(res, 400, { error: "malformed envelope" });

  if (pending.has(taskId)) await pending.get(taskId).catch(() => {});

  // Idempotent replay: same task_id returns the stored response.
  const prior = seen.getTask(taskId);
  if (prior) {
    res.writeHead(200, { "content-type": "application/json", "x-agent-games-signature": signBody(SECRET, prior) });
    return res.end(prior);
  }

  // Timestamp sanity: reject stale tasks and tasks past their deadline.
  const now = Date.now();
  if (issuedAt && now - Date.parse(issuedAt) > MAX_SKEW_MS) {
    return runDecision(res, taskId, input, { decision: "REJECT", reason_code: "STALE_TASK" });
  }
  if (deadlineAt && now > Date.parse(deadlineAt)) {
    return runDecision(res, taskId, input, { decision: "REJECT", reason_code: "DEADLINE_PASSED" });
  }

  const proofVerified = await verifyIncomingProof(input.proof_tx);

  // Synchronous decide + mark: no await between the proof-reuse check and
  // recording the proof, so concurrent different-task requests carrying the
  // same proof_tx cannot both approve.
  const verdict = decideGatekeeper(input, seen, { proofVerified });
  if (verdict.decision === "APPROVE") seen.addProof(input.proof_tx);
  await runDecision(res, taskId, input, verdict);
}

async function runDecision(res, taskId, input, initialVerdict) {
  const work = (async () => {
    let verdict = initialVerdict;
    let proofBundle = {};
    try {
      proofBundle = await proveDecision({ wasmPath: WASM, zkeyPath: ZKEY, taskInput: { ...input, _taskIdNumeric: numericTaskId(taskId) }, decision: verdict.decision });
    } catch (e) {
      if (verdict.decision === "APPROVE") {
        // Fail closed: an APPROVE without its proof is never emitted. Downgrade
        // to REJECT and roll back the seen-mark so a retry can be reconsidered.
        console.warn("proving failed for APPROVE, downgrading to REJECT:", e.message);
        seen.removeProof(input.proof_tx);
        verdict = { decision: "REJECT", reason_code: "PROOF_FAILED" };
      } else {
        // The circuit is the referee: it refuses to prove a decision its own rule
        // evaluation disagrees with (e.g. PROOF_REUSED, which only the agent can
        // see). Omit the proof in that case (-2) rather than misreport or approve.
        console.warn("proof generation failed:", e.message);
      }
    }
    const body = JSON.stringify({
      decision: verdict.decision,
      reason_code: verdict.reason_code,
      proof: proofBundle.proof,
      public_signals: proofBundle.publicSignals,
      proof_tx: input.proof_tx,
    });
    seen.setTask(taskId, body);
    res.writeHead(200, { "content-type": "application/json", "x-agent-games-signature": signBody(SECRET, body) });
    res.end(body);
  })();
  pending.set(taskId, work);
  try { await work; } finally { pending.delete(taskId); }
}

function numericTaskId(taskId) {
  // Circuit takes a numeric taskId; hash the string id into a 31-bit field-safe value.
  let h = 0;
  for (const c of String(taskId)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % (2 ** 31);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return sendSigned(res, 200, { ok: true });
  if (req.method !== "POST") return sendSigned(res, 405, { error: "method not allowed" });

  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) { tooBig = true; req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", async () => {
    if (tooBig) return; // connection destroyed with the oversized request
    const raw = Buffer.concat(chunks);
    if (!verifySignature(SECRET, raw, req.headers["x-agent-games-signature"])) {
      return sendSigned(res, 401, { error: "bad signature" });
    }
    let envelope;
    try { envelope = JSON.parse(raw.toString("utf8")); } catch { return sendSigned(res, 400, { error: "bad json" }); }

    try {
      switch (envelope.type) {
        case "agent-games.preflight.v1":
          return sendSigned(res, 200, { ok: true, protocolVersion: "v1" });
        case "agent-games.proof-gatekeeper.v1":
          return await handleGatekeeper(envelope, res);
        default:
          return sendSigned(res, 400, { error: "unknown task type" });
      }
    } catch (e) {
      return sendSigned(res, 200, { decision: "REJECT", reason_code: "INTERNAL_FAIL_CLOSED" });
    }
  });
  req.on("error", () => {});
});

const port = Number(process.env.PORT || 8080);
server.listen(port, () => console.log(`agent listening on :${port}`));

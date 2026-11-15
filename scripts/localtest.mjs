import { spawn } from "node:child_process";
import crypto from "node:crypto";

const SECRET = "localtest-secret";
const PORT = 8123;
// Server A: normal config. AGENT_GAMES_ASSUME_PROOF_VERIFIED stubs the incoming-
// proof chain lookup, which is still unimplemented (see src/verify.js).
const child = spawn("node", ["src/server.js"], { env: { ...process.env, AGENT_GAMES_HMAC_SECRET: SECRET, PORT: String(PORT), SEEN_STORE: "./data/test-seen.json", AGENT_GAMES_ASSUME_PROOF_VERIFIED: "true" }, stdio: "inherit" });
// Server B: no verification stub -> incoming-proof gate must fail closed.
const childB = spawn("node", ["src/server.js"], { env: { ...process.env, AGENT_GAMES_HMAC_SECRET: SECRET, PORT: String(PORT + 1), SEEN_STORE: "./data/test-seen-b.json" }, stdio: "inherit" });
// Server C: verification stubbed but broken prover (bad wasm path).
const childC = spawn("node", ["src/server.js"], { env: { ...process.env, AGENT_GAMES_HMAC_SECRET: SECRET, PORT: String(PORT + 2), SEEN_STORE: "./data/test-seen-c.json", AGENT_GAMES_ASSUME_PROOF_VERIFIED: "true", GATEKEEPER_WASM: "/nonexistent/gatekeeper.wasm" }, stdio: "inherit" });
await new Promise((r) => setTimeout(r, 1200));

function signedPost(body, port = PORT) {
  const raw = JSON.stringify(body);
  return fetch(`http://127.0.0.1:${port}/agent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-games-signature": crypto.createHmac("sha256", SECRET).update(raw).digest("hex") },
    body: raw,
  }).then((r) => r.json());
}

const validInput = {
  registered_vk: "0x6b79", proof_vk: "0x6b79",
  minimum: "1000", public_balance: "1460",
  expiry_block: 8430000, current_block: 8420000,
  recipient: "0xDe42", condition_recipient: "0xDe42",
  amount: "500", max_transfer: "1000",
  proof_tx: "0xa1",
};
const nowIso = new Date().toISOString();
const env = (id, input, type = "agent-games.proof-gatekeeper.v1") => ({ type, task_id: id, mode: "practice", issued_at: nowIso, deadline_at: new Date(Date.now() + 55000).toISOString(), input });

let pass = 0, failT = 0;
const check = (name, cond) => { cond ? pass++ : failT++; console.log(cond ? "PASS" : "FAIL", name); };

// 1. preflight
let r = await signedPost({ type: "agent-games.preflight.v1", agent_id: "agt_x", issued_at: nowIso, nonce: "abc" });
check("preflight ok", r.ok === true && r.protocolVersion === "v1");

// 2. valid request -> APPROVE with proof
r = await signedPost(env("t_valid", validInput));
check("valid -> APPROVE", r.decision === "APPROVE");
check("approve reason_code VALID_CONDITION", r.reason_code === "VALID_CONDITION");
check("approve carries proof", !!r.proof && Array.isArray(r.public_signals) && r.public_signals.length === 13);

// 3. replay same task -> identical idempotent response
const r2 = await signedPost(env("t_valid", validInput));
check("idempotent replay", JSON.stringify(r2) === JSON.stringify(r));

// 3b. concurrent duplicate deliveries of the SAME task: both must return the
// identical stored response (one proof generated, not two divergent ones).
const [c1, c2] = await Promise.all([signedPost(env("t_conc", { ...validInput, proof_tx: "0xcc" })), signedPost(env("t_conc", { ...validInput, proof_tx: "0xcc" }))]);
check("concurrent duplicate -> identical", JSON.stringify(c1) === JSON.stringify(c2));
check("concurrent duplicate decided", c1.decision === "APPROVE" || c1.decision === "REJECT");

// 3c. concurrent DIFFERENT tasks carrying the same proof_tx: at most one may approve.
const [p1, p2] = await Promise.all([signedPost(env("t_pa", { ...validInput, proof_tx: "0xpp" })), signedPost(env("t_pb", { ...validInput, proof_tx: "0xpp" }))]);
check("same proof concurrent -> single approve", (p1.decision === "APPROVE" ? 1 : 0) + (p2.decision === "APPROVE" ? 1 : 0) === 1);

// 3d. stale issued_at -> REJECT STALE_TASK (regression: crashed on undefined var)
r = await signedPost({ ...env("t_stale", { ...validInput, proof_tx: "0xs1" }), issued_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
check("stale task -> REJECT STALE_TASK", r.decision === "REJECT" && r.reason_code === "STALE_TASK");

// 3e. past deadline -> REJECT DEADLINE_PASSED
r = await signedPost({ ...env("t_late", { ...validInput, proof_tx: "0xs2" }), deadline_at: new Date(Date.now() - 1000).toISOString() });
check("past deadline -> REJECT DEADLINE_PASSED", r.decision === "REJECT" && r.reason_code === "DEADLINE_PASSED");

// 3f. oversized body: connection is cut, never reaches the handler.
const big = JSON.stringify(env("t_big", validInput)).padEnd(300 * 1024, " ");
const bigRes = await fetch(`http://127.0.0.1:${PORT}/agent`, { method: "POST", headers: { "content-type": "application/json", "x-agent-games-signature": "x".repeat(64) }, body: big }).catch((e) => e);
check("oversized body rejected", bigRes instanceof Error || bigRes.status >= 400);

// 4-8. traps
r = await signedPost(env("t_vk", { ...validInput, proof_vk: "0xdead" }));
check("VK substitution -> REJECT", r.decision === "REJECT" && r.reason_code === "VK_SUBSTITUTION");
r = await signedPost(env("t_bal", { ...validInput, public_balance: "900", proof_tx: "0xa2" }));
check("low balance -> REJECT", r.decision === "REJECT" && r.reason_code === "THRESHOLD_MISMATCH");
r = await signedPost(env("t_recip", { ...validInput, recipient: "0xbeef", proof_tx: "0xa3" }));
check("recipient mismatch -> REJECT", r.decision === "REJECT" && r.reason_code === "RECIPIENT_MISMATCH");
r = await signedPost(env("t_amt", { ...validInput, amount: "1500", proof_tx: "0xa4" }));
check("amount over max -> REJECT", r.decision === "REJECT" && r.reason_code === "AMOUNT_OVERFLOW");
r = await signedPost(env("t_exp", { ...validInput, current_block: 8430001, proof_tx: "0xa5" }));
check("expired -> REJECT", r.decision === "REJECT" && r.reason_code === "EXPIRED_CONDITION");

// 9. proof reuse (0xa1 was approved above)
r = await signedPost(env("t_reuse", validInput));
check("proof reuse -> REJECT", r.decision === "REJECT" && r.reason_code === "PROOF_REUSED");

// 10. unsigned request rejected
const raw = JSON.stringify(env("t_unsigned", validInput));
const bad = await fetch(`http://127.0.0.1:${PORT}/agent`, { method: "POST", headers: { "content-type": "application/json", "x-agent-games-signature": "deadbeef" }, body: raw });
check("bad signature -> 401", bad.status === 401);

// 11b. unverified incoming proof must never approve (server B, no stub).
// Field-valid request that would otherwise APPROVE:
r = await signedPost(env("t_unver", { ...validInput, proof_tx: "0xuv" }), PORT + 1);
check("unverified proof -> REJECT UNVERIFIED_PROOF", r.decision === "REJECT" && r.reason_code === "UNVERIFIED_PROOF");
check("unverified reject carries no false proof-approve", !r.proof || r.decision !== "APPROVE");

// 11c. prover failure on an APPROVE verdict must downgrade, never emit an
// unproven APPROVE (server C, bad wasm path).
r = await signedPost(env("t_noproof", { ...validInput, proof_tx: "0xnp" }), PORT + 2);
check("proving failure -> REJECT PROOF_FAILED", r.decision === "REJECT" && r.reason_code === "PROOF_FAILED");
check("proving failure emits no proof", !r.proof);

console.log(`\n${pass} passed, ${failT} failed`);
child.kill(); childB.kill(); childC.kill();
process.exit(failT ? 1 : 0);

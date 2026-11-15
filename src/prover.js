import * as snarkjs from "snarkjs";
import crypto from "node:crypto";

// Generates the agent's own Groth16 proof that its decision followed the rule.
// Circuit inputs discovered from gatekeeper.wasm (13 signals).
export async function proveDecision({ wasmPath, zkeyPath, taskInput, decision }) {
  const salt = crypto.randomInt(0, 2 ** 31); // per-response random salt
  const input = {
    decision: decision === "APPROVE" ? "1" : "0", // encoding assumption: 1=APPROVE, 0=REJECT
    publicBalance: String(taskInput.public_balance),
    minimum: String(taskInput.minimum),
    recipient: String(taskInput.recipient),
    amount: String(taskInput.amount),
    expiryBlock: String(taskInput.expiry_block),
    currentBlock: String(taskInput.current_block),
    maxTransfer: String(taskInput.max_transfer),
    conditionRecipient: String(taskInput.condition_recipient),
    taskId: String(taskInput._taskIdNumeric ?? "0"),
    salt: String(salt),
    registeredVkHash: String(taskInput.registered_vk),
    proofVkHash: String(taskInput.proof_vk),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  return { proof, publicSignals };
}

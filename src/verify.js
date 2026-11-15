// Incoming-proof verification gate.
//
// The Proof Gatekeeper's job is to approve only when the task's incoming proof
// really exists and is finalized on zkVerify. The exact proof_tx reference
// format (tx hash / job id / aggregation id) is an open protocol question to be
// confirmed against the live platform in practice mode, and the intended lookup
// is a free read-only call against a public zkVerify RPC endpoint.
//
// Until that lookup is implemented and confirmed, this gate FAILS CLOSED: an
// unverified incoming proof is never approved.
export async function verifyIncomingProof(proofTx) {
  if (process.env.AGENT_GAMES_ASSUME_PROOF_VERIFIED === "true") {
    // Local test harness only. Never set on a deployed agent.
    return true;
  }
  if (!proofTx) return false;
  // TODO(practice): confirm the proof_tx format on the first real task, then
  // implement the read-only lookup against the public zkVerify RPC here.
  return false;
}

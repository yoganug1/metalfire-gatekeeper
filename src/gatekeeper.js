// Proof Gatekeeper deterministic decision logic. Fail closed: any mismatch or
// uncertainty is a REJECT, never an approve-by-default.
export function decideGatekeeper(input, seen, { proofVerified = false } = {}) {
  const checks = [];
  const fail = (code) => { checks.push(code); return null; };

  if (input.proof_vk !== input.registered_vk) return { decision: "REJECT", reason_code: "VK_SUBSTITUTION" };
  if (seen.hasProof(input.proof_tx)) return { decision: "REJECT", reason_code: "PROOF_REUSED" };
  if (BigInt(input.public_balance) < BigInt(input.minimum)) return { decision: "REJECT", reason_code: "THRESHOLD_MISMATCH" };
  if (String(input.recipient).toLowerCase() !== String(input.condition_recipient).toLowerCase())
    return { decision: "REJECT", reason_code: "RECIPIENT_MISMATCH" };
  if (BigInt(input.amount) > BigInt(input.max_transfer)) return { decision: "REJECT", reason_code: "AMOUNT_OVERFLOW" };
  if (BigInt(input.current_block) >= BigInt(input.expiry_block)) return { decision: "REJECT", reason_code: "EXPIRED_CONDITION" };

  // All deterministic fields pass, but a gatekeeper must not approve an
  // incoming proof it has not verified on chain. Fail closed until the
  // verification lookup is implemented and confirmed.
  if (!proofVerified) return { decision: "REJECT", reason_code: "UNVERIFIED_PROOF" };

  // APPROVE code: VALID_CONDITION was observed in a valid-approve example on
  // the live dashboard during registration (page content, not protocol
  // documentation). Unverified - confirm against a live practice task.
  return { decision: "APPROVE", reason_code: "VALID_CONDITION" };
}

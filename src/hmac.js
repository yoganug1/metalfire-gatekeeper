import crypto from "node:crypto";

export function signBody(secret, rawBody) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifySignature(secret, rawBody, headerValue) {
  if (!headerValue || typeof headerValue !== "string") return false;
  const expected = Buffer.from(signBody(secret, rawBody), "utf8");
  const got = Buffer.from(headerValue.replace(/^sha256=/, ""), "utf8");
  if (expected.length !== got.length) return false;
  return crypto.timingSafeEqual(expected, got);
}

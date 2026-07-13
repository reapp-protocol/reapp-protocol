const U32_MAX = 2n ** 32n - 1n;

/** Normalize a caller-bound operation sequence to the generated contract
 * binding's u32 representation. Parse through bigint first so no accepted
 * string or bigint can be rounded before the range check. */
export function normalizeExpectedPaymentSequence(value: string | number | bigint): number {
  let normalized: bigint;
  if (typeof value === "bigint") {
    normalized = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("expected payment sequence must be a safe non-negative integer");
    }
    normalized = BigInt(value);
  } else {
    if (!/^(?:0|[1-9]\d*)$/.test(value)) {
      throw new Error("expected payment sequence must be canonical unsigned decimal");
    }
    normalized = BigInt(value);
  }

  if (normalized < 0n || normalized > U32_MAX) {
    throw new Error("expected payment sequence is outside the contract u32 range");
  }
  return Number(normalized);
}

/** Bind one caller operation to exactly one current mandate sequence. */
export function resolveExpectedPaymentSequence(
  currentSequence: number,
  requestedSequence?: string | number | bigint,
): number {
  const current = normalizeExpectedPaymentSequence(currentSequence);
  const expected = requestedSequence === undefined
    ? current
    : normalizeExpectedPaymentSequence(requestedSequence);
  if (current !== expected) {
    throw new Error(
      `payment operation expected mandate sequence ${expected}, but current sequence is ${current}; refusing to create another transaction`,
    );
  }
  return expected;
}

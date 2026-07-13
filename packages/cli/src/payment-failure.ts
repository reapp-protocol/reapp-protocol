import { PaymentRejectedError } from "@reapp-sdk/core";

/** Only the SDK's typed, finalized contract rejection proves no payment landed. */
export function isFinalPaymentRejection(error: unknown): error is PaymentRejectedError {
  return error instanceof PaymentRejectedError;
}

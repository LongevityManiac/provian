/**
 * The fixed message a depositor signs to salt its hire escrow ids (never sent anywhere).
 *
 * Kept in its own zero-dependency module so the WalletConnect reserved-message guard
 * (`walletconnect/provianReserved.ts`) can refuse to let an external dApp obtain this
 * signature — leaking it would let a third party derive the depositor's salt and front-run
 * `createEscrow` — without importing the escrow funder. The derivation in
 * `HumanJobEscrowFunder.hireEscrowSalt` is unchanged: existing escrow ids depend on these
 * exact bytes, so this string must never change.
 */
export const HIRE_ESCROW_SALT_MESSAGE = 'Provian hire escrow id salt v1';

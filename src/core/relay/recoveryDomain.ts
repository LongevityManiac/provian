/**
 * The EIP-712 relay-recovery domain, struct and purpose — ONE definition for the app.
 *
 * `RelayAPIService.recoverCredentials` signs `RelayRecovery{user,timestamp,purpose}` under this
 * domain with the wallet key, and the relay (`provian-backend/src/routes/recovery-eip712.ts`,
 * `RECOVERY_DOMAIN` / `RECOVERY_TYPES` / `RECOVERY_PURPOSE`) reconstructs the SAME domain to
 * verify it at `POST /v1/users/recover`, which rotates the relay credentials. A signature over
 * this struct is therefore account-takeover material: the WalletConnect reserved-message guard
 * (`walletconnect/provianReserved.ts`) imports this module so an external dApp can never obtain
 * one. `provianReserved.test.ts` pins this module byte-for-byte to the relay's constants.
 *
 * Zero dependencies on purpose — the WalletConnect guard must not pull RelayAPIService in.
 */

export const RELAY_RECOVERY_DOMAIN = {
    name: 'Provian Relay Recovery',
    version: '1',
    // Base mainnet is the canonical recovery chain. The relay uses the same constant when
    // reconstructing the typed-data hash.
    chainId: 8453,
    // Foundation Gnosis Safe address used as a domain separator. It does not process the
    // message; it is a known Provian-controlled address that uniquely identifies the
    // recovery domain.
    verifyingContract: '0x94F3D06ca027dFD1e6cCaa1117b050E08D5EA936',
};

export const RELAY_RECOVERY_TYPES = {
    RelayRecovery: [
        { name: 'user', type: 'address' },
        { name: 'timestamp', type: 'uint256' },
        { name: 'purpose', type: 'string' },
    ],
};

export const RELAY_RECOVERY_PURPOSE = 'Recover Provian relay credentials';

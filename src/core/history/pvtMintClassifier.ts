/**
 * Pure, dependency-free classification of whether an incoming token transfer is
 * a PVT mint (an on-chain PVT earning). Kept in its own module — with no RN /
 * Expo imports — so it is unit-testable in isolation from the heavy
 * TransactionHistoryService dependency chain.
 */

/** The address a mint (token issuance) is emitted FROM. Lowercased. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * True when an incoming transfer is a PVT mint: issued FROM the zero address AND
 * carrying the pinned PVT9 contract address. Matching on the contract address
 * (not the 'PVT' symbol) makes this spoof-resistant — a look-alike token that
 * names itself "PVT" cannot masquerade as an earning.
 */
export function isPvtMintTransfer(params: {
    isReceived: boolean;
    from: string | undefined;
    contractAddress: string | undefined;
    pvtAddress: string;
}): boolean {
    const { isReceived, from, contractAddress, pvtAddress } = params;
    return (
        isReceived &&
        (from ?? '').toLowerCase() === ZERO_ADDRESS &&
        !!contractAddress &&
        contractAddress.toLowerCase() === pvtAddress.toLowerCase()
    );
}

/**
 * True when an incoming transfer is a migration receipt: sent FROM the migration
 * distributor AND carrying the pinned live PVT contract. Both bindings are by address,
 * so neither a look-alike token sent from the distributor nor a real PVT transfer from
 * anyone else can read as a migration receipt.
 */
export function isPvtMigrationReceipt(params: {
    isReceived: boolean;
    from: string | undefined;
    contractAddress: string | undefined;
    distributorAddress: string;
    pvtAddress: string;
}): boolean {
    const { isReceived, from, contractAddress, distributorAddress, pvtAddress } = params;
    return (
        isReceived &&
        (from ?? '').toLowerCase() === distributorAddress.toLowerCase() &&
        !!contractAddress &&
        contractAddress.toLowerCase() === pvtAddress.toLowerCase()
    );
}

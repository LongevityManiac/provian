declare module 'bn.js' {
    class BN {
        constructor(number: number | string | number[] | Buffer | BN, base?: number, endian?: string);
        toString(base?: number, length?: number): string;
        toNumber(): number;
        toJSON(): string;
        toArray(endian?: string, length?: number): number[];
        toBuffer(endian?: string, length?: number): Buffer;
        bitLength(): number;
        isZero(): boolean;
        isNeg(): boolean;
        neg(): BN;
        abs(): BN;
        add(b: BN): BN;
        sub(b: BN): BN;
        mul(b: BN): BN;
        div(b: BN): BN;
        mod(b: BN): BN;
        pow(b: BN): BN;
        eq(b: BN): boolean;
        gt(b: BN): boolean;
        gte(b: BN): boolean;
        lt(b: BN): boolean;
        lte(b: BN): boolean;
        cmp(b: BN): number;
        clone(): BN;
    }
    export = BN;
}

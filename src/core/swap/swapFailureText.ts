/**
 * The words a failed swap shows. The engines report the raw provider or ethers error (for logs);
 * a person sees what happened and what to do, never "INSUFFICIENT_FUNDS" or a stack of RPC text.
 */
export type SwapFailureKey =
    | 'swap.errorInsufficientGas'
    | 'swap.errorPriceMoved'
    | 'swap.errorNetwork'
    | 'swap.errorCancelled'
    | 'swap.errorGeneric';

export function swapFailureKey(raw: string | undefined | null): SwapFailureKey {
    const text = String(raw ?? '');
    if (/insufficient[ _]funds|insufficient balance for gas|exceeds balance/i.test(text)) return 'swap.errorInsufficientGas';
    if (/slippage|price impact|insufficient[ _]output|too little received|return amount is not enough|quote expired/i.test(text)) return 'swap.errorPriceMoved';
    if (/ACTION_REJECTED|user rejected|user denied|cancel/i.test(text)) return 'swap.errorCancelled';
    if (/NETWORK_ERROR|TIMEOUT|timed out|network request failed|fetch failed|ECONN|503|502/i.test(text)) return 'swap.errorNetwork';
    return 'swap.errorGeneric';
}

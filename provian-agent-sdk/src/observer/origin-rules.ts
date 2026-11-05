/** Local privacy-class mappings. These describe arguments, never minting claims. */
export type OriginClass = 'file' | 'url' | 'package' | 'repo' | 'host';
export interface OriginArgRule { tools: string[]; key: string; class: OriginClass }

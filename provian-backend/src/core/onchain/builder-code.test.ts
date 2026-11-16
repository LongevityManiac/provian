import { Interface, Transaction, Wallet } from 'ethers';
import {
  ATTRIBUTED_CANCELLATION_GAS, ERC8021_MARKER, attributableTarget, attributableTransfer, PROVIAN_BUILDER_CODE, attributionSuffix, builderCodeGas,
  carriesBuilderCode, isBaseChainId, isPlainTransferInput, matchesPlannedCall, parseAttribution,
  stripAttribution, withBuilderCode, withoutBuilderCode,
} from './builder-code';
import { CanonicalWallet } from './canonical-wallet';

// The worked example in Base's Builder Code documentation.
const DOC_CODE = 'bc_b7k3p9da';
const DOC_SUFFIX = '62635f62376b33703964610b0080218021802180218021802180218021';

const erc20 = new Interface(['function transfer(address to,uint256 amount)']);
const call = erc20.encodeFunctionData('transfer', ['0x' + '11'.repeat(20), 5n]);

describe('ERC-8021 Builder Code', () => {
  it('encodes the documented suffix byte for byte', () => {
    expect(attributionSuffix([DOC_CODE])).toBe(DOC_SUFFIX);
    expect(withBuilderCode('0x', DOC_CODE)).toBe(`0x${DOC_SUFFIX}`);
  });

  it('carries a registered code, not the placeholder', () => {
    expect(PROVIAN_BUILDER_CODE).toMatch(/^bc_[a-z0-9]+$/);
    expect(PROVIAN_BUILDER_CODE).not.toBe('bc_PLACEHOLDER');
  });

  it('appends after the call and leaves the call decodable', () => {
    const attributed = withBuilderCode(call);
    expect(attributed.startsWith(call)).toBe(true);
    expect(attributed.endsWith(ERC8021_MARKER)).toBe(true);
    expect(erc20.decodeFunctionData('transfer', attributed).toString()).toBe(erc20.decodeFunctionData('transfer', call).toString());
    expect(parseAttribution(attributed)).toEqual({ calldata: call, codes: [PROVIAN_BUILDER_CODE] });
    expect(carriesBuilderCode(attributed)).toBe(true);
  });

  it('is idempotent and merges with another schema-0 code', () => {
    const once = withBuilderCode(call);
    expect(withBuilderCode(once)).toBe(once);
    const foreign = withBuilderCode(call, DOC_CODE);
    const merged = withBuilderCode(foreign);
    expect(parseAttribution(merged)).toEqual({ calldata: call, codes: [DOC_CODE, PROVIAN_BUILDER_CODE] });
    expect(withoutBuilderCode(merged)).toBe(merged); // another party's code is never stripped as Provian's
  });

  it('strips only a well-formed suffix', () => {
    expect(stripAttribution(withBuilderCode(call))).toBe(call);
    expect(stripAttribution(call)).toBe(call);
    // RED controls: a marker with a wrong schema byte, a zero length, a length past the input, a comma code.
    const marker = ERC8021_MARKER;
    expect(parseAttribution(`0x6263${'02'}01${marker}`)).toBeNull();
    expect(parseAttribution(`0x${'00'}00${marker}`)).toBeNull();
    expect(parseAttribution(`0x6263ff00${marker}`)).toBeNull();
    expect(parseAttribution(`0x2c0100${marker}`)).toBeNull();
    expect(parseAttribution('0xzz')).toBeNull();
    expect(parseAttribution(call)).toBeNull();
  });

  it('reads an attribution-only input as a plain transfer and nothing else as one', () => {
    expect(isPlainTransferInput('0x')).toBe(true);
    expect(isPlainTransferInput(withBuilderCode('0x'))).toBe(true);
    expect(isPlainTransferInput('0X')).toBe(true);
    expect(isPlainTransferInput(withBuilderCode('0x').toUpperCase().replace('0X', '0X'))).toBe(true);
    expect(isPlainTransferInput(withBuilderCode(call))).toBe(false);
    expect(isPlainTransferInput(call)).toBe(false);
    expect(isPlainTransferInput(`0x01${DOC_SUFFIX}`)).toBe(false);
  });

  it('matches a planned call exactly: legacy bytes or the attributed bytes, never a different call', () => {
    expect(matchesPlannedCall(call, call)).toBe(true);
    expect(matchesPlannedCall(withBuilderCode(call), call)).toBe(true);
    expect(matchesPlannedCall(withBuilderCode('0x'), '0x')).toBe(true);
    // RED controls
    const other = erc20.encodeFunctionData('transfer', ['0x' + '22'.repeat(20), 5n]);
    expect(matchesPlannedCall(withBuilderCode(other), call)).toBe(false);
    expect(matchesPlannedCall(withBuilderCode(call, DOC_CODE), call)).toBe(false);
    expect(matchesPlannedCall(`${call}00`, call)).toBe(false);
    expect(matchesPlannedCall(undefined, call)).toBe(false);
  });

  it('prices the suffix at the EIP-7623 calldata floor, so a fixed-gas cancellation is includable', () => {
    // Independent arithmetic against the documented vector: 'bc_b7k3p9da' + length + schema + marker
    // is 29 bytes, one of them zero (the schema byte): 28*4 + 1 = 113 tokens, floor 21,000 + 1,130.
    // Base (Prague) refuses a self-send below this floor; 21,452 (the 16/4 price) never mines.
    expect(builderCodeGas('0x').toString()).toMatch(/^\d+$/);
    const docTokens = 28n * 4n + 1n;
    expect(21_000n + 10n * docTokens).toBe(22_130n);
    const suffix = withBuilderCode('0x').slice(2);
    let tokens = 0n;
    for (let i = 0; i < suffix.length; i += 2) tokens += suffix.slice(i, i + 2) === '00' ? 1n : 4n;
    expect(ATTRIBUTED_CANCELLATION_GAS).toBe(21_000n + 10n * tokens);
    // RED control: the pre-Prague 16/4 price is below the floor.
    let legacy = 0n;
    for (let i = 0; i < suffix.length; i += 2) legacy += suffix.slice(i, i + 2) === '00' ? 4n : 16n;
    expect(21_000n + legacy).toBeLessThan(ATTRIBUTED_CANCELLATION_GAS);
    expect(builderCodeGas(withBuilderCode(call))).toBe(0n);
  });

  it('attributes a plain value transfer only to an address with no code', () => {
    expect(attributableTransfer('0x', '0x')).toBe(true);
    expect(attributableTransfer(call, '0x6080')).toBe(true); // a call keeps its selector; ABI ignores the suffix
    expect(attributableTransfer('0x', '0x6080')).toBe(false); // receive() runs only for empty calldata
    expect(attributableTransfer(undefined, null)).toBe(false); // unknown recipient code: treated as a contract
    expect(attributableTarget('0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7')).toBe(false);
    expect(attributableTarget('0x4e59b44847b379578588920cA78FbF26c0B4956C')).toBe(false);
    expect(attributableTarget(null)).toBe(false);
    expect(attributableTarget('0x' + '33'.repeat(20))).toBe(true);
  });

  it('names Base mainnet and Base Sepolia only', () => {
    expect(isBaseChainId(8453)).toBe(true);
    expect(isBaseChainId(84532n)).toBe(true);
    expect(isBaseChainId(1)).toBe(false);
    expect(isBaseChainId(null)).toBe(false);
  });
});

describe('CanonicalWallet attribution', () => {
  const key = '0x' + '42'.repeat(32);
  it('signs every Base transaction with the Builder Code', async () => {
    const wallet = new CanonicalWallet(key);
    const raw = await wallet.signTransaction({ chainId: 8453, type: 2, nonce: 0, to: '0x' + '33'.repeat(20), data: call,
      gasLimit: 60_000, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    expect(Transaction.from(raw).data).toBe(withBuilderCode(call));
    // Without a provider the recipient's code is unknown, so a plain transfer is sent as given.
    const plain = await wallet.signTransaction({ chainId: 8453, type: 2, nonce: 1, to: '0x' + '33'.repeat(20),
      gasLimit: 30_000, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    expect(Transaction.from(plain).data).toBe('0x');
    const code = new Map<string, string>([['0x' + '44'.repeat(20), '0x6080']]);
    const provider = { getNetwork: async () => ({ chainId: 8453n }), getCode: async (a: string) => code.get(a.toLowerCase()) ?? '0x' } as never;
    const online = new CanonicalWallet(key, provider);
    const eoa = await online.signTransaction({ chainId: 8453, type: 2, nonce: 2, to: '0x' + '33'.repeat(20),
      gasLimit: 30_000, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    expect(Transaction.from(eoa).data).toBe(withBuilderCode('0x'));
    const contract = await online.signTransaction({ chainId: 8453, type: 2, nonce: 3, to: '0x' + '44'.repeat(20),
      gasLimit: 30_000, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    expect(Transaction.from(contract).data).toBe('0x');
  });
  it('signs an already attributed request unchanged', async () => {
    const wallet = new CanonicalWallet(key);
    const raw = await wallet.signTransaction({ chainId: 8453, type: 2, nonce: 0, to: '0x' + '33'.repeat(20), data: withBuilderCode(call),
      gasLimit: 60_000, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    expect(Transaction.from(raw).data).toBe(withBuilderCode(call));
  });
  it('leaves another chain untouched (RED control against attributing everything)', async () => {
    const wallet = new CanonicalWallet(key);
    const raw = await wallet.signTransaction({ chainId: 1, type: 2, nonce: 0, to: '0x' + '33'.repeat(20), data: call,
      gasLimit: 60_000, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    expect(Transaction.from(raw).data).toBe(call);
    // and a plain ethers Wallet (the class CanonicalWallet extends) never attributes on its own
    const bare = await new Wallet(key).signTransaction({ chainId: 8453, type: 2, nonce: 0, to: '0x' + '33'.repeat(20), data: call,
      gasLimit: 60_000, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    expect(Transaction.from(bare).data).toBe(call);
  });
});

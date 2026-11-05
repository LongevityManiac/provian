/** ABIs the Base side uses. `settlerAbi` mirrors contracts/src/ProvianX402FeeSettler.sol exactly. */

const permitTuple = {
  name: 'permit',
  type: 'tuple',
  components: [
    {
      name: 'permitted',
      type: 'tuple',
      components: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
    },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

const witnessTuple = {
  name: 'witness',
  type: 'tuple',
  components: [
    { name: 'to', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
  ],
} as const;

export const settlerAbi = [
  { type: 'function', name: 'usdc', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'operator', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'feeRecipient', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'permit2Proxy', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'pvt', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'MAX_FEE', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'settleWithAuthorization',
    inputs: [
      { name: 'buyer', type: 'address' },
      { name: 'seller', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
      { name: 'fee', type: 'uint256' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'settleWithPermit2',
    inputs: [permitTuple, { name: 'buyer', type: 'address' }, witnessTuple, { name: 'signature', type: 'bytes' }, { name: 'fee', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'FeeSettled',
    inputs: [
      { name: 'buyer', type: 'address', indexed: true },
      { name: 'seller', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
    ],
  },
  { type: 'error', name: 'NotOperator', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'FeeOutOfRange', inputs: [] },
  { type: 'error', name: 'FeeNotBelowValue', inputs: [] },
  { type: 'error', name: 'PaymentNotReceived', inputs: [] },
  { type: 'error', name: 'FeeTransferFailed', inputs: [] },
  { type: 'error', name: 'TokenNotAccepted', inputs: [] },
] as const;

export const erc20Abi = [
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'allowance',
    inputs: [
      { name: 'o', type: 'address' },
      { name: 's', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 's', type: 'address' },
      { name: 'v', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'v', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

export const chainlinkAbi = [
  {
    type: 'function',
    name: 'latestRoundData',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
  },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
] as const;

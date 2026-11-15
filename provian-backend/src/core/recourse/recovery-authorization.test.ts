import { recoveryOperationHash } from './owner-operation';
import { recoveryAuthorizationFixture } from './__test-helpers__/recovery-authorization-fixture';
import { AbiCoder, Interface, sha256 } from 'ethers';
import { verifyRecoveryAuthorization, assertRecoveryAuthorization, recoveryAuthorizationBreakOrigin, type RecoveryAuthorizationInput } from './recovery-authorization';
import type { EconomicStateRpcLeg } from '../onchain/economic-state';
import { RECOVERY_AUTH_ABI as auth } from './recovery-authorization';


const h = (byte: string): string => `0x${byte.repeat(32)}`;
const address = (byte: string): string => `0x${byte.repeat(20)}`;
const input: RecoveryAuthorizationInput = { kernel: address('11'), identity: h('12'), destination: address('13'),
  consumedCommitment: h('14'), nextCommitment: h('15'), nextSigningRoot: h('16'), nonce: 0, transactionHash: h('17') };
const authorization = address('18'), receiptHash = h('19'), headHash = h('20');
const fixture = (change?: (method: string, result: unknown, leg: number) => unknown) => recoveryAuthorizationFixture(input, change);

test('accepts only canonical finalized owner authorization with current matching destination and replacement commitment', async () => {
  await expect(verifyRecoveryAuthorization(input, fixture())).resolves.toEqual({ transactionHash: input.transactionHash,
    block: 100, blockHash: receiptHash, authorization, generation: 1 });
});
test('receipt confirmation can pin the exact previously queued owner intent', async () => {
  const legs = fixture();
  const receipt = await legs[0].send('eth_getTransactionReceipt', [input.transactionHash]) as { logs: Array<{ topics: string[]; data: string }> };
  const intent = auth.parseLog(receipt.logs[0])!.args.intent as string;
  await expect(verifyRecoveryAuthorization({ ...input, expectedIntent: intent }, fixture())).resolves.toBeDefined();
  await expect(verifyRecoveryAuthorization({ ...input, expectedIntent: h('ff') }, fixture())).rejects.toThrow('intent_invalid');
});
test('verifies the break-specific owner digest and authenticates its immutable origin', async () => {
  const request = { ...input, breakDestinationRoot: h('88') };
  const evidence = await verifyRecoveryAuthorization(request, recoveryAuthorizationFixture(request));
  expect(recoveryAuthorizationBreakOrigin(evidence)).toBe(address('91'));
  expect(() => recoveryAuthorizationBreakOrigin({ ...evidence })).toThrow('unverified');
  const ordinary = await verifyRecoveryAuthorization(input, fixture());
  expect(recoveryAuthorizationBreakOrigin(ordinary)).toBeNull();
  await expect(verifyRecoveryAuthorization({ ...request, breakDestinationRoot: h('89') }, recoveryAuthorizationFixture(request))).rejects.toThrow('intent_missing');
  await expect(verifyRecoveryAuthorization(request, fixture())).rejects.toThrow('restoration_missing');
  await expect(verifyRecoveryAuthorization(input, recoveryAuthorizationFixture(request))).rejects.toThrow('intent_missing');
  const duplicate = recoveryAuthorizationFixture(request, (method, value) => {
    if (method !== 'eth_getTransactionReceipt') return value;
    const receipt = value as { logs: unknown[] };
    return { ...receipt, logs: [...receipt.logs, receipt.logs[1]] };
  });
  await expect(verifyRecoveryAuthorization(request, duplicate)).rejects.toThrow('restoration_duplicate');
});
test.each(['destination', 'nextCommitment', 'nextSigningRoot', 'consumedCommitment'] as const)('refuses substituted %s', async field => {
  await expect(verifyRecoveryAuthorization({ ...input, [field]: field === 'destination' ? address('ff') : h('ff') }, fixture()))
    .rejects.toThrow('recourse_authorization_intent_missing');
});
test.each(['failed', 'missing', 'wrong-emitter', 'duplicate', 'removed', 'unfinalized', 'reorg', 'disagreement'])(
  'refuses %s receipt evidence', async mode => {
    const legs = fixture((method, result, leg) => {
      if (method === 'eth_getTransactionReceipt') {
        const receipt = result as { status: string; logs: Array<Record<string, unknown>> };
        if (mode === 'failed') return { ...receipt, status: '0x0' };
        if (mode === 'missing') return { ...receipt, logs: [] };
        if (mode === 'wrong-emitter') return { ...receipt, logs: [{ ...receipt.logs[0], address: address('ff') }] };
        if (mode === 'duplicate') return { ...receipt, logs: [...receipt.logs, ...receipt.logs] };
        if (mode === 'removed') return { ...receipt, logs: [{ ...receipt.logs[0], removed: true }] };
        if (mode === 'disagreement' && leg === 1) return { ...receipt, status: '0x0' };
      }
      if (method === 'eth_blockNumber' && mode === 'unfinalized') return '0x6e';
      if (method === 'eth_getBlockByNumber' && mode === 'reorg') return { number: '0x65', hash: h('ff') };
      return result;
    });
    await expect(verifyRecoveryAuthorization(input, legs)).rejects.toThrow();
  });
test('refuses two RPC legs belonging to the same operator', async () => {
  const legs = fixture();
  await expect(verifyRecoveryAuthorization(input, [legs[0], legs[0]])).rejects.toThrow('recourse_rpc_operators_not_independent');
});
test('refuses a superseded recovery even when the historical receipt was valid', async () => {
  const old = auth.encodeFunctionResult('ownerAuthorizationNonce', [1n]);
  await expect(verifyRecoveryAuthorization(input, fixture((method, result) =>
    method === 'eth_call' && result === old ? auth.encodeFunctionResult('ownerAuthorizationNonce', [2n]) : result)))
    .rejects.toThrow('recourse_authorization_superseded');
});

test('serialized or substituted evidence cannot manufacture an authorization capability', async () => {
  const evidence = await verifyRecoveryAuthorization(input, fixture());
  const fields = { identity: input.identity, destination: input.destination, consumedCommitment: input.consumedCommitment,
    nextCommitment: input.nextCommitment, nextSigningRoot: input.nextSigningRoot };
  expect(() => assertRecoveryAuthorization(evidence, fields)).not.toThrow();
  expect(() => assertRecoveryAuthorization({ ...evidence }, fields)).toThrow('recourse_authorization_unverified');
  expect(() => assertRecoveryAuthorization(evidence, { ...fields, destination: address('ff') })).toThrow('recourse_authorization_unverified');
});

test('ordinary successor ancestry preserves finalized recovery while its ledger begins at the new token deployment', async () => {
  const currentKernel=address('91'),currentAuthorization=address('92');
  const kernelAbi=new Interface(['function ownerAuthorization() view returns(address)']);
  const original=fixture();
  const makeLegs=(parent: string): readonly [EconomicStateRpcLeg,EconomicStateRpcLeg] => {
    const legs=original.map(leg=>({operatorId:leg.operatorId,send:async(method:string,params:readonly unknown[]):Promise<unknown>=>{
      if(method==='eth_getBlockByNumber'&&params[0]!=='finalized'){
        const n=Number(BigInt(String(params[0])));return {number:params[0],hash:n===100?receiptHash:n===111?headHash:`0x${n.toString(16).padStart(64,'0')}`};
      }
      if(method==='eth_getCode')return (params[1] as {blockHash:string}).blockHash===headHash?'0x6000':'0x';
      if(method==='eth_call'){
        const request=params[0] as {to:string;data:string};
        if(request.to===currentKernel)return kernelAbi.encodeFunctionResult('ownerAuthorization',[currentAuthorization]);
        if(request.to===currentAuthorization&&request.data===auth.encodeFunctionData('previousAuthorization'))return auth.encodeFunctionResult('previousAuthorization',[parent]);
      }
      return leg.send(method,params);
    }}));
    return [legs[0],legs[1]];
  };
  await expect(verifyRecoveryAuthorization({...input,currentKernel},makeLegs(authorization))).resolves.toMatchObject({
    authorization,generation:1,accountingBlock:111,accountingBlockHash:headHash});
  for(const parent of [address('00'),currentAuthorization])await expect(verifyRecoveryAuthorization({...input,currentKernel},makeLegs(parent)))
    .rejects.toThrow('recourse_authorization_unrelated_successor');
});

test('a bounded ticket installs credentials only when its exact scope is in the consumed owner digest', async () => {
  const scope = { request: h('aa'), lossHash: h('bb'), maximumLoss: '100' };
  const operation = recoveryOperationHash(input.identity, input.destination, scope);
  const intent = sha256(AbiCoder.defaultAbiCoder().encode(
    ['string','uint256','address','bytes32','bytes32','uint256','bytes32','bytes32','bytes32'],
    ['Provian restoration owner authorization',8453,input.kernel,input.identity,input.consumedCommitment,input.nonce,operation,input.nextCommitment,input.nextSigningRoot]));
  const ticket = auth.encodeEventLog(auth.getEvent('RestorationIntentAuthorized')!, [scope.request,input.identity,input.destination,scope.lossHash,scope.maximumLoss,operation]);
  const consumed = auth.encodeEventLog(auth.getEvent('OwnerAuthorizationConsumed')!, [input.identity,input.nonce,intent,input.nextCommitment,input.nextSigningRoot]);
  const legs = (mode: 'valid'|'changed'|'duplicate'|'unbound') => fixture((method,result) => {
    if (method !== 'eth_getTransactionReceipt') return result;
    const receipt = result as { logs: Array<Record<string,unknown>> };
    const original = receipt.logs[0];
    const log = { ...original, ...ticket };
    if (mode === 'changed') Object.assign(log, auth.encodeEventLog(auth.getEvent('RestorationIntentAuthorized')!, [scope.request,input.identity,input.destination,scope.lossHash,'101',operation]));
    return { ...receipt, logs: [mode === 'unbound' ? original : { ...original, ...consumed }, log, ...(mode === 'duplicate' ? [log] : [])] };
  });
  await expect(verifyRecoveryAuthorization(input, legs('valid'))).resolves.toMatchObject({ generation: 1 });
  for (const mode of ['changed','duplicate','unbound'] as const) await expect(verifyRecoveryAuthorization(input, legs(mode))).rejects.toThrow();
});

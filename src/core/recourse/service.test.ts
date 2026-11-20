vi.mock('./restoration-ticket', () => ({ readContinuedRestorationStatus: (...args: unknown[]) => f.ticket(...args) }));
vi.mock('./owner-chain', () => ({ readOwnerChainState: (...args: unknown[]) => f.ownerState(...args) }));
import { beforeEach, expect, it, vi } from 'vitest';
import { bindHumanPrimaryAddress, readRecourseHistory, readRecourseOverview, readRecourseView, submitHumanRestorationRequest, recoverHumanBoundAddress, type RecourseView } from './service';
const f = vi.hoisted(() => ({ calls: [] as { path: string; body: unknown }[], recovery: vi.fn(), setAddress: vi.fn(),
  history: null as unknown, requests: null as unknown, primaryMissing: false, relayDown: false, poolBinding: '',
  register:vi.fn(), bind:vi.fn(), biometricDenied:false, ticket:vi.fn(),wrongReply:false, ownerState: vi.fn(), breakContext: vi.fn(), recoverBreak: vi.fn(),
  overviewWallet: '', overviewEnrolled: true, overviewTransition: null as 'join' | null }));
const h = (b: string) => `0x${b.repeat(32)}`, a = (b: string) => `0x${b.repeat(20)}`;
vi.mock('../../services/RelayAPIService', () => ({ default: { readRecourseOwnership: async () => f.history, registerHumanWallet: (...args: unknown[]) => f.register(...args), bindRecourseOwnership: (...args: unknown[]) => f.bind(...args), getUserId: async () => 'owner', recourseRequest: async (path: string, body: unknown) => {
  f.calls.push({ path, body });
  if (f.relayDown) throw Error('unavailable'); if (path === 'ownership') return f.history;
  if (path === 'restoration-requests' && body === undefined) return f.requests;
  if (path === 'pool') return { identity: h('55'), primaryIdentity: null, walletAddress: f.overviewWallet, month: '1',
    pool: a('66'), kernel: a('77'), earningsBps: 100, reserveAtomic: '100', participationBurnAtomic: '100',
    noEarningsContributionAtomic: '100', ...(f.overviewTransition ? { membership: null, membershipTransition: f.overviewTransition }
      : { membership: { enrolled: f.overviewEnrolled, grace: false, month: '1', endMonthExclusive: '2', unpaidAtomic: '0' } }) };
  return { requestId: f.wrongReply?h('99'):h('44'), status: 'authorized' };
} } }));
vi.mock('../protocol/runtime', () => ({ ownerChainNetwork: () => ({}) }));
vi.mock('./binding-chain', () => ({ readAddressRecoveryBinding: async () => {
  if(f.primaryMissing) throw Error('recourse_binding_required'); return h('11');
} }));
vi.mock('./pool-chain', () => ({ readRecoursePoolChain: async (identity: string) => {
  f.poolBinding=identity; return {pool:a('66'),kernel:a('77'),month:'1',reserveAtomic:'100',earningsBps:100,
    participationBurnAtomic:'100',noEarningsContributionAtomic:'100'};
} }));
vi.mock('../security/biometricAction', () => ({ withBiometricAction: async (_title: string, run: (action: unknown) => unknown) => { if(f.biometricDenied) throw Error('biometric_denied'); return run('approved'); } }));
vi.mock('../../i18n/translate', () => ({ translate: (_key: string, fallback: string) => fallback }));
vi.mock('./human-recovery', () => ({ recoverHumanAccount: (...args: unknown[]) => f.recovery(...args) }));
vi.mock('./human-break-recovery', () => ({ recoverHumanAuxiliaryBreak: (...args: unknown[]) => f.recoverBreak(...args) }));
vi.mock('./break-recovery', () => ({ readBreakRecoveryContext: (...args: unknown[]) => f.breakContext(...args) }));
vi.mock('../wallet/SeedManager', () => ({ default: { getMnemonic: async () => 'test backup' } }));
vi.mock('./human-restoration-exit', () => ({ withdrawHumanRestoration: vi.fn() }));
vi.mock('../../store/walletStore', () => ({ useWalletStore: { getState: () => ({ address: a('12'), setAddress: f.setAddress }) } }));
beforeEach(() => {
  f.overviewWallet = a('12'); f.overviewEnrolled = true; f.overviewTransition = null;
  f.register.mockReset(); f.register.mockResolvedValue(true); f.bind.mockReset(); f.biometricDenied=false; f.calls = []; f.setAddress.mockReset(); f.recovery.mockReset(); f.primaryMissing=false;f.relayDown=false;f.poolBinding='';
  f.history={identity:h('11'),addresses:[{identity:h('11'),chainBindingStatus:'confirmed'}, {identity:h('55'),chainBindingStatus:'confirmed'}]};
  f.recovery.mockResolvedValue({ destination: a('22'), requestId: h('44'),restoration:{request:h('44'),lossHash:h('88'),maximumLoss:'100'} });
  f.ticket.mockReset();f.ticket.mockResolvedValue('pending');f.wrongReply=false;
  f.ownerState.mockReset(); f.ownerState.mockResolvedValue({nonce:0,destination:a('00')}); f.breakContext.mockReset(); f.recoverBreak.mockReset(); f.breakContext.mockResolvedValue(a('99'));
});
it('displays authenticated non-membership without waiting for a public chain read', async () => {
  f.overviewEnrolled = false;
  await expect(readRecourseOverview()).resolves.toMatchObject({ enrolled: false, membershipState: 'available' });
  expect(f.calls).toEqual([{ path: 'pool', body: undefined }]);
  expect(f.poolBinding).toBe('');
  f.overviewWallet = a('34');
  await expect(readRecourseOverview()).rejects.toThrow('recourse_wallet_changed');
  f.relayDown = true;
  await expect(readRecourseOverview()).rejects.toThrow('unavailable');
});
it('keeps a saved join visible without showing protection, even when the public binding already exists', async () => {
  f.overviewTransition = 'join';
  await expect(readRecourseOverview()).resolves.toMatchObject({
    membershipState: 'in_progress', membershipTransition: 'join', enrolled: false, month: '1',
  });
  expect(f.calls).toEqual([{ path: 'pool', body: undefined }]);
});
it('recovers an auxiliary after a break without membership or primary changes and never falls back on unverifiable history',async()=>{
  f.history={identity:null,addresses:[{identity:h('55'),address:a('22'),recoveryGeneration:0,chainBindingStatus:'confirmed'}]};
  await recoverHumanBoundAddress(h('55'));
  expect(f.recoverBreak).toHaveBeenCalledWith('test backup','approved',{identity:h('55'),originAddress:a('22')},{network:{}});
  expect(f.recovery).not.toHaveBeenCalled();expect(f.setAddress).not.toHaveBeenCalled();
  f.breakContext.mockRejectedValueOnce(Error('break_recovery_unavailable'));
  await recoverHumanBoundAddress(h('55'));
  expect(f.recovery).toHaveBeenCalledWith('approved',{auxiliaryBinding:h('55'),newRecovery:true});
  f.recovery.mockClear();f.recoverBreak.mockClear();f.breakContext.mockRejectedValueOnce(Error('break_recovery_rpc_disagreement'));
  await expect(recoverHumanBoundAddress(h('55'))).rejects.toThrow('disagreement');
  expect(f.recovery).not.toHaveBeenCalled();expect(f.recoverBreak).not.toHaveBeenCalled();
});
it('submits auxiliary restoration under its selected binding without changing the primary wallet address', async () => {
  await submitHumanRestorationRequest(h('33'), 100, h('55'));
  expect(f.recovery).toHaveBeenCalledWith('approved', { lossTransaction: h('33'), lossBlock: 100, auxiliaryBinding: h('55') });
  expect(f.setAddress).not.toHaveBeenCalled();
  expect(f.calls.filter(c=>c.path!=='ownership')).toEqual([{ path: 'restoration-requests', body: { transactionHash: h('33'), block: 100,
    recoveryRequestId: h('44'), restorationRequestId:h('44'), identity: h('55') } }]);
  await submitHumanRestorationRequest(h('33'), 100, h('11'));
  expect(f.setAddress).toHaveBeenCalledWith(a('22'));
  expect(f.recovery).toHaveBeenLastCalledWith('approved', { lossTransaction: h('33'), lossBlock: 100, auxiliaryBinding: undefined });
});
it('never submits or changes a primary address after an auxiliary recovery failure', async () => {
  f.recovery.mockRejectedValueOnce(Error('invalid_receipt'));
  await expect(submitHumanRestorationRequest(h('33'), 100, h('55'))).rejects.toThrow('invalid_receipt');
  expect(f.calls.every(c=>c.path==='ownership')).toBe(true); expect(f.setAddress).not.toHaveBeenCalled();
});
it('explicit auxiliary recovery and its private membership view work without a primary binding',async()=>{
  f.primaryMissing=true;
  f.history={identity:null,addresses:[{identity:h('55'),address:a('22'),boundAtMs:1,openingBalanceAtomic:'10',chainBindingStatus:'confirmed'}]};
  f.requests={requests:[]};
  await submitHumanRestorationRequest(h('33'),100,h('55'));
  expect(f.recovery).toHaveBeenCalledWith('approved',{lossTransaction:h('33'),lossBlock:100,auxiliaryBinding:h('55')});
  expect(f.setAddress).not.toHaveBeenCalled();
  const view=await readRecourseView();
  expect(view.identity).toBe(h('55'));expect(view.membershipState).toBe('available');expect(view.enrolled).toBe(true);
  expect((await readRecourseHistory(view)).historyState).toBe('available');
  f.relayDown=true;
  const publicOnly=await readRecourseView();
  expect(f.poolBinding).toBe(h('00'));expect(publicOnly.reserveAtomic).toBe('100');expect(publicOnly.membershipState).toBe('unavailable');
});
it('retains binding identity on every address and request and refuses missing identities', async () => {
  f.history = { identity: h('11'), addresses: [{ identity: h('55'), address: a('22'), boundAtMs: 1,
    openingBalanceAtomic: '10', chainBindingStatus: 'confirmed' }] };
  f.requests = { requests: [{ identity: h('55'), requestId: h('44'), transactionHash: h('33'), status: 'authorized' }] };
  const view = { identity: h('11'), historyState: 'pending', addresses: [], requests: [] } as unknown as RecourseView;
  const result = await readRecourseHistory(view);
  expect(result.historyState).toBe('available'); expect(result.addresses[0].identity).toBe(h('55'));
  expect(result.requests[0].identity).toBe(h('55'));
  f.requests = { requests: [{ requestId: h('44'), transactionHash: h('33'), status: 'authorized' }] };
  expect((await readRecourseHistory(view)).historyState).toBe('unavailable');
});

it('the auxiliary recovery button routes a restored hash binding to fresh replacement recovery',async()=>{
 f.history={identity:null,addresses:[{identity:h('55'),address:a('22'),recoveryGeneration:0,chainBindingStatus:'confirmed'},
  {identity:h('55'),address:a('33'),recoveryGeneration:1,chainBindingStatus:'confirmed'}]};
 f.ownerState.mockResolvedValue({nonce:1,destination:a('33')});
 await recoverHumanBoundAddress(h('55'));
 expect(f.recovery).toHaveBeenCalledWith('approved',{auxiliaryBinding:h('55'),newRecovery:true});
 expect(f.recoverBreak).not.toHaveBeenCalled();expect(f.setAddress).not.toHaveBeenCalled();
 f.ownerState.mockRejectedValueOnce(Error('rpc_disagreement'));f.recovery.mockClear();
 await expect(recoverHumanBoundAddress(h('55'))).rejects.toThrow('disagreement');expect(f.recovery).not.toHaveBeenCalled();
});

it('terminal observations suppress only the current submission and are rechecked after a reorg',async()=>{
 f.ticket.mockResolvedValueOnce('executed');await submitHumanRestorationRequest(h('33'),100,h('55'));
 expect(f.calls.some(c=>c.path==='restoration-requests')).toBe(false);
 await submitHumanRestorationRequest(h('33'),100,h('55'));
 expect(f.calls.filter(c=>c.path==='restoration-requests')).toHaveLength(1);
 expect(f.ticket).toHaveBeenCalledTimes(2);
});
it('missing or changed tickets and wrong returned occurrence cannot complete a restoration request',async()=>{
 f.ticket.mockResolvedValueOnce('absent');await expect(submitHumanRestorationRequest(h('33'),100,h('55'))).rejects.toThrow('ticket_changed');
 expect(f.calls.some(c=>c.path==='restoration-requests')).toBe(false);
 f.wrongReply=true;await expect(submitHumanRestorationRequest(h('33'),100,h('55'))).rejects.toThrow('reply_invalid');
 f.ticket.mockRejectedValueOnce(Error('rpc_disagreement'));await expect(submitHumanRestorationRequest(h('33'),100,h('55'))).rejects.toThrow('disagreement');
});

it('retries primary registration only with approval and verifies both chain and primary ownership', async () => {
  await bindHumanPrimaryAddress();
  expect(f.register).toHaveBeenCalledWith(a('12'), undefined, 'approved');
  f.register.mockClear(); f.biometricDenied=true;
  await expect(bindHumanPrimaryAddress()).rejects.toThrow('biometric_denied');
  expect(f.register).not.toHaveBeenCalled();
  f.biometricDenied=false; f.register.mockResolvedValueOnce(false);
  await expect(bindHumanPrimaryAddress()).rejects.toThrow('registration_required');
  f.primaryMissing=true;
  await expect(bindHumanPrimaryAddress()).rejects.toThrow('binding_required');
  f.primaryMissing=false; f.history={identity:null};
  await expect(bindHumanPrimaryAddress()).rejects.toThrow('primary_binding_required');
  expect(f.bind).not.toHaveBeenCalled();
});

it('shows verified public chain data before private lookup even when no wallet is bound and the relay is down', async () => {
  f.primaryMissing = true;
  f.relayDown = true;
  const observed: RecourseView[] = [];
  const view = await readRecourseView(value => {
    expect(f.calls).toHaveLength(0);
    expect(value.reserveAtomic).toBe('100');
    expect(value.membershipState).toBe('unavailable');
    observed.push(value);
  });
  expect(observed).toHaveLength(1);
  expect(view.enrolled).toBe(false);
  expect(view.membershipState).toBe('unavailable');
});

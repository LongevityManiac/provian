import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const a = '0x' + '11'.repeat(20), b = '0x' + '22'.repeat(20);
const source = readFileSync(new URL('./exercise-workbench-client.mjs', import.meta.url), 'utf8').replace(/import .*?;\n/, '');
function harness({ lost = false, selected = a, chain = '0x7a69', progress = { state: 'idle' }, values = {}, onFetch, onWallet, phantom = false, unknownNetwork = false } = {}) {
  const elements = new Map(), calls = [], walletCalls = [], listeners = {};
  const state = { address: a, identity: 'id', balance: '500000000000000000000', allowance: '0', bound: false,
    member: false, initialBurnPaid: false, sequenceStarted: false, exerciseBusy: false, ...values };
  let accounts = selected ? [selected] : [], chainId = chain, job = progress;
  const document = { querySelector: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } };
  const config = { chainId: 31337, copiedFunder: b, kernel: 'kernel', registry: 'registry', pool: 'pool', standingAddress:'standing' };
  const controls = {
    accounts(value, event = true) { accounts = value; if (event) listeners.accountsChanged?.(value); },
    network(value) { chainId = value; listeners.chainChanged?.(value); },
  };
  const fetch = async (path, options) => {
    const body = options?.body ? JSON.parse(options.body) : null; calls.push({ path, body });
    await onFetch?.(path, controls);
    if (path === '/exercise') { job = { state: 'running', pending: { id: 'one', challenge: { summary: 'Burn 100 copied PVT', messageHex: '0x1234' } } }; if (lost) throw Error('lost response'); }
    if (path === '/exercise-signature') job = { state: 'completed', result: { completed: true } };
    const value = path === '/manifest' ? config : path === '/state' ? state : path === '/exercise-status' ? job
      : path === '/binding' ? { binding: {}, messageHex: '0xabcd', attestorSignature: 'attestor', revision: '1' }
      : path === '/membership' ? { challenge: { messageHex: '0xbeef', summary: 'Local membership', method: 'setStandingConsent', authorization: {} }, attestorSignature: 'attestor' } : {};
    return { ok: true, json: async () => value };
  };
  const wallet = { isMetaMask: true, on: (name, fn) => { listeners[name] = fn; }, request: async args => {
    walletCalls.push(args); await onWallet?.(args, controls);
    if (args.method === 'eth_chainId') return chainId;
    if (args.method === 'eth_accounts') return accounts;
    if (args.method === 'eth_requestAccounts') { accounts = [a]; return accounts; }
    if (args.method === 'wallet_switchEthereumChain') {
      if (unknownNetwork) { const error = Error('unknown network'); error.code = 4902; throw error; }
      controls.network('0x7a69'); return null;
    }
    if (args.method === 'wallet_addEthereumChain') { unknownNetwork = false; return null; }
    if (args.method === 'personal_sign') return 'signed';
    if (args.method === 'eth_sendTransaction') return 'hash';
    if (args.method === 'eth_getTransactionReceipt') return { status: '0x1' };
    throw Error(args.method);
  } };
  const announcements = {};
  const context = vm.createContext({ document, fetch, Event: class { constructor(type) { this.type = type; } }, window: { ethereum: phantom ? { isPhantom: true, request: () => { throw Error('wrong provider'); } } : wallet,
      addEventListener(name, fn) { announcements[name] = fn; },
      dispatchEvent() { if (phantom) announcements['eip6963:announceProvider']?.({ detail: { info: { rdns: 'io.metamask' }, provider: wallet } }); } }, formatEther: value => String(BigInt(value) / 10n ** 18n),
    setTimeout: fn => { fn(); return 1; }, Interface: class { encodeFunctionData(method) { return method; } } });
  vm.runInContext(source + '\nglobalThis.setup=(c,s,j)=>{selectMetaMask();account="' + a + '";config=c;state=s;job=j;render();};globalThis.read=()=>({account,state,job,draft});', context);
  context.setup(config, state, job);
  return { context, elements, calls, walletCalls, controls, listeners, click: id => elements.get('#' + id).onclick(),
    signs: () => walletCalls.filter(x => x.method === 'personal_sign'), txs: () => walletCalls.filter(x => x.method === 'eth_sendTransaction') };
}
test('account events immediately clear the old address, balance and actions', async () => {
  const h = harness(); h.controls.accounts([b]);
  expect(h.elements.get('#wallet').textContent).toBe('Not connected');
  expect(h.elements.get('#balance').textContent).toBe('—');
  expect(h.elements.get('#next').disabled).toBe(true);
  await h.click('connect');
  expect(h.elements.get('#wallet').textContent).toBe(b);
  expect(h.signs()).toHaveLength(0);
});
test('binding signature and transaction require separate clicks', async () => {
  const h = harness(); await h.click('next');
  expect(h.signs().map(x => x.params)).toEqual([['0xabcd', a]]);
  expect(h.txs()).toHaveLength(0);
  expect(h.elements.get('#next').textContent).toBe('Confirm local transaction');
  await h.click('next'); expect(h.txs()).toHaveLength(1);
  expect(h.txs()[0].params[0]).toEqual({ from: a, to: 'registry', data: 'bind' });
});
test('membership signature never chains an approval, burn or transaction', async () => {
  const h = harness({ values: { bound: true } }); await h.click('next');
  expect(h.calls.filter(c => c.path === '/membership').map(c => c.body.kind)).toEqual(['join']);
  expect(h.signs()).toHaveLength(1); expect(h.txs()).toHaveLength(0);
});
test('refresh reads pending work without opening any signature prompt', async () => {
  const h = harness({ progress: { state: 'running', pending: { id: 'one', challenge: { summary: 'burn', messageHex: '0x1234' } } } });
  await h.click('refresh'); expect(h.signs()).toHaveLength(0); expect(h.txs()).toHaveLength(0);
  expect(h.elements.get('#next').textContent).toBe('Sign this exercise step');
  await h.click('next'); expect(h.signs()).toHaveLength(1);
  expect(h.calls.filter(c => c.path === '/exercise-signature').map(c => c.body.address)).toEqual([a]);
});
test('lost successful start response reads the existing job and never starts twice', async () => {
  const h = harness({ lost: true, values: { bound: true, member: true, initialBurnPaid: true } });
  await h.click('next'); expect(h.calls.filter(c => c.path === '/exercise')).toHaveLength(1);
  expect(h.signs()).toHaveLength(0); expect(h.elements.get('#next').textContent).toBe('Sign this exercise step');
});
test('changed account without a provider event refuses funding', async () => {
  const h = harness({ selected: b, values: { balance: '0' } }); await h.click('next');
  expect(h.calls.some(c => c.path === '/fund')).toBe(false); expect(h.elements.get('#wallet').textContent).toBe('Not connected');
});
test('switch during binding preparation refuses the stale signature', async () => {
  const h = harness({ onFetch: (path, controls) => { if (path === '/binding') controls.accounts([b]); } });
  await h.click('next'); expect(h.signs()).toHaveLength(0); expect(h.txs()).toHaveLength(0);
  expect(h.context.read().draft).toBeUndefined();
});
test('switch while signing discards the returned signature without submitting', async () => {
  const h = harness({ onWallet: (args, controls) => { if (args.method === 'personal_sign') controls.accounts([b]); } });
  await h.click('next'); expect(h.signs()).toHaveLength(1); expect(h.txs()).toHaveLength(0);
  expect(h.context.read().draft).toBeUndefined();
});
test('network change clears a signed draft and blocks transaction submission', async () => {
  const h = harness(); await h.click('next'); h.controls.network('0x2105'); await h.click('next');
  expect(h.context.read().draft).toBeUndefined(); expect(h.txs()).toHaveLength(0);
});
test('wrong network without an event blocks signing', async () => {
  const h = harness({ chain: '0x2105' }); await h.click('next');
  expect(h.signs()).toHaveLength(0); expect(h.calls.some(c => c.path === '/binding')).toBe(false);
});
test('stale state response cannot restore a previous account after switch', async () => {
  const h = harness({ onFetch: (path, controls) => { if (path === '/state') controls.accounts([b]); } });
  await h.click('refresh'); expect(h.context.read().state).toBeUndefined();
  expect(h.elements.get('#wallet').textContent).toBe('Not connected');
});
test('double click cannot issue duplicate signatures', async () => {
  const h = harness(); await Promise.all([h.click('next'), h.click('next')]);
  expect(h.signs()).toHaveLength(1); expect(h.txs()).toHaveLength(0);
});
test('provider replacement refuses signing even if the old account still matches', async () => {
  const h = harness(); h.context.window.ethereum = {}; await h.click('next');
  expect(h.signs()).toHaveLength(0); expect(h.txs()).toHaveLength(0);
});
test('read-only refresh reports completion without restarting an exercise', async () => {
  const h = harness({ progress: { state: 'completed', result: {} } }); await h.click('refresh');
  expect(h.elements.get('#next-title').textContent).toBe('Exercise complete');
  expect(h.elements.get('#next').disabled).toBe(true); expect(h.signs()).toHaveLength(0);
});

test('MetaMask discovery bypasses a competing Phantom global provider', async () => {
  const h = harness({ phantom: true }); await h.click('connect'); await h.click('next');
  expect(h.signs()).toHaveLength(1); expect(h.signs()[0].params[1]).toBe(a);
});
test('account permission and network switch require separate clicks', async () => {
  const h = harness({ selected: null, chain: '0x2105' }); await h.click('connect');
  const prompts = () => h.walletCalls.filter(c => ['eth_requestAccounts', 'wallet_switchEthereumChain', 'wallet_addEthereumChain'].includes(c.method));
  expect(prompts().map(c => c.method)).toEqual(['eth_requestAccounts']);
  await h.click('connect');
  expect(prompts().map(c => c.method)).toEqual(['eth_requestAccounts', 'wallet_switchEthereumChain']);
});
test('unknown network addition never chains onto a failed switch prompt', async () => {
  const h = harness({ chain: '0x2105', unknownNetwork: true }); await h.click('connect');
  expect(h.walletCalls.filter(c => c.method === 'wallet_addEthereumChain')).toHaveLength(0);
  expect(h.elements.get('#connect').textContent).toBe('Add local exercise network');
  await h.click('connect');
  expect(h.walletCalls.filter(c => c.method === 'wallet_addEthereumChain')).toHaveLength(1);
  expect(h.walletCalls.filter(c => c.method === 'wallet_switchEthereumChain')).toHaveLength(1);
});

test('monthly burn uses existing consent without another owner signature or allowance',async()=>{
  const h=harness({values:{bound:true,member:true,initialBurnPaid:false}});
  await h.click('next');
  expect(h.calls.filter(c=>c.path==='/burn')).toHaveLength(1);
  expect(h.signs()).toHaveLength(0);expect(h.txs()).toHaveLength(0);
  const unjoined=harness({values:{bound:true,member:false}});await unjoined.click('next');
  expect(unjoined.calls.filter(c=>c.path==='/burn')).toHaveLength(0);
  expect(unjoined.signs()).toHaveLength(1);
});

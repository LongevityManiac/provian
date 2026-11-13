import { Interface, formatEther } from '/ethers.js';
const el = id => document.querySelector('#' + id);
let wallet, announcedMetaMask, legacyProvider = false, needsNetwork = false;
const attachedProviders = new WeakSet();
window.addEventListener('eip6963:announceProvider', event => {
  if (event.detail?.info?.rdns === 'io.metamask') announcedMetaMask = event.detail.provider;
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
function selectMetaMask() {
  if (wallet) return;
  const injected = window.ethereum;
  wallet = announcedMetaMask || injected?.providers?.find(provider => provider.isMetaMask && !provider.isPhantom)
    || (injected?.isMetaMask && !injected.isPhantom ? injected : undefined);
  if (!wallet) throw Error('MetaMask was not detected. Unlock MetaMask, reload this page, and connect again.');
  legacyProvider = !announcedMetaMask && wallet === injected;
  if (!attachedProviders.has(wallet)) {
    wallet.on?.('accountsChanged', () => invalidate('MetaMask changed accounts. Reconnect to use its selected address.'));
    wallet.on?.('chainChanged', () => invalidate('MetaMask changed networks. Reconnect to verify the local exercise network.'));
    wallet.on?.('disconnect', () => invalidate('MetaMask disconnected. Reconnect when ready.'));
    attachedProviders.add(wallet);
  }
}
let account, config, state, job, draft, busy = false, version = 0, refreshVersion = 0, nextAction;
const unit = 10n ** 18n;
const show = message => { el('status').textContent = message; };
async function api(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const value = await response.json();
  if (!response.ok) throw Error(value.error || 'The local workbench could not complete this step.');
  return value;
}
function choose(title, description, label, action) {
  el('next-title').textContent = title;
  el('next-description').textContent = description;
  el('next').textContent = label;
  nextAction = action;
  el('next').disabled = busy || !action;
}
function render() {
  el('wallet').textContent = account || 'Not connected';
  el('balance').textContent = state ? formatEther(state.balance) + ' copied PVT' : '—';
  el('refresh').disabled = busy || !account;
  el('connect').disabled = busy;
  el('discard').hidden = !draft;
  el('discard').disabled = busy;
  el('details').textContent = JSON.stringify({ account, state, job }, null, 2);
  el('progress-bind').textContent = (state?.bound ? '✓ ' : '') + 'Bind this address on the local copy.';
  el('progress-join').textContent = (state?.member ? '✓ ' : '') + 'Join the local Recourse Pool.';
  el('progress-burn').textContent = (state?.initialBurnPaid ? '✓ ' : '') + 'Burn 100 copied PVT for the first month.';
  el('progress-exercise').textContent = (job?.state === 'completed' ? '✓ ' : '') + 'Simulate a loss, reverse 60 PVT, and restore 40 PVT from the pool.';
  el('step').textContent = 'NEXT STEP';
  if (!account || !state) return choose('Connect your browser wallet', 'Compare the full address above with the account selected in MetaMask.', 'Connect first', null);
  if (draft) return choose('Confirm the signed step on the local chain', draft.description + ' You already signed the message. Now confirm its separate transaction in MetaMask.', 'Confirm local transaction', submitDraft);
  if (job?.state === 'failed') return choose('The exercise stopped', job.error + '. Keep this local copy for inspection; do not restart the exercise.', 'Stopped', null);
  if (job?.state === 'completed' || state.sequence?.completed) return choose('Exercise complete', '60 PVT was reversed and 40 PVT restored from the pool to the public test destination. Your real Base funds are unchanged.', 'Complete', null);
  if (job?.pending) return choose('Authorize the next exercise step', job.pending.challenge.summary + ' Sign within three minutes of this request appearing.', 'Sign this exercise step', signQueued);
  if (job?.state === 'running') return choose('The local exercise is running', 'Refresh status to see the next signature request. Refreshing never asks you to sign.', 'Check for next step', refresh);
  if (state.sequenceStarted) return choose('An exercise record already exists', 'This run cannot be restarted. Keep this local copy for inspection.', 'Record retained', null);
  if (state.exerciseBusy) return choose('Another local step is running', 'Wait for it to finish, then refresh status.', 'Refresh status', refresh);
  if (BigInt(state.balance) < (state.initialBurnPaid ? 300n : 400n) * unit) return choose('Add copied PVT for the exercise', 'Bring this address to 500 copied PVT using the local test funding wallet. No wallet signature or real transfer is involved.', 'Add copied PVT', config.copiedFunder ? fund : null);
  if (!state.bound) return choose('Bind this address', 'Sign a message linking this address to public test recovery material on chain 31337. Then confirm a separate local transaction.', 'Sign local binding', bind);
  if (!state.member) return choose('Join the local Recourse Pool', 'Approve once: a monthly burn of 100 copied PVT and a contribution of 1% of earnings, or 100 copied PVT without earnings.', 'Approve and join', () => membership('join'));
  if (!state.initialBurnPaid) return choose('Complete the first monthly burn', 'Your membership approval already permits this 100 copied PVT burn. No new wallet signature is needed.', 'Run monthly burn', burn);
  choose('Report a theft and get restored', 'Advance the local clock, complete the next monthly burn and the no-earnings contribution, then report a simulated 100 PVT theft and restore it to a public test destination.', 'Report a simulated theft', startExercise);
}
function invalidate(message) {
  ++version; ++refreshVersion;
  account = undefined; state = undefined; job = undefined; draft = undefined;
  el('network').textContent = 'Wallet or network changed. Reconnect to verify chain 31337.';
  render(); show(message);
}
function snapshot() {
  if (!account || !config) throw Error('Connect your browser wallet first.');
  return { account, version };
}
function unchanged(selected) {
  if (selected.version !== version || selected.account !== account || (legacyProvider && wallet !== window.ethereum)) throw Error('Wallet changed. Reconnect before continuing.');
}
async function guard(selected) {
  unchanged(selected);
  const chain = await wallet.request({ method: 'eth_chainId' });
  const accounts = await wallet.request({ method: 'eth_accounts' });
  unchanged(selected);
  if (chain.toLowerCase() !== '0x7a69' || accounts[0]?.toLowerCase() !== selected.account) {
    invalidate('Wallet or network changed. No further step was submitted. Reconnect to continue.');
    throw Error('Reconnect the selected wallet on Isolated Recourse (31337).');
  }
}
async function refresh() {
  const selected = snapshot(), request = ++refreshVersion;
  await guard(selected);
  const latest = await api('/state', { address: selected.account });
  const progress = await api('/exercise-status', { address: selected.account });
  await guard(selected);
  if (request !== refreshVersion) return;
  state = latest; job = progress;
  el('network').textContent = 'Isolated Recourse · chain 31337 · local copy only';
  render();
}
async function connect() {
  selectMetaMask();
  if (legacyProvider && wallet !== window.ethereum) throw Error('Wallet provider changed. Reload this page to select MetaMask again.');
  config = await api('/manifest');
  if (config.chainId !== 31337) throw Error('The workbench is not the isolated exercise.');
  let accounts = await wallet.request({ method: 'eth_accounts' });
  if (!accounts.length) {
    await wallet.request({ method: 'eth_requestAccounts' });
    el('connect').textContent = 'Continue connection';
    show('Account permission requested. Click Continue connection to verify the network.');
    return;
  }
  if ((await wallet.request({ method: 'eth_chainId' })).toLowerCase() !== '0x7a69') {
    if (needsNetwork) {
      await wallet.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x7a69', chainName: 'Isolated Recourse', rpcUrls: ['http://127.0.0.1:18545'], nativeCurrency: { name: 'Exercise ETH', symbol: 'ETH', decimals: 18 } }] });
      needsNetwork = false;
      el('connect').textContent = 'Continue connection';
      show('Network added. Click Continue connection to verify it.');
      return;
    }
    try { await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x7a69' }] }); }
    catch (error) {
      if (error.code !== 4902) throw error;
      needsNetwork = true;
      el('connect').textContent = 'Add local exercise network';
      show('MetaMask needs the local network. Click Add local exercise network for its separate prompt.');
      return;
    }
  }
  accounts = await wallet.request({ method: 'eth_accounts' });
  [account] = accounts.map(value => value.toLowerCase());
  ++version; draft = undefined; state = undefined; job = undefined;
  if (!account) throw Error('Select and connect an account in MetaMask.');
  el('connect').textContent = 'Reconnect MetaMask';
  await refresh(); show('Connected. Compare the full address above with MetaMask before the next step.');
}
async function sign(selected, messageHex) {
  await guard(selected);
  const signature = await wallet.request({ method: 'personal_sign', params: [messageHex, selected.account] });
  await guard(selected);
  return signature;
}
async function send(selected, to, data) {
  await guard(selected);
  const hash = await wallet.request({ method: 'eth_sendTransaction', params: [{ from: selected.account, to, data }] });
  show('Local transaction submitted. Waiting for confirmation: ' + hash);
  for (let i = 0; i < 120; ++i) {
    await guard(selected);
    const receipt = await wallet.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (receipt) {
      if (BigInt(receipt.status) !== 1n) throw Error('Local transaction reverted. Refresh before retrying.');
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error('Receipt still pending. Refresh before retrying.');
}
async function fund() {
  const selected = snapshot(); await guard(selected);
  await api('/fund', { address: selected.account });
  await guard(selected); await refresh(); show('Copied test PVT added. No real funds moved.');
}
async function bind() {
  const selected = snapshot(); await guard(selected);
  const prepared = await api('/binding', { address: selected.account });
  const signature = await sign(selected, prepared.messageHex);
  draft = { selected, to: config.registry, description: 'Bind ' + selected.account + ' on chain 31337.',
    data: new Interface(config.registryAbi).encodeFunctionData('bind', [prepared.binding, signature, prepared.attestorSignature, prepared.revision]) };
  show('Binding message signed. The next button opens its local transaction.');
}
async function membership(kind) {
  const selected = snapshot(); await guard(selected);
  const prepared = await api('/membership', { address: selected.account, kind }), challenge = prepared.challenge;
  const signature = await sign(selected, challenge.messageHex);
  draft = { selected, to: config.standingAddress, description: challenge.summary,
    data: new Interface(config.standingAbi).encodeFunctionData(challenge.method, [challenge.authorization, signature, prepared.attestorSignature]) };
  show('Message signed. The next button opens its local transaction.');
}
async function submitDraft() {
  const pending = draft;
  if (!pending) throw Error('Prepare and sign this step again.');
  // Never silently retry a signed transaction after an uncertain submission.
  draft = undefined;
  await send(pending.selected, pending.to, pending.data);
  await refresh(); show('Local transaction confirmed.');
}
async function burn() {
  const selected = snapshot(); await guard(selected);
  await api('/burn', { address: selected.account });
  await refresh(); show('100 copied PVT burned under your existing approval.');
}
async function startExercise() {
  const selected = snapshot(); await guard(selected);
  try { await api('/exercise', { address: selected.account }); }
  catch (error) {
    const progress = await api('/exercise-status', { address: selected.account });
    if (!['running', 'completed'].includes(progress.state)) throw error;
  }
  await refresh(); show('Local exercise started. Refresh to see the monthly contribution, burn and restoration result.');
}
async function signQueued() {
  const selected = snapshot(); await guard(selected);
  const pending = job?.pending;
  const current = await api('/exercise-status', { address: selected.account });
  if (!pending || current.pending?.id !== pending.id) throw Error('Signature request changed. Refresh status.');
  const signature = await sign(selected, pending.challenge.messageHex);
  await api('/exercise-signature', { address: selected.account, id: pending.id, signature });
  await refresh(); show('Signature accepted for this local step. Check for the next step.');
}
function action(id, run) {
  el(id).onclick = async () => {
    if (busy) return;
    busy = true; render();
    try { await run(); }
    catch (error) { show(error.message || 'The wallet did not complete this step.'); }
    finally { busy = false; render(); }
  };
}
action('connect', connect);
action('refresh', refresh);
action('next', () => nextAction?.());
action('discard', async () => { draft = undefined; await refresh(); show('Unfinished step discarded.'); });
render();

import {describe, expect, it, vi} from 'vitest';
import {canonicalAgentInviteUrl, parseCanonicalInviteUrl, parseInstallReferrer, runDeferredInviteCheck, type DeferredInviteDeps, DEFERRED_INVITE_CHECKED_KEY, INSTALL_REFERRER_INVITE_KEY} from './DeferredInvite';
import {canonicalInviteUrl, inviteQuery, playStoreUrl, readInviteFromSearch} from '../../provian-website/src/lib/inviteCarry';
const invite = {kind: 'agent' as const, inviteId: 'inv_abcdefgh', agentWalletId: 'wallet_aw_abcdefgh'};
const url = canonicalAgentInviteUrl(invite.inviteId, invite.agentWalletId);
function dependencies(overrides: Partial<DeferredInviteDeps> = {}): DeferredInviteDeps {
 return {platform:'ios',storage:{getItem:vi.fn(async()=>null),setItem:vi.fn(async()=>{})},walletExists:()=>false,
 getInstallReferrer:vi.fn(async()=>''),clipboardHasUrl:vi.fn(async()=>true),clipboardGetUrl:vi.fn(async()=>url),clipboardGetString:vi.fn(async()=>url),capture:vi.fn(async()=>true),...overrides};
}
describe('agent invitation survives installation',()=>{
 it.each([url+'&extra=1',url+'#fragment',url.replace('provian.ai','evil.example'),url.replace('invite=','invite=x&invite=')])('refuses a noncanonical URL: %s',(raw)=>{
  expect(parseCanonicalInviteUrl(raw)).toBeNull();
 });
 it('captures on first iOS launch and marks the check complete',async()=>{
  const deps=dependencies();expect(await runDeferredInviteCheck(deps)).toBe('captured');
  expect(deps.capture).toHaveBeenCalledWith(invite);
  expect(deps.storage.setItem).toHaveBeenCalledWith(DEFERRED_INVITE_CHECKED_KEY,expect.any(String));
 });
 it('does not read clipboard text without URL consent on iOS',async()=>{
  const deps=dependencies({clipboardHasUrl:vi.fn(async()=>false)});expect(await runDeferredInviteCheck(deps)).toBe('no_invite');expect(deps.clipboardGetUrl).not.toHaveBeenCalled();
 });
 it('does not capture again after a wallet exists or the install was checked',async()=>{
  for(const deps of [dependencies({walletExists:()=>true}),dependencies({storage:{getItem:async()=> 'done',setItem:vi.fn()}})]){
   await runDeferredInviteCheck(deps);expect(deps.capture).not.toHaveBeenCalled();expect(deps.clipboardGetUrl).not.toHaveBeenCalled();
  }
 });
 it('delivers the link when onboarding completes during a carrier read',async()=>{
  let exists=false;const deps=dependencies({walletExists:()=>exists,clipboardGetUrl:vi.fn(async()=>{exists=true;return url;})});
  expect(await runDeferredInviteCheck(deps)).toBe('captured');expect(deps.capture).toHaveBeenCalledWith(invite);
 });
});
it('a late install carrier notifies the mounted link replay and is consumed once', async()=>{
 const {subscribePendingLinkAccept,stashPendingLinkAccept,consumePendingLinkAccept}=await import('../navigation/pendingLinkAccept');
 consumePendingLinkAccept();
 let onboarded=false;
 const navigate=vi.fn();
 const unsubscribe=subscribePendingLinkAccept(()=>{if(onboarded)navigate(consumePendingLinkAccept());});
 const deps=dependencies({walletExists:()=>onboarded,clipboardGetUrl:async()=>{onboarded=true;return url;},capture:async target=>{stashPendingLinkAccept(target);return true;}});
 expect(await runDeferredInviteCheck(deps)).toBe('captured');
 expect(navigate).toHaveBeenCalledOnce();expect(navigate).toHaveBeenCalledWith(invite);
 expect(consumePendingLinkAccept()).toBeNull();unsubscribe();
});

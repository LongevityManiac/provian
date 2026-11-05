/** Native boundary controls. Android is source/model verified here; no Android build is run. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHmac, generateKeyPairSync, publicEncrypt, privateDecrypt, randomBytes, timingSafeEqual, constants, createCipheriv, createDecipheriv } from 'node:crypto';
import { describe, it, expect } from 'vitest';
const android = readFileSync(resolve(__dirname, '../../../modules/provian-secure-seed/android/src/main/java/expo/modules/proviansecureseed/ProvianSecureSeedModule.kt'), 'utf8');
const ios = readFileSync(resolve(__dirname, '../../../modules/provian-secure-seed/ios/ProvianSecureSeedModule.swift'), 'utf8');
function androidDefects(source: string) {
    const errors: string[]=[];
    if (!source.includes('authenticateRootRecord(root)') || !source.includes('authenticateRootRecord(staged)')) errors.push('untrusted wrapping accepted');
    const stage=source.slice(source.indexOf('private fun setItem('),source.indexOf('private suspend fun unwrapRecord'));
    if (!(stage.indexOf('rootMac(record, true)') >= 0 && stage.indexOf('rootMac(record, true)') < stage.indexOf('stream.write'))) errors.push('fresh wrapping persisted unsigned');
    if (source.includes('root = sealedRecord(existing, dataKey')) errors.push('unsigned legacy DEK adopted');
    if (!source.includes('a.keys.isNotEmpty() || a.legacy.isNotEmpty() || a.root != null')) errors.push('granted credential action survives pause');
    if (!source.includes('a.keys.values.forEach { it.fill(0) }')) errors.push('action DEKs survive end');
    if (!source.includes('alias != null && !referenced')) errors.push('shared key deleted with one slot');
    const legacy=source.slice(source.indexOf('private suspend fun getLegacyItem'),source.indexOf('private fun newDecryptCipher'));
    if (legacy.indexOf('try {') > legacy.indexOf('val record = legacyRecord')) errors.push('legacy parsing outside classification');
    if (!legacy.includes('finally { hybridBytes?.fill(0) }')) errors.push('hybrid DEK survives failure');
    return errors;
}
function legacyIosDefects(source: string) {
    const read = source.slice(source.indexOf('AsyncFunction("getLegacyItemAsync")'), source.indexOf('AsyncFunction("signDeviceDigestAsync")'));
    return /if status == errSecAuthFailed \{ throw seedError\("ERR_SEED_UNRECOVERABLE"/.test(read) ? [] : ['legacy invalidated key misclassified'];
}
function unlockDefects(source: string) {
    const initialized = source.indexOf('await onWalletUnlocked(biometricAction)');
    const guard = source.indexOf('assertBiometricAction(biometricAction)', initialized);
    const unlocked = source.indexOf('setAuthenticated(true)', initialized);
    return initialized >= 0 && guard > initialized && unlocked > guard ? [] : ['late revoked unlock allowed'];
}
describe('native authentication contract',()=>{
    it('Android authenticates trusted fresh root, wipes ended grants, keeps referenced keys and classifies legacy failures',()=>{
        expect(androidDefects(android)).toEqual([]);
        expect(android).toContain('setInvalidatedByBiometricEnrollment(false)');
        expect(android).toContain('KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL');
        expect(android).toContain('if (!first)'); // A NEW action never uses API24–29’s previous OS window.
    });
    it('RED controls detect unsigned roots, adopted old DEKs, retained action buffers and premature alias deletion',()=>{
        const unsafe=android.replace('authenticateRootRecord(root)','trustRoot(root)').replace('authenticateRootRecord(staged)','trustRoot(staged)')
            .replace('rootMac(record, true)','unsigned(record)').replace('a.keys.values.forEach { it.fill(0) }','')
            .replace('alias != null && !referenced','alias != null') + '\nroot = sealedRecord(existing, dataKey)';
        expect(androidDefects(unsafe)).toEqual(expect.arrayContaining(['untrusted wrapping accepted','fresh wrapping persisted unsigned','unsigned legacy DEK adopted','action DEKs survive end','shared key deleted with one slot']));
    });
    it('older Android primes only time-bound legacy DEKs before returning to asynchronous action work', () => {
        const begin = android.slice(android.indexOf('private suspend fun beginAction'), android.indexOf('private fun primeTimeBoundLegacyKeys'));
        const prime = android.slice(android.indexOf('private fun primeTimeBoundLegacyKeys'), android.indexOf('override fun definition'));
        const safe = (b: string, p: string) => b.indexOf('primeTimeBoundLegacyKeys(id)') < b.indexOf('return id') && b.includes('primeTimeBoundLegacyKeys(id)')
            && p.includes('if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return') && p.includes('record.optInt("v") != FORMAT_VERSION')
            && p.includes('keepKey(id, record, dataKey.copyOf())') && p.includes('finally { dataKey?.fill(0) }') && !p.includes('authenticate(');
        expect(safe(begin, prime)).toBe(true);
        expect(safe(begin.replace('primeTimeBoundLegacyKeys(id)', ''), prime)).toBe(false);
        expect(safe(begin, prime + '\nauthenticate(prompt)')).toBe(false);
    });
    it('legacy enrollment failure remains stable/unreadable after successful action authentication', () => {
        expect(legacyIosDefects(ios)).toEqual([]);
        expect(legacyIosDefects(ios.replace('if status == errSecAuthFailed { throw seedError("ERR_SEED_UNRECOVERABLE", "Legacy seed authentication key is no longer usable") }', ''))).toEqual(['legacy invalidated key misclassified']);
    });
    it('unlock cannot overwrite a background lock after late key initialization', () => {
        const source = readFileSync(resolve(__dirname, '../../screens/Security/WalletLockScreen.tsx'), 'utf8');
        expect(unlockDefects(source)).toEqual([]);
        const unsafe = source.replace(/assertBiometricAction\(biometricAction\);/g, '');
        expect(unlockDefects(unsafe)).toEqual(['late revoked unlock allowed']);
    });
    it('iOS keeps the existing user-presence ACL, reuses only the passed context, and prohibits reads from opening UI',()=>{
        expect(ios).toContain('.userPresence');
        expect(ios).toContain('context.touchIDAuthenticationAllowableReuseDuration = 0');
        expect(ios).toContain('context.interactionNotAllowed = true');
        expect(ios).toContain('kSecUseAuthenticationContext as String: context');
        expect(ios).toContain('OnAppEntersBackground');
        expect(ios).toContain('case errSecAuthFailed:');
        expect(ios).toContain('ERR_SEED_UNRECOVERABLE');
    });
});
/** Same threat boundary as Keystore: nonexportable RSA private key + device MAC key. */
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const integrityKey=randomBytes(32);
const wrap=(dek:Buffer)=>publicEncrypt({key:publicKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},dek);
const unwrap=(wrapped:Buffer)=>privateDecrypt({key:privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},wrapped);
const mac=(wrapped:Buffer)=>createHmac('sha256',integrityKey).update('provian.action.root.v1:2:protected-alias:').update(wrapped.toString('base64')).digest();
const seal=(key:Buffer,text:string)=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);return {iv,ct:Buffer.concat([c.update(text),c.final()]),tag:c.getAuthTag()};};
const open=(key:Buffer,sealed:ReturnType<typeof seal>)=>{const c=createDecipheriv('aes-256-gcm',key,sealed.iv);c.setAuthTag(sealed.tag);return Buffer.concat([c.update(sealed.ct),c.final()]).toString();};
describe('Android chosen-DEK attack and authenticated migration model',()=>{
    it('RED: hardware authentication alone happily unwraps an attacker-chosen DEK, and exposes future seed writes',()=>{
        const known=randomBytes(32),poisoned=wrap(known);
        expect(open(known,seal(unwrap(poisoned),'newly imported mnemonic'))).toBe('newly imported mnemonic');
    });
    it('GREEN: tampered wrapping fails device binding; a freshly generated authenticated root protects incoming seed and retains old records',()=>{
        const fresh=randomBytes(32),original=wrap(fresh),tag=mac(original),known=randomBytes(32),poisoned=wrap(known);
        expect(timingSafeEqual(tag,mac(poisoned))).toBe(false);
        expect(timingSafeEqual(tag,mac(original))).toBe(true);
        const old=seal(randomBytes(32),'old protected wallet'),oldBytes=Buffer.from(old.ct);
        const seed=seal(unwrap(original),'newly imported mnemonic');
        expect(open(fresh,seed)).toBe('newly imported mnemonic');
        expect(()=>open(known,seed)).toThrow();
        expect(old.ct.equals(oldBytes)).toBe(true);
    });
    it('time-bound legacy DEK priming survives network delay, ends with the action, and a later action prompts anew', () => {
        let prompts = 0, now = 0, deadline = 0;
        const old = wrap(randomBytes(32)), cache = new Map<string, Buffer>();
        const start = () => { prompts++; deadline = now + 10; cache.set('old', unwrap(old)); };
        const lateRead = () => { if (!cache.has('old')) { if (now > deadline) throw new Error('credential Activity required'); cache.set('old', unwrap(old)); } return cache.get('old')!; };
        start(); now = 60;
        expect(lateRead()).toHaveLength(32); expect(prompts).toBe(1);
        const retained = lateRead(); cache.forEach(key => key.fill(0)); cache.clear();
        expect(retained).toEqual(Buffer.alloc(32));
        expect(lateRead).toThrow('credential Activity required'); // RED without this action's priming
        start(); expect(lateRead()).toHaveLength(32); expect(prompts).toBe(2);
    });
    it('one first-root approval plus one per independently protected legacy key, then none for repeated reads in that action',()=>{
        let prompts=0;const cache=new Map<string,Buffer>();
        const read=(id:string,wk:Buffer)=>{if(!cache.has(id)){prompts++;cache.set(id,unwrap(wk));}return cache.get(id)!;};
        const root=wrap(randomBytes(32)),legacy=wrap(randomBytes(32));
        read('root',root);read('legacy',legacy);read('legacy',legacy);read('root',root);expect(prompts).toBe(2);
        cache.forEach(key=>key.fill(0));cache.clear();read('root',root);expect(prompts).toBe(3);
    });
});

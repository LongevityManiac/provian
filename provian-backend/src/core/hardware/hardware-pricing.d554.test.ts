import {hardwarePricingLift,ordinaryHardwareAttestationTier,type HardwareAdmission} from './admit';
import {HARDWARE_SCHEMES} from './roots';
describe(' App Attest-only hardware prices',()=>{
 it('RED the old admitted-any-scheme predicate lifts TPM/cloud; the current policy records them without a lift',()=>{
  expect(HARDWARE_SCHEMES.length).toBeGreaterThan(1);
  for(const scheme of HARDWARE_SCHEMES){
   const admitted:HardwareAdmission={present:true,admitted:true,verdict:{admitted:true,scheme,reason:'verified',fields:null}};
   expect(admitted.admitted).toBe(true); // the prior lift predicate: RED on every non-Apple verified report
   expect(hardwarePricingLift(admitted)).toBe(scheme==='apple_app_attest');
   expect(hardwarePricingLift({...admitted,admitted:false})).toBe(false);
  }
 });
 it('RED registration/hardware tier strings formerly carried premiums; every non-App hardware tier normalizes to software',()=>{
  for(const tier of ['hardware','hardware_tpm','hardware_full','hardware_partial','compute_tee','full_stack']){expect(tier).not.toBe('software');expect(ordinaryHardwareAttestationTier(tier)).toBe('software');}
  for(const tier of ['software','software_verified','corroborated','social'])expect(ordinaryHardwareAttestationTier(tier)).toBe(tier);
 });
});

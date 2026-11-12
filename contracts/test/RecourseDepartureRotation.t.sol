// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../test/RecourseStandingConsent.t.sol";
import "../test/helpers/SlhTestSigner.sol";

contract RecourseDepartureRotationReviewTest is RecourseStandingConsentTest, SlhTestSigner {
    function testRetainedSuspendedDepartureMustSurviveAnOrdinarySpendingKeyRotation() public {
        bytes memory publicKey=slhPublic(1);
        ProvianHashAccount account=new ProvianHashAccount(sha256(publicKey));
        host.setReady(false);host.setConsent(ID,1,1,true);host.requireRecovery(ID);host.setMonth(105);
        host.importState(9,abi.encode(ID,RecourseAddressConsentState.StandingMandate(100,100,100,100,0,1,
            sha256(abi.encodePacked(EXIT)),sha256("salt"),true)));
        host.setReady(true);host.bind(ID,address(account));
        RecourseAddressConsent.ConsentAuthorization memory c=RecourseAddressConsent.ConsentAuthorization(
            ID,address(account),1,false,1,sha256("rule"),0);
        bytes32 digest=consent.authenticatedDepartureDigest(c);
        (,bytes memory signature)=slhSign(1,account.membershipDepartureDigest(digest));
        bytes memory proof=abi.encodePacked(publicKey,signature);
        assertEq(account.isValidMembershipDepartureSignature(digest,proof),bytes4(0x1626ba7e));
        assertEq(account.isValidSignature(digest,proof),bytes4(0xffffffff));
        ProvianHashAccount replacement=new ProvianHashAccount(sha256(publicKey));
        assertEq(replacement.isValidMembershipDepartureSignature(digest,proof),bytes4(0xffffffff));
        // The owner continues using their wallet while the departure sponsor
        // is delayed. A normal wallet transaction rotates only its spending key.
        address target=address(0x123456);vm.etch(target,hex"00");
        bytes32 nextRoot=sha256("next spending root TEST ONLY");
        (,bytes memory spendingSignature)=slhSign(1,account.intentDigest(target,0,100000,hex"",nextRoot));
        assertTrue(account.execute(target,0,100000,hex"",nextRoot,publicKey,spendingSignature));
        (uint256 nonce,,bool joined)=host.addressConsent(ID);assertEq(nonce,1);assertTrue(joined);
        assertEq(account.departureKeyCommitment(),sha256(publicKey));
        assertEq(account.isValidSignature(digest,proof),bytes4(0xffffffff));
        // The dedicated proof cannot join/renew or survive owner-account change.
        host.setMonth(101);
        RecourseStandingConsent.StandingAuthorization memory admission;
        admission.consent=abi.decode(abi.encode(c),(RecourseAddressConsent.ConsentAuthorization));admission.consent.joined=true;
        admission.consent.ruleHash=host.monthlyRule(101).signedRuleHash;admission.consent.expiresAt=block.timestamp+300;
        admission.fixedChargePayer=true;admission.burnLimit=100;admission.reserveLimit=100;admission.earningsBpsLimit=100;
        admission.exitCommitment=sha256("new exit TEST ONLY");admission.exitSalt=sha256("new salt TEST ONLY");
        (uint8 v,bytes32 r,bytes32 sigs)=vm.sign(ATTESTOR,consent.standingConsentDigest(admission));
        vm.expectRevert();consent.setStandingConsent(admission,proof,abi.encodePacked(r,sigs,v));
        host.bind(ID,address(replacement));vm.expectRevert();consent.leaveSuspendedMembership(c,proof);host.bind(ID,address(account));
        c.nonce=2;vm.expectRevert();consent.leaveSuspendedMembership(c,proof);c.nonce=1;
        // Required one-action behavior: the retained departure can still finish
        // without another biometric action or renewing monetary consent.
        consent.leaveSuspendedMembership(c,proof);
        (,,joined)=host.addressConsent(ID);assertFalse(joined);
        vm.expectRevert();consent.leaveSuspendedMembership(c,proof);
    }
}

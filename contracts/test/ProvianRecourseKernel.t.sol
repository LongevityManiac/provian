// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ProvianHashAccount} from "../src/ProvianHashAccount.sol";
import {ProvianRecourseEligibilityVerifier} from "../src/ProvianRecourseEligibilityVerifier.sol";
import {RecourseMonthlyAccounting} from "../src/RecourseMonthlyAccounting.sol";
import {RecoursePoolHistory} from "../src/RecoursePoolHistory.sol";
import {ProvianMemberRecoursePool} from "../src/ProvianMemberRecoursePool.sol";
import {ProvianPVT9} from "../src/ProvianPVT9.sol";
import {MockPVT9Verifier} from "./ProvianPVT9TestBase.sol";
import {SlhTestSigner} from "./helpers/SlhTestSigner.sol";
import {ProvianRecourseKernel} from "../src/ProvianRecourseKernel.sol";
import {ProvianBreakRecoveryHistory} from "../src/ProvianBreakRecoveryHistory.sol";
import {ProvianRecoveryHistory} from "../src/ProvianRecoveryHistory.sol";
import {ProvianProtocolPointer} from "../src/ProvianProtocolPointer.sol";
import {ProvianRestorationAuthorization} from "../src/ProvianRestorationAuthorization.sol";
import {RecourseOwnerAuthorization} from "../src/RecourseOwnerAuthorization.sol";
contract BreakInstitutionFixture {
    address public pvt;
    function setToken(address token) external { pvt = token; }
}

contract ProvianRecourseKernelTest is SlhTestSigner {
    address constant ADMIN = 0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3;
    address constant THIEF = address(0x777);
    address constant DESTINATION = address(0x888);
    bytes32 constant ID = bytes32(uint256(1));
    ProvianRecourseKernel kernel;
    ProvianRestorationAuthorization authorization;
    ProvianProtocolPointer pointer;
    RecourseOwnerAuthorization.OwnerProof proof;
    bytes32 signedOperation;
    mapping(bytes32 => bool) private evidence;
    function ownerOf(address account) external pure returns (bytes32) { return account == THIEF ? ID : bytes32(0); }
    function identityAttestor() external pure returns (address) { return address(0xE); }
    function bindRecovered(bytes32 identity, address account) external view {
        require(ProvianRestorationAuthorization(msg.sender).recoveredDestination(identity) == account, "recovery_required");
    }
    function consumeTheftEvidence(bytes32 operation, uint256) external returns (bytes32) {
        require(msg.sender == address(authorization) && evidence[operation], "evidence_required");
        evidence[operation] = false;
        return operation;
    }
    function deployKernel(ProvianRecourseKernel.SuccessionConfig memory config) external returns (ProvianRecourseKernel) {
        if (config.afterCryptographicBreak) {
            ProvianRecoveryHistory.State memory source = config.history.state();
            ProvianBreakRecoveryHistory.TreasuryRecovery[] memory recoveries = new ProvianBreakRecoveryHistory.TreasuryRecovery[](2);
            recoveries[0] = ProvianBreakRecoveryHistory.TreasuryRecovery(source.provianTreasury, new ProvianHashAccount(sha256("company TEST ONLY")));
            recoveries[1] = ProvianBreakRecoveryHistory.TreasuryRecovery(source.foundationTreasury, new ProvianHashAccount(sha256("foundation TEST ONLY")));
            config.history = new ProvianBreakRecoveryHistory(config.previousKernel, config.snapshotBlock, config.history.root(), 0, source, recoveries);
        }
        vm.mockCall(config.registry, abi.encodeWithSignature("afterCryptographicBreak()"), abi.encode(config.afterCryptographicBreak));
        if (config.previousKernel == address(0x1234) || config.previousKernel == address(0x4567)) vm.mockCall(config.previousKernel, abi.encodeWithSignature("BOOTSTRAP_ADMIN()"), abi.encode(ADMIN));
        uint256 pending;
        if (!config.afterCryptographicBreak && config.previousKernel != address(0x1234) && config.previousKernel != address(0x4567)) {
            ProvianRestorationAuthorization prior = ProvianRecourseKernel(config.previousKernel).ownerAuthorization();
            if (prior.breakOrigin() != address(0)) pending = config.snapshotTotal - ProvianRecourseKernel(config.previousKernel).totalSupply();
        }
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        config.authorization = new ProvianRestorationAuthorization(predicted, config.root, config.previousKernel,
            config.snapshotBlock, config.afterCryptographicBreak, keccak256(type(ProvianHashAccount).runtimeCode), pending);
        return new ProvianRecourseKernel(config);
    }
    function setUp() public {
        pointer = new ProvianProtocolPointer(address(new ProvianHashAccount(sha256("pointer signing root TEST ONLY"))));
        ProvianRecoveryHistory.State memory prior;
        prior.provianTreasury = address(0xA001); prior.foundationTreasury = address(0xA002);
        prior.eligibilityVerifier = ProvianPVT9.VerifierConfig(address(0xB001), keccak256("verifier TEST ONLY"), 1);
        prior.beneficiaryVerifier = ProvianPVT9.VerifierConfig(address(0xB002), keccak256("verifier TEST ONLY"), 1);
        vm.mockCall(address(0x1234), abi.encodeWithSignature("administrativeHold()"), abi.encode(true));
        vm.mockCall(address(0x1234), abi.encodeWithSignature("operationalMinter()"), abi.encode(address(0)));
        vm.mockCall(address(0xB001), abi.encodeWithSignature("administrativeHold()"), abi.encode(true));
        vm.mockCall(address(0xB001), abi.encodeWithSignature("batchApprover()"), abi.encode(address(0)));

        prior.epochZeroStartsAt = 1; prior.genesisStartsAt = 1; prior.genesisEndsAt = 100;
        prior.mintRate = 1 ether; prior.agentFoundationBps = 100;
        prior.genesisCap = 7_500_000 ether; prior.combinedCap = 10_000_000 ether;
        ProvianRecoveryHistory history = new ProvianRecoveryHistory(address(0x1234), 100, bytes32(uint256(1)), 0, prior);
        bytes32 root = sha256(abi.encode("Provian balance succession", address(0x1234), uint256(100), THIEF, THIEF, uint256(123 ether)));
        kernel = this.deployKernel(ProvianRecourseKernel.SuccessionConfig(ADMIN, root, address(0x1234), 100, 123 ether, history, pointer, address(this), false, ProvianRestorationAuthorization(address(0))));
        authorization = kernel.ownerAuthorization();
        authorization.importBalance(THIEF, THIEF, 123 ether, new bytes32[](0));
        address[10] memory targets; bytes32[10] memory hashes;
        targets[0] = address(kernel); hashes[0] = address(kernel).codehash;
        for (uint256 i = 1; i < 10; ++i) { targets[i] = address(uint160(100+i)); vm.etch(targets[i], hex"00"); hashes[i] = targets[i].codehash; }
        ProvianMemberRecoursePool initialPool = new ProvianMemberRecoursePool(ProvianPVT9(address(kernel)), address(this), address(this), pointer,
            RecourseMonthlyAccounting.MonthlyRule(0, 100 ether, 100 ether, 100, sha256("signed membership rule TEST ONLY")),
            RecoursePoolHistory.PoolSnapshot(address(0), 0, bytes32(0), 0, false));
        targets[8] = address(initialPool); hashes[8] = targets[8].codehash;
        targets[9] = address(initialPool.settlement()); hashes[9] = targets[9].codehash;
        vm.prank(pointer.authority()); pointer.publish(0, targets, hashes);
        vm.mockCall(targets[8], abi.encodeWithSignature("determined(bytes32)", bytes32(uint256(1))), abi.encode(false));
        proof.publicKey = slhPublic(1);
        proof.recoverySecret = sha256("recovery TEST ONLY");
        proof.signingRoot = sha256(proof.publicKey);
        proof.nextCommitment = sha256("next recovery TEST ONLY"); proof.nextSigningRoot = sha256("next root TEST ONLY");
        kernel.bindRestorationOwner(ID, sha256(abi.encodePacked(proof.recoverySecret, proof.signingRoot)), proof.signingRoot);
    }
    function scopedReversalHash(ProvianRestorationAuthorization.RestorationIntent memory intent,
        ProvianRestorationAuthorization.Reversal memory r) private pure returns(bytes32) {
        return sha256(abi.encode("Provian scoped theft reversal",sha256(abi.encode("Provian bounded restoration intent",intent)),r));
    }
    function reversal(uint256 amount) private pure returns (ProvianRestorationAuthorization.Reversal memory r) {
        r.request = bytes32(uint256(1)); r.identity = ID; r.destination = DESTINATION;
        r.sources = new address[](1); r.sources[0] = THIEF;
        r.amounts = new uint256[](1); r.amounts[0] = amount;
        r.sourceSequences = new uint256[](1);
        r.observationAccounts = new address[](1); r.observationAccounts[0] = THIEF;
        r.observationSequences = new uint256[](1);
        r.poolShortfall = 123 ether - amount; r.evidenceHash = sha256("canonical witnessed loss TEST ONLY");
    }
    function sign(ProvianRestorationAuthorization.Reversal memory r) private {
        signedOperation = sha256(abi.encode("Provian theft reversal",r));
        evidence[signedOperation] = true;
        bytes32 digest = authorization.ownerAuthorizationDigest(ID, signedOperation, proof.nextCommitment, proof.nextSigningRoot);
        (, proof.signature) = slhSign(1, digest);
    }
    function execute(ProvianRestorationAuthorization.Reversal memory r) private {
        authorization.execute(ID, signedOperation, proof, abi.encode(uint8(0), abi.encode(r, uint256(1))));
    }
    function authorizeIntent(uint256 maximumLoss) private returns (ProvianRestorationAuthorization.RestorationIntent memory intent) {
        intent = ProvianRestorationAuthorization.RestorationIntent(bytes32(uint256(1)), ID, DESTINATION,
            sha256("verified loss snapshot TEST ONLY"), maximumLoss);
        bytes32 operation = sha256(abi.encode("Provian bounded restoration intent",intent));
        (, proof.signature) = slhSign(1, authorization.ownerAuthorizationDigest(ID, operation, proof.nextCommitment, proof.nextSigningRoot));
        vm.prank(ADMIN);
        authorization.execute(ID, operation, proof, abi.encode(uint8(3), abi.encode(intent, uint256(1))));
    }
    function testAnyGasSponsorCanRegisterExactOwnerIntentButCannotReverseIt() public {
        ProvianRestorationAuthorization.RestorationIntent memory intent = ProvianRestorationAuthorization.RestorationIntent(
            bytes32(uint256(1)),ID,DESTINATION,sha256("loss TEST ONLY"),123 ether);
        bytes32 operation = sha256(abi.encode("Provian bounded restoration intent",intent));
        (,proof.signature)=slhSign(1,authorization.ownerAuthorizationDigest(ID,operation,proof.nextCommitment,proof.nextSigningRoot));
        vm.prank(address(0xCAFE)); authorization.execute(ID,operation,proof,abi.encode(uint8(3),abi.encode(intent,uint256(1))));
        assertEq(authorization.recoveredDestination(ID),DESTINATION);
        assertEq(kernel.balanceOf(THIEF),123 ether); assertEq(kernel.balanceOf(DESTINATION),0);
        ProvianRestorationAuthorization.Reversal memory r=reversal(100 ether);
        evidence[scopedReversalHash(intent,r)]=true;
        vm.prank(address(0xCAFE)); vm.expectRevert(RecourseOwnerAuthorization.InvalidOwnerAuthorization.selector);
        authorization.executeRestorationIntent(r,1);
        vm.prank(ADMIN); authorization.executeRestorationIntent(r,1);
        assertEq(kernel.balanceOf(DESTINATION),100 ether);
    }
    function poolReversal(uint256 amount) private returns (ProvianRestorationAuthorization.Reversal memory r) {
        address pool = pointer.component(8);
        vm.prank(THIEF); kernel.transfer(pool, 10 ether);
        r = reversal(amount);
        r.sources[0] = pool;
        r.observationAccounts[0] = pool;
        vm.mockCall(pool, abi.encodeWithSignature("accountedBacking()"), abi.encode(5 ether));
        vm.mockCall(pool, abi.encodeWithSignature("allocatedRestorations()"), abi.encode(3 ether));
    }
    function testReversalProtectsContributionsAndAllocatedAwardsButReachesUnallocatedDonation() public {
        ProvianRestorationAuthorization.Reversal memory r = poolReversal(3 ether);
        sign(r);
        vm.prank(ADMIN); vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector); execute(r);
        assertEq(kernel.balanceOf(pointer.component(8)), 10 ether);
        assertEq(authorization.ownerAuthorizationNonce(ID), 0);
        assertTrue(evidence[signedOperation]);
        r.amounts[0] = 2 ether;
        sign(r);
        vm.prank(ADMIN); execute(r);
        assertEq(kernel.balanceOf(pointer.component(8)), 8 ether);
        assertEq(kernel.balanceOf(DESTINATION), 2 ether);
        assertEq(kernel.totalSupply(), 123 ether);
    }
    function testReversalRechecksNewPoolObligationsAfterOwnerProofWithoutOutgoingTransfer() public {
        ProvianRestorationAuthorization.Reversal memory r = poolReversal(2 ether);
        sign(r);
        address pool = pointer.component(8);
        vm.mockCall(pool, abi.encodeWithSignature("allocatedRestorations()"), abi.encode(4 ether));
        assertEq(kernel.outgoingSequence(pool), 0);
        vm.prank(ADMIN); vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector); execute(r);
        assertEq(kernel.balanceOf(pool), 10 ether);
        assertEq(authorization.ownerAuthorizationNonce(ID), 0);
    }
    function testRepeatedPoolSourceCannotSpendTheSameUnencumberedSurplusTwice() public {
        ProvianRestorationAuthorization.Reversal memory r = poolReversal(2 ether);
        r.sources = new address[](2); r.amounts = new uint256[](2); r.sourceSequences = new uint256[](2);
        for (uint256 i; i < 2; ++i) { r.sources[i] = pointer.component(8); r.amounts[i] = 2 ether; }
        sign(r);
        vm.prank(ADMIN); vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector); execute(r);
        assertEq(kernel.balanceOf(pointer.component(8)), 10 ether);
        assertEq(authorization.ownerAuthorizationNonce(ID), 0);
    }
    function assertInstitutionFloor(uint256 slot) private {
        address institution = pointer.component(slot);
        vm.mockCall(institution, abi.encodeWithSignature("pvt()"), abi.encode(address(kernel)));
        vm.mockCall(institution, abi.encodeWithSignature("encumberedPVT()"), abi.encode(8 ether));
        vm.prank(THIEF); kernel.transfer(institution, 10 ether);
        ProvianRestorationAuthorization.Reversal memory r = reversal(3 ether);
        r.sources[0] = institution; r.observationAccounts[0] = institution;
        sign(r);
        vm.prank(ADMIN); vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector); execute(r);
        assertEq(authorization.ownerAuthorizationNonce(ID), 0);
        r.amounts[0] = 2 ether;
        sign(r);
        vm.mockCall(institution, abi.encodeWithSignature("encumberedPVT()"), abi.encode(9 ether));
        vm.prank(ADMIN); vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector); execute(r);
        vm.mockCall(institution, abi.encodeWithSignature("encumberedPVT()"), abi.encode(8 ether));
        r.sources = new address[](2); r.amounts = new uint256[](2); r.sourceSequences = new uint256[](2);
        for (uint256 i; i < 2; ++i) { r.sources[i] = institution; r.amounts[i] = 2 ether; }
        sign(r);
        vm.prank(ADMIN); vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector); execute(r);
        assertEq(kernel.balanceOf(institution), 10 ether);
        r.sources = new address[](1); r.amounts = new uint256[](1); r.sourceSequences = new uint256[](1);
        r.sources[0] = institution; r.amounts[0] = 2 ether;
        sign(r); vm.prank(ADMIN); execute(r);
        assertEq(kernel.balanceOf(institution), 8 ether);
        assertEq(kernel.balanceOf(DESTINATION), 2 ether);
        assertEq(kernel.totalSupply(), 123 ether);
    }
    function testEscrowObligationsProtectedAndDonationReversible() public { assertInstitutionFloor(3); }
    function testProjectPoolObligationsProtectedAndDonationReversible() public { assertInstitutionFloor(5); }
    function testBondObligationsProtectedAndDonationReversible() public { assertInstitutionFloor(6); }
    function testCourtObligationsProtectedAndDonationReversible() public { assertInstitutionFloor(7); }
    function testBoundedIntentNeedsIndependentExactEvidenceAndExecutesOnceWithoutAnotherOwnerProof() public {
        ProvianRestorationAuthorization.RestorationIntent memory intent = authorizeIntent(123 ether);
        assertEq(authorization.ownerAuthorizationNonce(ID), 1);
        ProvianRestorationAuthorization.Reversal memory r = reversal(100 ether);
        bytes32 operation = scopedReversalHash(intent, r);
        vm.prank(ADMIN); vm.expectRevert("evidence_required"); authorization.executeRestorationIntent(r, 1);
        evidence[operation] = true;
        vm.expectRevert(RecourseOwnerAuthorization.InvalidOwnerAuthorization.selector); authorization.executeRestorationIntent(r, 1);
        vm.prank(ADMIN); authorization.executeRestorationIntent(r, 1);
        assertEq(kernel.totalSupply(), 123 ether); assertEq(kernel.balanceOf(DESTINATION), 100 ether);
        assertEq(authorization.ownerAuthorizationNonce(ID), 1);
        vm.prank(ADMIN); vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector); authorization.executeRestorationIntent(r, 1);
    }
    function testBoundedIntentCannotChangeDestinationOccurrenceIdentityOrLossCeiling() public {
        ProvianRestorationAuthorization.RestorationIntent memory intent = authorizeIntent(122 ether);
        ProvianRestorationAuthorization.Reversal memory r = reversal(100 ether);
        evidence[scopedReversalHash(intent,r)] = true;
        vm.prank(ADMIN); vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector); authorization.executeRestorationIntent(r,1);
        r.poolShortfall = 22 ether; r.destination = address(0x999);
        vm.prank(ADMIN); vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector); authorization.executeRestorationIntent(r,1);
        r.destination = DESTINATION; r.request = sha256("another occurrence TEST ONLY");
        vm.prank(ADMIN); vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector); authorization.executeRestorationIntent(r,1);
        r.request = intent.request; r.identity = sha256("another identity TEST ONLY");
        vm.prank(ADMIN); vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector); authorization.executeRestorationIntent(r,1);
        assertEq(kernel.balanceOf(THIEF),123 ether);assertEq(kernel.totalSupply(),123 ether);
    }
    function testPendingRestorationFollowsLaterIndependentOwnerRecoveryWithoutRepeatingLossProof() public {
        bytes32 secondSecret=sha256("second owner secret TEST ONLY");
        proof.nextSigningRoot=sha256(slhPublic(2));
        proof.nextCommitment=sha256(abi.encodePacked(secondSecret,proof.nextSigningRoot));
        ProvianRestorationAuthorization.RestorationIntent memory intent=authorizeIntent(123 ether);
        address latest=address(0x999);
        bytes32 operation=sha256(abi.encode("Provian ownership recovery",ID,latest));
        proof.recoverySecret=secondSecret;proof.publicKey=slhPublic(2);proof.signingRoot=sha256(proof.publicKey);
        proof.nextSigningRoot=sha256(slhPublic(3));proof.nextCommitment=sha256("third owner commitment TEST ONLY");
        (,proof.signature)=slhSign(2,authorization.ownerAuthorizationDigest(ID,operation,proof.nextCommitment,proof.nextSigningRoot));
        authorization.execute(ID,operation,proof,abi.encode(uint8(2),abi.encode(ID,latest,uint256(1))));
        ProvianRestorationAuthorization.Reversal memory r=reversal(100 ether);
        evidence[scopedReversalHash(intent,r)]=true;
        vm.prank(ADMIN);vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);
        authorization.executeRestorationIntent(r,1);
        r.destination=latest;
        vm.prank(ADMIN);vm.expectRevert("evidence_required");authorization.executeRestorationIntent(r,1);
        evidence[scopedReversalHash(intent,r)]=true;
        vm.prank(ADMIN);authorization.executeRestorationIntent(r,1);
        assertEq(kernel.balanceOf(latest),100 ether);assertEq(kernel.balanceOf(DESTINATION),0);
        assertEq(kernel.totalSupply(),123 ether);assertEq(authorization.ownerAuthorizationNonce(ID),2);
        assertEq(authorization.restorationIntent(intent.request).destination,DESTINATION);
    }
    function testBoundedIntentAllowsRefreshedSourcesButNeverReusesStaleAttestation() public {
        ProvianRestorationAuthorization.RestorationIntent memory intent = authorizeIntent(123 ether);
        ProvianRestorationAuthorization.Reversal memory r = reversal(100 ether);
        evidence[scopedReversalHash(intent,r)] = true;
        vm.prank(THIEF);kernel.transfer(address(0xAABB),1 ether);
        vm.prank(ADMIN);vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);authorization.executeRestorationIntent(r,1);
        r.sourceSequences[0]=1; r.observationSequences[0]=1;
        vm.prank(ADMIN);vm.expectRevert("evidence_required");authorization.executeRestorationIntent(r,1);
        evidence[scopedReversalHash(intent,r)] = true;
        vm.prank(ADMIN);authorization.executeRestorationIntent(r,1);
        assertEq(authorization.ownerAuthorizationNonce(ID),1);assertEq(kernel.balanceOf(DESTINATION),100 ether);
    }
    function testProtectedTrailReturnInvalidatesShortfallEvenWithNoReversalSources() public {
        ProvianRestorationAuthorization.RestorationIntent memory intent = authorizeIntent(123 ether);
        ProvianRestorationAuthorization.Reversal memory r = reversal(0);
        r.sources = new address[](0); r.amounts = new uint256[](0); r.sourceSequences = new uint256[](0);
        evidence[scopedReversalHash(intent,r)] = true;
        vm.prank(THIEF); kernel.transfer(DESTINATION,123 ether);
        vm.prank(ADMIN); vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);
        authorization.executeRestorationIntent(r,1);
        assertFalse(authorization.reversalExecuted(r.request));
        // Fresh evidence observes the return and authorizes no additional PVT.
        r.observationSequences[0]=1; r.poolShortfall=0;
        vm.prank(ADMIN); vm.expectRevert("evidence_required"); authorization.executeRestorationIntent(r,1);
        evidence[scopedReversalHash(intent,r)] = true;
        vm.prank(ADMIN); authorization.executeRestorationIntent(r,1);
        assertEq(kernel.balanceOf(DESTINATION),123 ether); assertEq(kernel.totalSupply(),123 ether);
    }
    function testFinalPoolDeterminationCannotBeReopenedThroughOwnerTicket() public {
        ProvianRestorationAuthorization.RestorationIntent memory intent = authorizeIntent(123 ether);
        ProvianRestorationAuthorization.Reversal memory r = reversal(100 ether);
        evidence[scopedReversalHash(intent,r)] = true;
        vm.mockCall(pointer.component(8), abi.encodeWithSignature("determined(bytes32)",r.request),abi.encode(true));
        vm.prank(ADMIN);vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);authorization.executeRestorationIntent(r,1);
        assertEq(kernel.balanceOf(THIEF),123 ether);assertFalse(authorization.reversalExecuted(r.request));
        assertTrue(evidence[scopedReversalHash(intent,r)]);
    }
    function testReturnedLossCanFinalizeWithoutMovingOrCreatingAnyTokens() public {
        ProvianRestorationAuthorization.RestorationIntent memory intent = authorizeIntent(123 ether);
        ProvianRestorationAuthorization.Reversal memory r = reversal(0);
        r.sources=new address[](0);r.amounts=new uint256[](0);r.sourceSequences=new uint256[](0);r.poolShortfall=0;
        evidence[scopedReversalHash(intent,r)]=true;
        vm.prank(ADMIN);authorization.executeRestorationIntent(r,1);
        assertTrue(authorization.reversalExecuted(r.request));assertEq(kernel.totalSupply(),123 ether);
        assertEq(kernel.balanceOf(THIEF),123 ether);assertEq(kernel.balanceOf(DESTINATION),0);
        vm.prank(ADMIN);vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);authorization.executeRestorationIntent(r,1);
    }
    function testAuthorityCannotInvokeRestrictedLedgerWithoutOwnerExecutor() public {
        ProvianRecourseKernel empty = this.deployKernel(ProvianRecourseKernel.SuccessionConfig(
            ADMIN, bytes32(uint256(1)), address(0x1234), 100, 1 ether, kernel.predecessorHistory(), pointer, address(this), false, ProvianRestorationAuthorization(address(0))));
        vm.prank(ADMIN); vm.expectRevert(ProvianRecourseKernel.InvalidRestoration.selector);
        empty.importAuthorizedBalance(DESTINATION, 1 ether);
        address[] memory sources = new address[](1); sources[0] = THIEF;
        uint256[] memory amounts = new uint256[](1); amounts[0] = 1 ether;
        vm.prank(ADMIN); vm.expectRevert(ProvianRecourseKernel.InvalidRestoration.selector);
        kernel.applyAuthorizedReversal(sources, amounts, DESTINATION, 1);
        assertEq(empty.totalSupply(), 0); assertEq(kernel.balanceOf(THIEF), 123 ether);
    }
    function testMigrationAndReversalPreserveSupplyExactlyOnce() public {
        assertEq(kernel.totalSupply(), 123 ether);
        ProvianRestorationAuthorization.Reversal memory r = reversal(100 ether); sign(r);
        vm.prank(ADMIN); execute(r);
        assertEq(kernel.totalSupply(), 123 ether);
        assertEq(kernel.balanceOf(THIEF), 23 ether); assertEq(kernel.balanceOf(DESTINATION), 100 ether);
        vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);
        authorization.importBalance(THIEF, THIEF, 123 ether, new bytes32[](0));
        vm.prank(ADMIN); vm.expectRevert(RecourseOwnerAuthorization.InvalidOwnerAuthorization.selector);
        execute(r);
    }
    function testSuccessorPreservesReversalOutcomeAndRefusesRepeatedRequest() public {
        bytes32 nextSecret = sha256("next owner secret TEST ONLY");
        proof.nextSigningRoot = sha256(slhPublic(2));
        proof.nextCommitment = sha256(abi.encodePacked(nextSecret, proof.nextSigningRoot));
        ProvianRestorationAuthorization.Reversal memory r = reversal(100 ether);
        sign(r); vm.prank(ADMIN); execute(r);
        address nextKernel = address(0xABCD);
        vm.etch(nextKernel, hex"00");
        ProvianRestorationAuthorization next = new ProvianRestorationAuthorization(
            nextKernel, sha256("snapshot TEST ONLY"), address(kernel), block.number, false, bytes32(0), 0);
        assertTrue(next.reversalExecuted(r.request));
        assertEq(next.reversalOutcome(r.request), authorization.reversalOutcome(r.request));
        assertFalse(next.reversalExecuted(bytes32(uint256(999))));
        assertEq(next.reversalOutcome(bytes32(uint256(999))), bytes32(0));
        vm.mockCall(nextKernel, abi.encodeWithSignature("restorationAuthority()"), abi.encode(ADMIN));
        vm.mockCall(nextKernel, abi.encodeWithSignature("protocolPointer()"), abi.encode(address(pointer)));
        (,, address[10] memory targets, bytes32[10] memory hashes) = pointer.current();
        targets[0] = nextKernel; hashes[0] = nextKernel.codehash;
        vm.prank(pointer.authority()); pointer.publish(1, targets, hashes);
        proof.recoverySecret = nextSecret; proof.publicKey = slhPublic(2); proof.signingRoot = sha256(proof.publicKey);
        proof.nextSigningRoot = sha256(slhPublic(3)); proof.nextCommitment = sha256("future owner commitment TEST ONLY");
        (, proof.signature) = slhSign(2, next.ownerAuthorizationDigest(ID, signedOperation, proof.nextCommitment, proof.nextSigningRoot));
        vm.prank(ADMIN); vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);
        next.execute(ID, signedOperation, proof, abi.encode(uint8(0), abi.encode(r, uint256(2))));
        assertEq(next.ownerAuthorizationNonce(ID), 1);
        assertEq(kernel.totalSupply(), 123 ether);
    }
    function testNeitherAuthorityNorOwnerAloneCanReverseAndDestinationCannotChange() public {
        ProvianRestorationAuthorization.Reversal memory r = reversal(100 ether); sign(r);
        vm.expectRevert(RecourseOwnerAuthorization.InvalidOwnerAuthorization.selector); execute(r);
        r.destination = address(0x999);
        vm.prank(ADMIN); vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector); execute(r);
        assertEq(kernel.balanceOf(THIEF), 123 ether); assertEq(kernel.totalSupply(), 123 ether);
    }
    function testDuplicateSourcesCannotOverdrawOrConsumeOwnerAuthorizationOnFailure() public {
        ProvianRestorationAuthorization.Reversal memory r = reversal(100 ether);
        r.sources = new address[](2); r.amounts = new uint256[](2); r.sourceSequences = new uint256[](2);
        r.sources[0] = THIEF; r.sources[1] = THIEF; r.amounts[0] = 100 ether; r.amounts[1] = 100 ether;
        sign(r);
        vm.prank(ADMIN); vm.expectRevert(ProvianRecourseKernel.InsufficientBalance.selector); execute(r);
        assertEq(kernel.totalSupply(), 123 ether); assertEq(kernel.balanceOf(THIEF), 123 ether);
        assertEq(authorization.ownerAuthorizationNonce(ID), 0);
    }
    function testAuthorityWithItsOwnValidProofStillRequiresIndependentEvidence() public {
        ProvianRestorationAuthorization.Reversal memory r = reversal(100 ether); sign(r);
        evidence[signedOperation] = false;
        vm.prank(ADMIN); vm.expectRevert("evidence_required"); execute(r);
        assertEq(kernel.balanceOf(THIEF), 123 ether);
        assertEq(authorization.ownerAuthorizationNonce(ID), 0);
    }
    function testSpentAndReplacedSourceBalanceInvalidatesOldDetermination() public {
        ProvianRestorationAuthorization.Reversal memory r = reversal(100 ether); sign(r);
        vm.prank(THIEF); kernel.transfer(DESTINATION, 100 ether);
        vm.prank(DESTINATION); kernel.transfer(THIEF, 100 ether);
        vm.prank(ADMIN); vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector); execute(r);
        assertEq(kernel.balanceOf(THIEF), 123 ether);
        assertEq(authorization.ownerAuthorizationNonce(ID), 0);
        assertTrue(evidence[signedOperation]);
    }
    function testEntireLossCanReachPoolWithoutAnEmptyReversalMint() public {
        ProvianRestorationAuthorization.Reversal memory r = reversal(0);
        r.sources = new address[](0); r.amounts = new uint256[](0); r.sourceSequences = new uint256[](0);
        sign(r); vm.prank(ADMIN); execute(r);
        assertEq(kernel.totalSupply(), 123 ether); assertEq(kernel.balanceOf(THIEF), 123 ether);
        assertEq(kernel.balanceOf(DESTINATION), 0);
        assertEq(authorization.reversalOutcome(r.request), sha256(abi.encode(r.request, ID, DESTINATION, r.poolShortfall, r.evidenceHash)));
    }
    function testAuthorityIsAppointableAndOrdinaryTransfersRemainPermissionless() public {
        vm.prank(ADMIN); kernel.appointRestorationAuthority(address(0x999));
        assertEq(kernel.restorationAuthority(), address(0x999));
        assertEq(kernel.BOOTSTRAP_ADMIN(), ADMIN);
        vm.prank(THIEF); kernel.transfer(DESTINATION, 1 ether);
        assertEq(kernel.balanceOf(DESTINATION), 1 ether);
        vm.prank(THIEF); vm.expectRevert(ProvianProtocolPointer.StaleRevision.selector);
        kernel.transferCurrent(DESTINATION, 1 ether, 0);
    }
    function testCryptographicBreakUsesSnapshotAndRealHashAuthorityWithOwnerProof() public { restoreAfterBreak(123 ether, false); }
    function testZeroBalanceOwnerRecoversAuthorizationWithoutIssuance() public { restoreAfterBreak(0, false); }
    function testUnclaimedBreakBalanceCanRestoreAfterAnOrdinarySuccession() public { restoreAfterBreak(123 ether, true); }
    function restoreAfterBreak(uint256 amount, bool carry) private {
        bytes memory adminPublic = slhPublic(2);
        ProvianHashAccount admin = new ProvianHashAccount(sha256(adminPublic));
        bytes32 commitment = sha256(abi.encodePacked(proof.recoverySecret, proof.signingRoot));
        bytes32 root = sha256(abi.encode("Provian restoration", address(0x1234), uint256(100), ID, amount, commitment));
        ProvianRecourseKernel successor = this.deployKernel(ProvianRecourseKernel.SuccessionConfig(
            address(admin), root, address(0x1234), 100, amount, kernel.predecessorHistory(), pointer, address(this), true, ProvianRestorationAuthorization(address(0))));
        ProvianRestorationAuthorization auth = successor.ownerAuthorization();
        (,, address[10] memory currentTargets, bytes32[10] memory currentHashes) = pointer.current();
        currentTargets[0] = address(successor); currentHashes[0] = address(successor).codehash;
        vm.prank(pointer.authority()); pointer.publish(1, currentTargets, currentHashes);
        if (carry) {
            // No owner has restored: the ordinary successor retains the pending
            // original snapshot entitlement in addition to current balances.
            ProvianRecoveryHistory h = new ProvianRecoveryHistory(address(successor), 101,
                sha256("empty monetary history TEST ONLY"), 0, successor.predecessorHistory().state());
            successor = this.deployKernel(ProvianRecourseKernel.SuccessionConfig(address(admin),
                sha256("ordinary balances TEST ONLY"),address(successor),101,amount,h,pointer,address(this),false,ProvianRestorationAuthorization(address(0))));
            auth=successor.ownerAuthorization();
            currentTargets[0]=address(successor);currentHashes[0]=address(successor).codehash;
            vm.prank(pointer.authority());pointer.publish(2,currentTargets,currentHashes);
            assertTrue(auth.breakOrigin()!=address(0));
            assertEq(auth.pendingBreakAmount(),amount);
            // Prior break replay import is complete (zero history in this fixture).
            vm.mockCall(auth.previousAuthorization(),abi.encodeWithSignature("reversalHistoryReady()"),abi.encode(true));
            assertTrue(auth.successionReady());
            assertEq(successor.restoredBalance(),0);
        } else {
            vm.expectRevert(RecourseOwnerAuthorization.InvalidOwnerAuthorization.selector);
            successor.bindRestorationOwner(ID, commitment, proof.signingRoot);
        }
        vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);
        auth.registerBreakOwner(ID, amount + 1, proof.recoverySecret, proof.signingRoot, new bytes32[](0));
        auth.registerBreakOwner(ID, amount, proof.recoverySecret, proof.signingRoot, new bytes32[](0));
        assertTrue(auth.snapshotRecoveryPending(ID));
        bytes memory prematureRotation=abi.encode(uint8(2),abi.encode(ID,DESTINATION,uint256(1)));
        bytes32 prematureOperation=sha256("rotation TEST ONLY");
        vm.expectRevert(RecourseOwnerAuthorization.InvalidOwnerAuthorization.selector);
        auth.execute(ID,prematureOperation,proof,prematureRotation);
        bytes32 destinationRoot = sha256("successor owner signing root TEST ONLY");
        ProvianHashAccount destination = new ProvianHashAccount(destinationRoot);
        ProvianRestorationAuthorization.BreakRestoration memory r = ProvianRestorationAuthorization.BreakRestoration(
            ID, amount, commitment, destination, destinationRoot, new bytes32[](0));
        bytes32 operation = sha256(abi.encode("Provian cryptographic break", ID, amount,
            address(destination), destinationRoot, address(0x1234), uint256(100)));
        bytes32 digest = auth.ownerAuthorizationDigest(ID, operation, proof.nextCommitment, proof.nextSigningRoot);
        (, proof.signature) = slhSign(1, digest);
        bytes memory data = abi.encodeCall(auth.execute, (ID, operation, proof, abi.encode(uint8(1), abi.encode(r))));
        uint256 callGas = 5_000_000;
        bytes32 nextAdmin = sha256("next authority TEST ONLY");
        bytes32 adminDigest = admin.intentDigest(address(auth), 0, callGas, data, nextAdmin);
        (, bytes memory adminSignature) = slhSign(2, adminDigest);
        assertTrue(admin.execute(address(auth), 0, callGas, data, nextAdmin, adminPublic, adminSignature));
        assertEq(successor.balanceOf(address(destination)), amount);
        assertEq(successor.totalSupply(), amount);
        assertTrue(auth.restoredIdentity(ID));
        assertFalse(auth.snapshotRecoveryPending(ID));
        vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);
        auth.importBalance(THIEF, THIEF, 123 ether, new bytes32[](0));
    }
    function testBreakInstitutionCustodyIsExactAndCannotRedirectOrReplay() public {
        BreakInstitutionFixture institution = new BreakInstitutionFixture();
        bytes32 codeHash = address(institution).codehash;
        address oldInstitution = address(0xBEEF);
        bytes32 leaf = sha256(abi.encode("Provian institution restoration", address(0x1234), uint256(100),
            oldInstitution, address(institution), uint256(123 ether), codeHash));
        bytes32 countLeaf=sha256(abi.encode("Provian institution restoration count",address(0x1234),uint256(100),uint256(1),uint256(123 ether)));
        bytes32 reversalCount=sha256(abi.encode("Provian reversal history count",address(0x1234),uint256(100),uint256(0)));
        bytes32 pair=leaf<countLeaf?sha256(abi.encodePacked(leaf,countLeaf)):sha256(abi.encodePacked(countLeaf,leaf));
        bytes32 root=pair<reversalCount?sha256(abi.encodePacked(pair,reversalCount)):sha256(abi.encodePacked(reversalCount,pair));
        ProvianHashAccount admin = new ProvianHashAccount(sha256("admin TEST ONLY"));
        ProvianRecourseKernel successor = this.deployKernel(ProvianRecourseKernel.SuccessionConfig(
            address(admin), root, address(0x1234), 100, 123 ether, kernel.predecessorHistory(), pointer,
            address(this), true, ProvianRestorationAuthorization(address(0))));
        ProvianRestorationAuthorization auth = successor.ownerAuthorization();
        bytes32[] memory empty = new bytes32[](2);empty[0]=countLeaf;empty[1]=reversalCount;
        bytes32[] memory counts=new bytes32[](2);counts[0]=leaf;counts[1]=reversalCount;
        bytes32[] memory reversals=new bytes32[](1);reversals[0]=pair;
        assertFalse(auth.successionReady());
        vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);
        auth.commitInstitutionHistory(0,123 ether,counts);
        auth.commitInstitutionHistory(1,123 ether,counts);auth.commitReversalHistory(0,reversals);
        assertFalse(auth.successionReady());
        vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);
        auth.importInstitutionBalance(oldInstitution, address(institution), 123 ether, codeHash, empty);
        institution.setToken(address(successor));
        vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);
        auth.importInstitutionBalance(oldInstitution, address(institution), 124 ether, codeHash, empty);
        BreakInstitutionFixture attacker = new BreakInstitutionFixture(); attacker.setToken(address(successor));
        vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);
        auth.importInstitutionBalance(oldInstitution, address(attacker), 123 ether, codeHash, empty);
        auth.importInstitutionBalance(oldInstitution, address(institution), 123 ether, codeHash, empty);
        assertEq(successor.balanceOf(address(institution)), 123 ether);
        assertEq(successor.totalSupply(), 123 ether);
        assertEq(successor.restoredBalance(), 123 ether);
        assertTrue(auth.successionReady());
        assertEq(auth.importedInstitutionCount(),1);assertEq(auth.importedInstitutionAmount(),123 ether);
        vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);
        auth.importInstitutionBalance(oldInstitution, address(institution), 123 ether, codeHash, empty);
    }

    function testUnallocatedRemainderFollowsLaterIndependentOwnerRecovery() public {
        bytes32 nextSecret=sha256("next secret TEST ONLY");
        bytes memory nextPublic=slhPublic(2);
        proof.nextSigningRoot=sha256(nextPublic);
        proof.nextCommitment=sha256(abi.encodePacked(nextSecret,proof.nextSigningRoot));
        ProvianRestorationAuthorization.Reversal memory r=reversal(100 ether);sign(r);
        vm.prank(ADMIN);execute(r);
        RecourseOwnerAuthorization.OwnerProof memory nextProof;
        nextProof.recoverySecret=nextSecret;nextProof.signingRoot=proof.nextSigningRoot;
        nextProof.publicKey=nextPublic;nextProof.nextSigningRoot=sha256("third root TEST ONLY");
        nextProof.nextCommitment=sha256("third commitment TEST ONLY");
        address newDestination=address(0x123456);
        bytes32 operation=sha256(abi.encode("Provian ownership recovery",ID,newDestination));
        (,nextProof.signature)=slhSign(2,authorization.ownerAuthorizationDigest(ID,operation,nextProof.nextCommitment,nextProof.nextSigningRoot));
        vm.prank(ADMIN);authorization.execute(ID,operation,nextProof,abi.encode(uint8(2),abi.encode(ID,newDestination,uint256(1))));
        assertEq(authorization.reversalOutcome(r.request),sha256(abi.encode(r.request,ID,newDestination,r.poolShortfall,r.evidenceHash)));
        assertTrue(authorization.reversalExecuted(r.request));
        assertEq(kernel.totalSupply(),123 ether);
    }
    function testBreakReversalHistoryCannotReopenOrChangeAnExecutedRequest() public {
        bytes32 request=sha256("request TEST ONLY");
        ProvianRestorationAuthorization.ReversalEvidence memory e=ProvianRestorationAuthorization.ReversalEvidence(ID,23 ether,sha256("evidence TEST ONLY"));
        bytes32 leaf=sha256(abi.encode("Provian reversal history",address(kernel),uint256(100),request,e.identity,e.shortfall,e.evidenceHash));
        bytes32 countLeaf=sha256(abi.encode("Provian reversal history count",address(kernel),uint256(100),uint256(1)));
        bytes32 root=leaf<countLeaf?sha256(abi.encodePacked(leaf,countLeaf)):sha256(abi.encodePacked(countLeaf,leaf));
        ProvianRestorationAuthorization next=new ProvianRestorationAuthorization(address(0x1234),root,address(kernel),100,true,
            keccak256(type(ProvianHashAccount).runtimeCode), 0);
        bytes32[] memory path=new bytes32[](1);path[0]=countLeaf;
        assertFalse(next.reversalHistoryReady());
        vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);next.importReversalHistory(request,e,path);
        bytes32[] memory countPath=new bytes32[](1);countPath[0]=leaf;
        vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);next.commitReversalHistory(0,countPath);
        next.commitReversalHistory(1,countPath);assertFalse(next.reversalHistoryReady());
        e.shortfall=24 ether;
        vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);next.importReversalHistory(request,e,path);
        e.shortfall=23 ether;next.importReversalHistory(request,e,path);
        assertTrue(next.reversalExecuted(request));assertTrue(next.reversalHistoryReady());
        ProvianRestorationAuthorization.ReversalEvidence memory saved=next.reversalEvidence(request);
        assertEq(saved.identity,ID);assertEq(saved.shortfall,23 ether);assertEq(saved.evidenceHash,e.evidenceHash);
        vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);next.importReversalHistory(request,e,path);
        vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);next.commitReversalHistory(1,countPath);
    }

    function testBreakHistoryPreservesExactPendingOwnerConsentWithoutInstallingOldDestination() public {
        ProvianRestorationAuthorization.RestorationIntent memory intent=authorizeIntent(123 ether);
        bytes32 leaf=sha256(abi.encode("Provian pending restoration intent",address(kernel),uint256(100),intent));
        bytes32 countLeaf=sha256(abi.encode("Provian reversal history count",address(kernel),uint256(100),uint256(1)));
        bytes32 root=leaf<countLeaf?sha256(abi.encodePacked(leaf,countLeaf)):sha256(abi.encodePacked(countLeaf,leaf));
        ProvianRestorationAuthorization next=new ProvianRestorationAuthorization(address(0x1234),root,address(kernel),100,true,
            keccak256(type(ProvianHashAccount).runtimeCode),0);
        bytes32[] memory path=new bytes32[](1);path[0]=countLeaf;
        bytes32[] memory countPath=new bytes32[](1);countPath[0]=leaf;
        vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);next.importRestorationIntent(intent,path);
        next.commitReversalHistory(1,countPath);assertFalse(next.reversalHistoryReady());
        intent.maximumLoss+=1;
        vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);next.importRestorationIntent(intent,path);
        intent.maximumLoss-=1;intent.destination=address(0x999);
        vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);next.importRestorationIntent(intent,path);
        intent.destination=DESTINATION;next.importRestorationIntent(intent,path);
        assertTrue(next.reversalHistoryReady());
        assertEq(abi.encode(next.restorationIntent(intent.request)),abi.encode(intent));
        assertEq(next.recoveredDestination(ID),address(0));
        assertEq(next.ownerRecoveryCommitment(ID),bytes32(0));
        vm.expectRevert(ProvianRestorationAuthorization.InvalidRestoration.selector);next.importRestorationIntent(intent,path);
        assertEq(kernel.totalSupply(),123 ether);
    }

    function testRealSettlementDivertsGrossContributionAndKeepsSplitFloors() public {
        vm.warp(2);
        ProvianMemberRecoursePool pool = ProvianMemberRecoursePool(pointer.component(8));
        bytes32 configId = keccak256("verifier TEST ONLY");
        MockPVT9Verifier verifier = new MockPVT9Verifier(configId, 1, configId, 1);
        ProvianRecourseKernel.VerifierConfig memory config = ProvianRecourseKernel.VerifierConfig(address(verifier), configId, 1);
        ProvianRecourseEligibilityVerifier eligibility = new ProvianRecourseEligibilityVerifier(kernel, configId, 1);
        ProvianRecourseKernel.VerifierConfig memory eligibilityConfig = ProvianRecourseKernel.VerifierConfig(address(eligibility), configId, 1);
        vm.startPrank(ADMIN);
        eligibility.appointBatchApprover(address(this));
        kernel.appointOperationalMinter(address(pool.settlement()));
        kernel.installRecoveredBeneficiaryVerifier(config);
        kernel.armEpochZero(ProvianRecourseKernel.EpochZeroConfig(1, 1, 100, 1 ether, address(0xA001), address(0xA002), eligibilityConfig, 0,
            ProvianRecourseKernel.CombinedCapMode.Fixed, 7_500_000 ether, 10_000_000 ether));
        vm.stopPrank();
        pool.bind(ID, THIEF);
        vm.startPrank(THIEF); kernel.approve(address(pool), type(uint256).max); pool.enroll(ID); vm.stopPrank();
        assertEq(kernel.balanceOf(THIEF), 23 ether);
        ProvianPVT9.StandardRecipient[] memory recipients = new ProvianPVT9.StandardRecipient[](1);
        recipients[0] = ProvianPVT9.StandardRecipient(THIEF, ProvianPVT9.BeneficiaryClass.HumanResolving, 1);
        ProvianPVT9.StandardPEClaim[] memory claims = new ProvianPVT9.StandardPEClaim[](1);
        claims[0] = ProvianPVT9.StandardPEClaim(bytes32(uint256(123)), 100 ether);
        bytes32 policyHash = kernel.getEpochPolicy(0).policyHash;
        (bool approved,) = address(eligibility).call(abi.encodeWithSelector(eligibility.approveStandardBatch.selector,
            bytes32(uint256(456)), uint64(0), policyHash, uint256(0), uint256(1), recipients, claims));
        assertTrue(approved);
        pool.settlement().settleStandardPEBatch(bytes32(uint256(456)), 0, kernel.getEpochPolicy(0).policyHash, 0, 1, recipients, claims);
        assertEq(kernel.balanceOf(THIEF), 121 ether);
        assertEq(kernel.balanceOf(address(pool)), 1 ether);
        assertEq(pool.accountedBacking(), 1 ether);
        assertEq(kernel.balanceOf(address(0xA001)), 0.5 ether);
        assertEq(kernel.balanceOf(address(0xA002)), 0.5 ether);
        assertEq(kernel.totalSupply(), 123 ether);
        assertTrue(kernel.claimSettled(bytes32(uint256(123))));
    }
    function checkDeploymentSize() external view {
        require(address(kernel).code.length <= 24576, "runtime_exceeds_chain_limit");
        require(address(authorization).code.length <= 24576, "authorization_exceeds_chain_limit");
    }
    function testInitCodeIncludingConstructorArgumentsFitsChainLimit() public view {
        ProvianRecourseKernel.SuccessionConfig memory config = ProvianRecourseKernel.SuccessionConfig(
            ADMIN, bytes32(uint256(1)), address(0x1234), 100, 123 ether, kernel.predecessorHistory(), pointer, address(this), false, ProvianRestorationAuthorization(address(0)));
        uint256 size = type(ProvianRecourseKernel).creationCode.length + abi.encode(config).length;
        assertLe(size, 49152);
    }
    function testRuntimeFitsChainLimitWithOversizeNegativeControl() public {
        this.checkDeploymentSize();
        vm.etch(address(kernel), new bytes(24577));
        vm.expectRevert("runtime_exceeds_chain_limit"); this.checkDeploymentSize();
    }

}

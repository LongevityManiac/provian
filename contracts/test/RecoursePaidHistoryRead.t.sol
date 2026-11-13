// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ProvianPVT9TestBase} from "./ProvianPVT9TestBase.sol";
import {ProvianPVT9} from "../src/ProvianPVT9.sol";
import {ProvianRecourseKernel} from "../src/ProvianRecourseKernel.sol";
import {ProvianRecoveryHistory} from "../src/ProvianRecoveryHistory.sol";
import {ProvianRestorationAuthorization} from "../src/ProvianRestorationAuthorization.sol";
import {ProvianSuccessionImporter} from "../src/ProvianSuccessionImporter.sol";
import {ProvianProtocolPointer} from "../src/ProvianProtocolPointer.sol";
import {ProvianHashAccount} from "../src/ProvianHashAccount.sol";

contract RecoursePaidHistoryReadTest is ProvianPVT9TestBase {
    ProvianPVT9 old;
    ProvianRecourseKernel next;
    ProvianRecoveryHistory history;
    ProvianRestorationAuthorization authorization;
    bytes32 oldClaim;
    bytes32 oldBatch;
    bytes32 constant WALLET = keccak256("paid wallet TEST ONLY");
    bytes32 constant ANCHOR = keccak256("paid anchor TEST ONLY");
    address constant RECIPIENT = address(0x9911);

    function setUp() public override {
        super.setUp();
        old = pvt;
        (oldBatch,oldClaim) = _settleStandard(RECIPIENT,ProvianPVT9.BeneficiaryClass.HumanResolving,1 ether);
        for(uint256 i; i<6; ++i) _settleGenesis(RECIPIENT,WALLET,i==0?ANCHOR:bytes32(i),0,75 ether);
        vm.startPrank(ADMIN);old.placeAdministrativeHold();old.revokeOperationalMinter();vm.stopPrank();
        ProvianPVT9.EpochPolicy memory policy=old.getEpochPolicy(0);
        ProvianRecoveryHistory.State memory s;
        s.epochZeroStartsAt=epochStart;s.genesisStartsAt=epochStart;s.genesisEndsAt=genesisEnd;
        s.nextCursor=old.nextFinalizedCursor();s.administrativeHold=true;
        s.mintRate=policy.mintRate;s.agentFoundationBps=policy.agentFoundationBps;
        s.genesisCap=policy.genesisCap;s.combinedCap=policy.combinedCap;
        s.epochGenesisIssued=old.epochGenesisIssued(0);s.epochTotalIssued=old.epochTotalIssued(0);
        s.provianTreasury=policy.provianTreasury;s.foundationTreasury=policy.foundationTreasury;
        s.eligibilityVerifier=policy.eligibilityVerifier;s.beneficiaryVerifier=policy.beneficiaryVerifier;
        // This fixture tests monetary reads, not enumeration. No paid entry is imported.
        history=new ProvianRecoveryHistory(address(old),block.number,sha256("inventory commitment TEST ONLY"),99,s,true);
        ProvianProtocolPointer pointer=new ProvianProtocolPointer(address(new ProvianHashAccount(sha256("pointer TEST ONLY"))));
        vm.mockCall(address(this),abi.encodeWithSignature("afterCryptographicBreak()"),abi.encode(false));
        address predicted=vm.computeCreateAddress(address(this),vm.getNonce(address(this))+1);
        authorization=new ProvianRestorationAuthorization(predicted,bytes32(uint256(1)),address(old),block.number,false,
            keccak256(type(ProvianHashAccount).runtimeCode),0);
        next=new ProvianRecourseKernel(ProvianRecourseKernel.SuccessionConfig(ADMIN,bytes32(uint256(1)),address(old),
            block.number,0,history,pointer,address(this),false,authorization));
        // Pool diversion is isolated from these kernel replay tests. All predecessor
        // and successor settlement calls and paid-history reads execute real code.
        vm.mockCall(address(pointer),abi.encodeWithSignature("component(uint256)",uint256(8)),abi.encode(address(this)));
        vm.mockCall(address(this),abi.encodeWithSignature("divertIssuance(address,uint256,uint256)"),abi.encode(uint256(0)));
        vm.mockCall(address(verifier),abi.encodeWithSignature("administrativeHold()"),abi.encode(true));
        vm.mockCall(address(verifier),abi.encodeWithSignature("batchApprover()"),abi.encode(address(0)));
        pvt=ProvianPVT9(address(next));
        vm.startPrank(ADMIN);pvt.appointOperationalMinter(MINTER);
        pvt.armEpochZero(ProvianPVT9.EpochZeroConfig(epochStart,epochStart,genesisEnd,policy.mintRate,
            policy.provianTreasury,policy.foundationTreasury,policy.eligibilityVerifier,s.nextCursor,
            ProvianPVT9.CombinedCapMode.Fixed,policy.genesisCap,policy.combinedCap));
        pvt.resumeFromAdministrativeHold();vm.stopPrank();
    }
    function testPaidClaimAndUsedBatchCannotSettleAgainAndOriginalReceiptIsExact() public {
        assertTrue(next.claimSettled(oldClaim));
        assertEq(abi.encode(next.getBatchRecord(oldBatch)),abi.encode(old.getBatchRecord(oldBatch)));
        assertEq(history.batchRecords(oldBatch),abi.encode(old.getBatchRecord(oldBatch)));
        assertTrue(history.batchUsed(oldBatch));assertTrue(history.complete());assertEq(history.importedCount(),0);
        ProvianPVT9.StandardRecipient[] memory recipients=new ProvianPVT9.StandardRecipient[](1);
        recipients[0]=ProvianPVT9.StandardRecipient(RECIPIENT,ProvianPVT9.BeneficiaryClass.HumanResolving,1);
        ProvianPVT9.StandardPEClaim[] memory claims=new ProvianPVT9.StandardPEClaim[](1);
        claims[0]=ProvianPVT9.StandardPEClaim(oldClaim,1 ether);
        bytes32 policy=pvt.getEpochPolicy(0).policyHash;uint256 cursor=pvt.nextFinalizedCursor();bytes32 fresh=_batchId();
        vm.prank(MINTER);vm.expectRevert(ProvianPVT9.ClaimAlreadySettled.selector);
        pvt.settleStandardPEBatch(fresh,0,policy,cursor,cursor+1,recipients,claims);
        claims[0].claimId=_claimId();
        vm.prank(MINTER);vm.expectRevert(ProvianPVT9.BatchAlreadySettled.selector);
        pvt.settleStandardPEBatch(oldBatch,0,policy,cursor,cursor+1,recipients,claims);
        assertEq(pvt.totalSupply(),0);assertEq(pvt.nextFinalizedCursor(),cursor);
        // Positive control: genuinely fresh work still settles.
        _settleStandard(RECIPIENT,ProvianPVT9.BeneficiaryClass.HumanResolving,1 ether);
        assertEq(pvt.totalSupply(),1 ether);
    }
    function testUsedAnchorAndCumulativeWalletCeilingSurviveWithoutCopy() public {
        assertTrue(next.genesisAnchorUsed(old.genesisAnchorKey(0,ANCHOR)));
        assertEq(next.genesisWalletGrossIssued(WALLET),450 ether);
        _expectGenesisRevert(ProvianPVT9.GenesisAnchorAlreadyUsed.selector,RECIPIENT,keccak256("new wallet"),ANCHOR,0,25 ether);
        _expectGenesisRevert(ProvianPVT9.GenesisWalletCeilingExceeded.selector,RECIPIENT,WALLET,keccak256("new anchor"),0,75 ether);
        _settleGenesis(RECIPIENT,WALLET,keccak256("remaining allowance"),0,50 ether);
        assertEq(next.genesisWalletGrossIssued(WALLET),500 ether);assertEq(old.genesisWalletGrossIssued(WALLET),450 ether);
        _expectGenesisRevert(ProvianPVT9.GenesisWalletCeilingExceeded.selector,RECIPIENT,WALLET,keccak256("past ceiling"),0,1);
        assertEq(pvt.totalSupply(),50 ether);
    }
    function testOrdinaryHistoryRejectsBothDirectAndWrappedImports() public {
        vm.expectRevert(ProvianRecoveryHistory.InvalidHistory.selector);history.importEntry(0,oldClaim,1,new bytes32[](0));
        ProvianPVT9.BatchRecord memory record=old.getBatchRecord(oldBatch);
        vm.expectRevert(ProvianRecoveryHistory.InvalidHistory.selector);history.importBatch(oldBatch,record,new bytes32[](0));
        ProvianSuccessionImporter helper=new ProvianSuccessionImporter(address(history),address(authorization));
        bytes[] memory calls=new bytes[](1);calls[0]=abi.encodeCall(history.importEntry,(uint8(0),oldClaim,uint256(1),new bytes32[](0)));
        vm.expectRevert(ProvianSuccessionImporter.InvalidImport.selector);helper.importHistory(calls);
        assertEq(history.importedCount(),0);
    }
    function testMissingMalformedAndRevertingReadsNeverBecomeUnusedOrZero() public {
        bytes32 key=keccak256("unknown key");
        assertFalse(history.claimSettled(key));assertFalse(history.genesisAnchorUsed(key));
        assertEq(history.genesisWalletGrossIssued(key),0);assertFalse(history.batchUsed(key));assertEq(history.batchRecords(key),hex"");
        vm.mockCallRevert(address(old),abi.encodeCall(old.claimSettled,(key)),"unavailable");
        vm.expectRevert();next.claimSettled(key);
        vm.mockCall(address(old),abi.encodeCall(old.genesisAnchorUsed,(key)),hex"01");
        vm.expectRevert();next.genesisAnchorUsed(key);
        vm.mockCall(address(old),abi.encodeCall(old.genesisWalletGrossIssued,(key)),hex"");
        vm.expectRevert();next.genesisWalletGrossIssued(key);
        vm.mockCall(address(old),abi.encodeCall(old.getBatchRecord,(key)),hex"01");
        vm.expectRevert();next.getBatchRecord(key);
        vm.expectRevert();history.batchUsed(key);
    }
}

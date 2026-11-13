// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {ProvianPVT9} from "../src/ProvianPVT9.sol";
import {ProvianRecoveryHistory} from "../src/ProvianRecoveryHistory.sol";
import {ProvianBreakRecoveryHistory} from "../src/ProvianBreakRecoveryHistory.sol";
import {ProvianHashAccount} from "../src/ProvianHashAccount.sol";
contract ProvianBreakRecoveryHistoryTest is Test {
    function source() private pure returns (ProvianRecoveryHistory.State memory s) {
        s.epochZeroStartsAt=1; s.genesisStartsAt=1; s.genesisEndsAt=100;
        s.mintRate=1 ether; s.agentFoundationBps=50; s.genesisCap=7_500_000 ether; s.combinedCap=10_000_000 ether;
        s.provianTreasury=address(0xA); s.foundationTreasury=address(0xB);
        s.eligibilityVerifier=ProvianPVT9.VerifierConfig(address(0xC),sha256("verifier TEST ONLY"),1);
        s.schedules=new ProvianRecoveryHistory.EconomicSchedule[](1);
        s.schedules[0].epoch=1; s.schedules[0].treasuriesSet=true;
        s.schedules[0].provianTreasury=address(0xA);s.schedules[0].foundationTreasury=address(0xB);
    }
    function mappings() private returns (ProvianBreakRecoveryHistory.TreasuryRecovery[] memory r) {
        r=new ProvianBreakRecoveryHistory.TreasuryRecovery[](2);
        r[0]=ProvianBreakRecoveryHistory.TreasuryRecovery(address(0xA),new ProvianHashAccount(sha256("company TEST ONLY")));
        r[1]=ProvianBreakRecoveryHistory.TreasuryRecovery(address(0xB),new ProvianHashAccount(sha256("foundation TEST ONLY")));
    }
    function testActiveAndScheduledTreasuriesRecoverWithoutRewritingEconomicsOrHistoricalSource() public {
        bytes32 historyRoot=sha256("history TEST ONLY");
        ProvianRecoveryHistory.State memory original=source();
        ProvianBreakRecoveryHistory.TreasuryRecovery[] memory r=mappings();
        ProvianBreakRecoveryHistory history=new ProvianBreakRecoveryHistory(address(0x1234),100,historyRoot,0,original,r);
        ProvianRecoveryHistory.State memory current=history.state();
        assertTrue(history.afterCryptographicBreak());
        assertEq(current.provianTreasury,address(r[0].successor));assertEq(current.foundationTreasury,address(r[1].successor));
        assertEq(current.schedules[0].provianTreasury,address(r[0].successor));
        assertEq(current.schedules[0].foundationTreasury,address(r[1].successor));
        assertEq(current.mintRate,original.mintRate);assertEq(current.agentFoundationBps,original.agentFoundationBps);
        assertEq(keccak256(abi.encode(history.sourceState())),keccak256(abi.encode(original)));
        ProvianPVT9.EpochZeroConfig memory config=ProvianPVT9.EpochZeroConfig(1,1,100,1 ether,current.provianTreasury,current.foundationTreasury,
            original.eligibilityVerifier,0,ProvianPVT9.CombinedCapMode.Fixed,original.genesisCap,original.combinedCap);
        assertTrue(history.validArming(config,original.beneficiaryVerifier));
        config.provianTreasury=original.provianTreasury;assertFalse(history.validArming(config,original.beneficiaryVerifier));
        config.provianTreasury=current.provianTreasury;config.initialMintRate=2 ether;assertFalse(history.validArming(config,original.beneficiaryVerifier));
    }
    function testMissingDuplicateCurveAndUnusedTreasuryMappingsAreRejected() public {
        bytes32 historyRoot=sha256("history TEST ONLY");
        ProvianRecoveryHistory.State memory original=source();
        ProvianBreakRecoveryHistory.TreasuryRecovery[] memory r=mappings();
        r[1].successor=ProvianHashAccount(payable(address(0xD)));
        vm.expectRevert(ProvianRecoveryHistory.InvalidHistory.selector);
        new ProvianBreakRecoveryHistory(address(0x1234),100,historyRoot,0,original,r);
        r=mappings();r[1].previous=r[0].previous;
        vm.expectRevert(ProvianRecoveryHistory.InvalidHistory.selector);
        new ProvianBreakRecoveryHistory(address(0x1234),100,historyRoot,0,original,r);
        r=mappings();r[1].previous=address(0xD);
        vm.expectRevert(ProvianRecoveryHistory.InvalidHistory.selector);
        new ProvianBreakRecoveryHistory(address(0x1234),100,historyRoot,0,original,r);
        r=mappings();original.schedules[0].foundationTreasury=address(0xD);
        vm.expectRevert(ProvianRecoveryHistory.InvalidHistory.selector);
        new ProvianBreakRecoveryHistory(address(0x1234),100,historyRoot,0,original,r);
    }
    function testBreakPaidEntriesStayFrozenRegardlessOfCurrentPredecessorReads() public {
        address old=address(0x1234);bytes32 key=sha256("frozen key TEST ONLY");
        for(uint8 kind;kind<4;++kind){
            uint256 value=kind==2?300 ether:1;
            bytes32 root=sha256(abi.encode("Provian monetary history",old,uint256(100),kind,key,value));
            ProvianBreakRecoveryHistory h=new ProvianBreakRecoveryHistory(old,100,root,1,source(),mappings());
            assertFalse(h.readPredecessor());assertFalse(h.complete());
            h.importEntry(kind,key,value,new bytes32[](0));assertTrue(h.complete());
            vm.mockCallRevert(old,abi.encodeWithSignature("claimSettled(bytes32)",key),"unavailable");
            vm.mockCallRevert(old,abi.encodeWithSignature("genesisAnchorUsed(bytes32)",key),"unavailable");
            vm.mockCallRevert(old,abi.encodeWithSignature("genesisWalletGrossIssued(bytes32)",key),"unavailable");
            vm.mockCallRevert(old,abi.encodeWithSignature("getBatchRecord(bytes32)",key),"unavailable");
            if(kind==0)assertTrue(h.claimSettled(key));
            if(kind==1)assertTrue(h.genesisAnchorUsed(key));
            if(kind==2)assertEq(h.genesisWalletGrossIssued(key),300 ether);
            if(kind==3)assertTrue(h.batchUsed(key));
        }
        ProvianPVT9.BatchRecord memory record;
        record.settled=true;record.finalizedCursorEnd=1;record.totalMinted=1;record.contributorTotal=1;
        record.settlementDigest=sha256("original batch TEST ONLY");
        bytes32 root=sha256(abi.encode("Provian settlement history",old,uint256(100),key,sha256(abi.encode(record))));
        ProvianBreakRecoveryHistory receipt=new ProvianBreakRecoveryHistory(old,100,root,1,source(),mappings());
        receipt.importBatch(key,record,new bytes32[](0));
        assertEq(abi.encode(receipt.getBatchRecord(key)),abi.encode(record));
        assertEq(receipt.batchRecords(key),abi.encode(record));assertTrue(receipt.batchUsed(key));
    }

}

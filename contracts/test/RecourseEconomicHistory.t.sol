// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import "../src/ProvianRecoveryHistory.sol";
contract RecourseEconomicHistoryTest is Test {
    function prior() private pure returns (ProvianRecoveryHistory.State memory s) {
        s.epochZeroStartsAt=1;s.genesisStartsAt=1;s.genesisEndsAt=100;
        s.lastOpenedEpoch=1;s.mintRate=1 ether;s.agentFoundationBps=100;
        s.genesisCap=100 ether;s.combinedCap=200 ether;
        s.provianTreasury=address(1);s.foundationTreasury=address(2);
        s.eligibilityVerifier=ProvianPVT9.VerifierConfig(address(3),bytes32(uint256(4)),1);
    }
    function leaf(uint256 index,bytes memory data) private pure returns(bytes32) {
        return sha256(abi.encode("Provian economic history",address(9),uint256(20),index,sha256(data)));
    }
    function pair(bytes32 a,bytes32 b) private pure returns(bytes32) {
        return a<b?sha256(abi.encodePacked(a,b)):sha256(abi.encodePacked(b,a));
    }
    function records() private pure returns(bytes memory a,bytes memory b) {
        ProvianRecoveryHistory.HistoricalEpoch memory e;
        e.policy.opened=true;e.policy.epoch=0;e.policy.startsAt=1;
        e.policy.genesisCap=10;e.policy.combinedCap=20;e.genesisIssued=2;e.totalIssued=3;
        ProvianRecoveryHistory.EconomicSchedule memory s;s.epoch=2;s.mintRateSet=true;s.mintRate=2 ether;
        return (abi.encode(e),abi.encode(s));
    }
    function testSerialProofsPreserveExactHistoryAndRefuseEarlyReadiness() public {
        (bytes memory a,bytes memory b)=records();bytes32 l0=leaf(0,a);bytes32 l1=leaf(1,b);
        ProvianRecoveryHistory.State memory s=prior();s.economicRoot=pair(l0,l1);s.economicCount=2;
        ProvianRecoveryHistory h=new ProvianRecoveryHistory(address(9),20,bytes32(uint256(30)),0,s);
        assertFalse(h.complete());assertEq(h.baseState().epochs.length,0);
        bytes32[] memory p=new bytes32[](1);p[0]=l0;
        vm.expectRevert();h.importEconomicEntry(1,b,p);
        vm.expectRevert();h.state();
        p[0]=l1;
        ProvianRecoveryHistory.HistoricalEpoch memory changed=abi.decode(a,(ProvianRecoveryHistory.HistoricalEpoch));
        changed.totalIssued=4;
        vm.expectRevert();h.importEconomicEntry(0,abi.encode(changed),p);
        assertEq(h.importedEconomicEntries(),0);
        h.importEconomicEntry(0,a,p);h.importEconomicEntry(0,a,p);
        assertEq(h.importedEconomicEntries(),1);
        vm.expectRevert();h.importEconomicEntry(0,b,p);
        p[0]=l0;h.importEconomicEntry(1,b,p);assertTrue(h.complete());
        ProvianRecoveryHistory.State memory restored=h.state();
        assertEq(keccak256(abi.encode(restored.epochs[0])),keccak256(a));
        assertEq(keccak256(abi.encode(restored.schedules[0])),keccak256(b));
        assertEq(h.baseState().schedules.length,0);
    }
    function testAuthenticatedMalformedEpochCannotConsumeIndex() public {
        (bytes memory a,)=records();ProvianRecoveryHistory.HistoricalEpoch memory e=abi.decode(a,(ProvianRecoveryHistory.HistoricalEpoch));
        e.policy.epoch=1;a=abi.encode(e);
        ProvianRecoveryHistory.State memory s=prior();s.economicRoot=leaf(0,a);s.economicCount=1;
        ProvianRecoveryHistory h=new ProvianRecoveryHistory(address(9),20,bytes32(uint256(30)),0,s);
        vm.expectRevert();h.importEconomicEntry(0,a,new bytes32[](0));
        assertFalse(h.complete());assertEq(h.importedEconomicEntries(),0);
    }
}

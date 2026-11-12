// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "forge-std/Test.sol";
import "../src/RecourseInstitutionSeeds.sol";
contract ReviewSeedHarness is RecourseInstitutionSeeds {
    mapping(bytes32=>uint256) public balances;
    constructor(address token,SeedManifest memory m) RecourseInstitutionSeeds(token,1,m) {}
    function touch() external view whenCustodyReady returns(bool) { return true; }
    function _applyCustodySeed(bytes calldata data) internal override returns(uint256){
        (bytes32 id,uint256 amount)=abi.decode(data,(bytes32,uint256));
        require(amount>0 && balances[id]==0);balances[id]=amount;return amount;
    }
}
contract RecourseInstitutionSeedsReviewTest is Test {
    address token=address(0x11);address predecessor=address(0x12);
    bytes32 cutoffHash=bytes32(uint256(13));
    function domain() internal view returns(bytes32){return sha256(abi.encode("Provian custody snapshot",block.chainid,token,uint8(1),predecessor,uint256(14),cutoffHash));}
    function leaf(uint256 index,bytes memory data) internal view returns(bytes32){return sha256(abi.encode(domain(),index,sha256(data)));}
    function pair(bytes32 x,bytes32 y) internal pure returns(bytes32){return x<y?sha256(abi.encodePacked(x,y)):sha256(abi.encodePacked(y,x));}
    function deploy(bytes32 root,uint256 total) internal returns(ReviewSeedHarness){return new ReviewSeedHarness(token,RecourseInstitutionSeeds.SeedManifest(predecessor,14,cutoffHash,root,2,total));}
    function testOutOfOrderImportsCannotBypassReadinessOrAlterRecipients() public {
        bytes memory a=abi.encode(bytes32(uint256(1)),uint256(10)); bytes memory b=abi.encode(bytes32(uint256(2)),uint256(20));
        bytes32 l0=leaf(0,a); bytes32 l1=leaf(1,b);ReviewSeedHarness h=deploy(pair(l0,l1),30);
        bytes32[] memory p=new bytes32[](1);p[0]=l1;
        vm.expectRevert();h.importCustodySeed(0,abi.encode(bytes32(uint256(3)),uint256(10)),p);
        assertEq(h.importedCustodySeeds(),0);assertEq(h.balances(bytes32(uint256(3))),0);
        p[0]=l0;
        vm.prank(address(0xdead));h.importCustodySeed(1,b,p);
        assertFalse(h.custodySeedsReady());vm.expectRevert();h.touch();
        h.importCustodySeed(1,b,p);assertEq(h.importedCustodySeeds(),1);
        vm.expectRevert();h.importCustodySeed(0,b,p);
        vm.expectRevert();h.importCustodySeed(1,abi.encode(bytes32(uint256(3)),uint256(20)),p);
        p[0]=l1;h.importCustodySeed(0,a,p);assertTrue(h.touch());
        assertEq(h.balances(bytes32(uint256(1))),10);assertEq(h.balances(bytes32(uint256(2))),20);
    }
    function testIncorrectTotalRollsBackLastImportAndCannotUnlock() public {
        bytes memory a=abi.encode(bytes32(uint256(1)),uint256(10)); bytes memory b=abi.encode(bytes32(uint256(2)),uint256(20));
        bytes32 l0=leaf(0,a); bytes32 l1=leaf(1,b);ReviewSeedHarness h=deploy(pair(l0,l1),31);
        bytes32[] memory p=new bytes32[](1);p[0]=l1;h.importCustodySeed(0,a,p);
        p[0]=l0;vm.expectRevert();h.importCustodySeed(1,b,p);
        assertEq(h.balances(bytes32(uint256(2))),0);assertEq(h.importedCustodySeeds(),1);assertEq(h.importedCustodyTotal(),10);assertFalse(h.custodySeedsReady());
    }
    function testDuplicateLogicalSeedCannotCompleteEvenWithValidProof() public {
        bytes memory a=abi.encode(bytes32(uint256(1)),uint256(10));
        bytes32 l0=leaf(0,a); bytes32 l1=leaf(1,a);ReviewSeedHarness h=deploy(pair(l0,l1),20);
        bytes32[] memory p=new bytes32[](1);p[0]=l1;h.importCustodySeed(0,a,p);
        p[0]=l0;vm.expectRevert();h.importCustodySeed(1,a,p);assertFalse(h.custodySeedsReady());
    }
}

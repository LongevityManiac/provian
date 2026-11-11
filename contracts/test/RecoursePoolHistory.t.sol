// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {MemberTokenMock} from "./ProvianMemberRecoursePool.t.sol";
import {RecourseMonthlyAccounting} from "../src/RecourseMonthlyAccounting.sol";
import {RecourseReserveAccounting} from "../src/RecourseReserveAccounting.sol";
import {RecoursePoolHistory} from "../src/RecoursePoolHistory.sol";
import {ProvianMemberRecoursePool} from "../src/ProvianMemberRecoursePool.sol";
import {ProvianHashAccount} from "../src/ProvianHashAccount.sol";
import {ProvianProtocolPointer} from "../src/ProvianProtocolPointer.sol";
import {ProvianPVT9} from "../src/ProvianPVT9.sol";
contract RecoursePoolHistoryTest is Test {
    bytes32 constant ID=bytes32(uint256(1));
    bytes32 constant REQUEST=bytes32(uint256(2));
    bytes32 constant OCCURRENCE=bytes32(uint256(3));
    address constant PREVIOUS=address(0x1234);
    MemberTokenMock token;
    ProvianProtocolPointer pointer;
    ProvianMemberRecoursePool pool;
    uint8[] kinds;
    bytes[] records;
    bytes32[] leaves;
    bytes32 root;
    uint256 month;
    function setUp() public {
        vm.warp(1705276800);vm.roll(101);
        token=new MemberTokenMock();
        pointer=new ProvianProtocolPointer(address(new ProvianHashAccount(sha256("TEST ONLY pointer"))));
        month=2024*12;
    }
    function add(uint8 kind,bytes memory data) private {
        kinds.push(kind);records.push(data);
        leaves.push(sha256(abi.encode("Provian pool succession",PREVIOUS,uint256(100),kind,sha256(data))));
    }
    function pair(bytes32 a,bytes32 b) private pure returns(bytes32){return a<b?sha256(abi.encodePacked(a,b)):sha256(abi.encodePacked(b,a));}
    function proof(uint256 index) private view returns(bytes32[] memory result) {
        bytes32[] memory level=leaves;
        bytes32[] memory temp=new bytes32[](256);uint256 count;uint256 size=level.length;
        while(size>1){
            uint256 sibling=index^1;if(sibling<size)temp[count++]=level[sibling];
            for(uint256 j;j<size;j+=2)level[j/2]=j+1<size?pair(level[j],level[j+1]):level[j];
            size=(size+1)/2;index/=2;
        }
        result=new bytes32[](count);for(uint256 j;j<count;++j)result[j]=temp[j];
    }
    function recordsFor(uint256 allocation) private {
        add(0,abi.encode(uint256(40 ether),uint256(60 ether)));
        add(1,abi.encode(uint256(0),RecourseMonthlyAccounting.MonthlyRule(0,100 ether,100 ether,100,sha256("TEST ONLY signed rule"))));
        add(2,abi.encode(ID,RecourseMonthlyAccounting.Enrollment(true,month,month,month,0,1),address(this),uint256(7),uint256(1),false));
        add(3,abi.encode(ID,uint256(1),month,RecourseMonthlyAccounting.MonthlyObligation(true,true,100 ether,100 ether,100 ether,100 ether,100 ether,100,9999)));
        add(4,abi.encode(ID,uint256(1),RecoursePoolHistory.MembershipPeriod(80,0,month)));
        add(5,abi.encode(REQUEST,RecourseReserveAccounting.RestorationAllocation(ID,allocation,false)));
        add(7,abi.encode(address(this),ID));
        add(8,abi.encode(REQUEST,ID,OCCURRENCE));
    }
    function deploy(bool afterBreak) private {
        bytes32[] memory level=leaves;uint256 size=level.length;
        while(size>1){for(uint256 j;j<size;j+=2)level[j/2]=j+1<size?pair(level[j],level[j+1]):level[j];size=(size+1)/2;}
        root=level[0];token.ownerAuthorization().setBreak(afterBreak);
        vm.mockCall(address(pointer),abi.encodeWithSignature("component(uint256)",uint256(8)),abi.encode(PREVIOUS));
        vm.mockCall(PREVIOUS,abi.encodeWithSignature("pvt()"),abi.encode(address(0x5555)));
        pool=new ProvianMemberRecoursePool(ProvianPVT9(address(token)),address(this),address(this),pointer,
            RecourseMonthlyAccounting.MonthlyRule(0,0,0,0,bytes32(0)),
            RecoursePoolHistory.PoolSnapshot(PREVIOUS,100,root,leaves.length,afterBreak));
    }
    function importAt(uint256 index) private {pool.importPoolState(kinds[index],records[index],proof(index));}
    function importExternally(uint256 index) external { importAt(index); }
    function importAll() private {for(uint256 i;i<leaves.length;++i)importAt(i);}
    function testCompleteImportPreservesInvoicesReplayFencesAndRelayFreeExit() public {
        recordsFor(40 ether);deploy(false);importAll();
        vm.expectRevert(RecoursePoolHistory.InvalidPoolHistory.selector);pool.activatePoolHistory();
        token.mint(address(pool),100 ether);pool.activatePoolHistory();
        assertEq(pool.monthlyRuleCount(),1);assertEq(pool.outcomeRevision(ID),1);
        assertTrue(pool.determined(REQUEST));assertTrue(pool.occurrenceDetermined(ID,OCCURRENCE));
        (,,,,,,,,uint256 remainder)=pool.obligations(ID,1,month);assertEq(remainder,9999);
        assertEq(pool.withdrawRestoration(REQUEST,ID),40 ether);
        assertEq(token.balanceOf(address(this)),40 ether);assertEq(token.balanceOf(address(pool)),60 ether);
        vm.expectRevert(RecoursePoolHistory.InvalidPoolHistory.selector);this.importExternally(0);
        vm.expectRevert(RecoursePoolHistory.InvalidPoolHistory.selector);pool.activatePoolHistory();
    }
    function testPartialImportBlocksEveryMemberMoneyAndBindingPath() public {
        recordsFor(40 ether);deploy(false);
        vm.expectRevert(RecoursePoolHistory.InvalidPoolHistory.selector);this.importExternally(1);
        importAt(0);
        vm.expectRevert(RecoursePoolHistory.InvalidPoolHistory.selector);pool.bind(ID,address(this));
        vm.expectRevert(RecoursePoolHistory.InvalidPoolHistory.selector);pool.enroll(ID);
        vm.expectRevert(RecoursePoolHistory.InvalidPoolHistory.selector);pool.leave(ID);
        vm.expectRevert(RecoursePoolHistory.InvalidPoolHistory.selector);pool.settleMonth(ID);
        vm.expectRevert(RecoursePoolHistory.InvalidPoolHistory.selector);pool.divertIssuance(address(this),1,1);
        vm.expectRevert(RecoursePoolHistory.InvalidPoolHistory.selector);pool.collectMintContribution(address(this),1,1,1);
        vm.expectRevert(RecoursePoolHistory.InvalidPoolHistory.selector);pool.withdrawRestoration(REQUEST,ID);
        vm.expectRevert(RecoursePoolHistory.InvalidPoolHistory.selector);pool.activatePoolHistory();
    }
    function testSemanticDuplicateCannotOverwriteOwnerEvenWithAnotherValidLeaf() public {
        recordsFor(40 ether);
        add(2,abi.encode(ID,RecourseMonthlyAccounting.Enrollment(true,month,month,month,0,1),address(0xBAD),uint256(8),uint256(1),false));
        deploy(false);for(uint256 i;i<8;++i)importAt(i);
        vm.expectRevert(RecoursePoolHistory.InvalidPoolHistory.selector);this.importExternally(8);
        assertEq(pool.primaryAddress(ID),address(this));assertEq(pool.importedPoolEntries(),8);
    }
    function testMissingAllocationAmountsCannotActivate() public {
        recordsFor(39 ether);deploy(false);importAll();token.mint(address(pool),100 ether);
        vm.expectRevert(RecoursePoolHistory.InvalidPoolHistory.selector);pool.activatePoolHistory();
    }
    function testRefundableShareImportKindIsRefused() public {
        recordsFor(40 ether);add(6,abi.encode(uint256(0),ID,uint256(100 ether)));deploy(false);
        for(uint256 i;i<8;++i)importAt(i);
        vm.expectRevert(RecoursePoolHistory.InvalidPoolHistory.selector);this.importExternally(8);
    }
    function testOwnerOmissionCannotImportBackedLiabilities() public {
        recordsFor(40 ether);deploy(false);importAt(0);importAt(1);
        for(uint256 i=3;i<8;++i){
            vm.expectRevert(RecoursePoolHistory.InvalidPoolHistory.selector);this.importExternally(i);
        }
        assertEq(pool.importedPoolEntries(),2);
    }
    function testCustodyCutoffMustMatchTokenCutoff() public {
        recordsFor(40 ether);
        vm.mockCall(address(token.ownerAuthorization()),abi.encodeWithSignature("lastGoodBlock()"),abi.encode(uint256(99)));
        vm.expectRevert(ProvianMemberRecoursePool.InvalidInput.selector);this.deployExternally();
    }
    function deployExternally() external { deploy(false); }
    function testBreakDisablesOldPrimaryAndRequiresActualSnapshotRestoration() public {
        recordsFor(40 ether);deploy(true);importAll();token.mint(address(pool),100 ether);pool.activatePoolHistory();
        assertEq(pool.primaryAddress(ID),address(0));assertTrue(pool.requiresSnapshotRecovery(ID));
        vm.expectRevert(ProvianMemberRecoursePool.InvalidInput.selector);pool.bind(ID,address(this));
        token.ownerAuthorization().recover(ID,address(this)); // A prospective recovery is insufficient.
        vm.expectRevert(ProvianMemberRecoursePool.InvalidInput.selector);pool.withdrawRestoration(REQUEST,ID);
        address fresh=address(0xBEEF);token.ownerAuthorization().restore(ID,fresh);pool.bind(ID,fresh);
        assertFalse(pool.requiresSnapshotRecovery(ID));assertEq(pool.primaryAddress(ID),fresh);
        vm.expectRevert(ProvianMemberRecoursePool.Unauthorized.selector);pool.withdrawRestoration(REQUEST,ID);
        vm.prank(fresh);assertEq(pool.withdrawRestoration(REQUEST,ID),40 ether);
    }
}

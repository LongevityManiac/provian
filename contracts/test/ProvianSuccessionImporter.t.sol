// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {ProvianSuccessionImporter} from "../src/ProvianSuccessionImporter.sol";
import {ProvianPVT9} from "../src/ProvianPVT9.sol";

contract ImportHistoryFixture {
    uint256 public entries;
    address public constant predecessor = address(123);
    uint256 public constant lastGoodBlock = 10;
    mapping(bytes32 => bool) public imported;
    function importEntry(uint8 kind, bytes32 key, uint256 value, bytes32[] calldata) external {
        require(value != 99, "bad proof fixture"); entries += value;
        imported[sha256(abi.encode("Provian monetary history", predecessor, lastGoodBlock, kind, key, value))] = true;
    }
    function importBatch(bytes32 key, ProvianPVT9.BatchRecord calldata record, bytes32[] calldata) external {
        entries += record.claimCount;
        imported[sha256(abi.encode("Provian settlement history", predecessor, lastGoodBlock, key, sha256(abi.encode(record))))] = true;
    }
    function arbitrary() external { entries = 999; }
}
contract ImportBalanceFixture {
    uint256 public total;
    address public constant predecessor = address(123);
    uint256 public constant lastGoodBlock = 10;
    bool public constant cryptographicBreak = false;
    bytes32 public restorationRoot;
    mapping(address => bool) public migratedAddress;
    function importBalance(address oldOwner, address destination, uint256 amount, bytes32[] calldata) external {
        require(amount != 99, "bad proof fixture"); total += amount;
        migratedAddress[oldOwner] = true;
        restorationRoot = sha256(abi.encode("Provian balance succession", predecessor, lastGoodBlock, oldOwner, destination, amount));
    }
}
contract ProvianSuccessionImporterTest is Test {
    ImportHistoryFixture history;
    ImportBalanceFixture authorization;
    ProvianSuccessionImporter importer;
    function setUp() public {
        history = new ImportHistoryFixture(); authorization = new ImportBalanceFixture();
        importer = new ProvianSuccessionImporter(address(history), address(authorization));
    }
    function entry(uint256 amount) private view returns (bytes memory) {
        return abi.encodeCall(history.importEntry, (0, bytes32(uint256(1)), amount, new bytes32[](0)));
    }
    function balance(uint256 amount) private view returns (bytes memory) {
        return abi.encodeCall(authorization.importBalance, (address(uint160(amount)), address(2), amount, new bytes32[](0)));
    }
    function testPermissionlessBatchPreservesExactEntryBatchAndBalanceArguments() public {
        bytes[] memory calls = new bytes[](2); calls[0] = entry(3);
        ProvianPVT9.BatchRecord memory record; record.claimCount = 5;
        calls[1] = abi.encodeCall(history.importBatch, (bytes32(uint256(2)), record, new bytes32[](0)));
        vm.prank(address(777)); importer.importHistory(calls);
        assertEq(history.entries(), 8);
        importer.importHistory(calls); assertEq(history.entries(), 8);
        calls[0] = balance(7); calls[1] = balance(11);
        vm.prank(address(888)); importer.importBalances(calls);
        assertEq(authorization.total(), 18);
        bytes[] memory repeated = new bytes[](1); repeated[0] = balance(11);
        importer.importBalances(repeated); assertEq(authorization.total(), 18);
        repeated[0] = abi.encodeCall(authorization.importBalance, (address(11), address(999), 11, new bytes32[](0)));
        vm.expectRevert(ProvianSuccessionImporter.InvalidImport.selector); importer.importBalances(repeated);
    }
    function testBadLaterProofRollsBackEveryEarlierImport() public {
        bytes[] memory calls = new bytes[](2); calls[0] = entry(3); calls[1] = entry(99);
        vm.expectRevert(ProvianSuccessionImporter.InvalidImport.selector); importer.importHistory(calls);
        assertEq(history.entries(), 0);
        calls[0] = balance(7); calls[1] = balance(99);
        vm.expectRevert(ProvianSuccessionImporter.InvalidImport.selector); importer.importBalances(calls);
        assertEq(authorization.total(), 0);
    }
    function testCannotRedirectCallsInvokeOtherFunctionsOrCrossImportFamilies() public {
        bytes[] memory calls = new bytes[](1); calls[0] = abi.encodeCall(history.arbitrary, ());
        vm.expectRevert(ProvianSuccessionImporter.InvalidImport.selector); importer.importHistory(calls);
        calls[0] = balance(1);
        vm.expectRevert(ProvianSuccessionImporter.InvalidImport.selector); importer.importHistory(calls);
        calls[0] = entry(1);
        vm.expectRevert(ProvianSuccessionImporter.InvalidImport.selector); importer.importBalances(calls);
        calls[0] = hex"00";
        vm.expectRevert(ProvianSuccessionImporter.InvalidImport.selector); importer.importHistory(calls);
        vm.expectRevert(ProvianSuccessionImporter.InvalidImport.selector); importer.importHistory(new bytes[](0));
        assertEq(history.entries(), 0); assertEq(authorization.total(), 0);
    }
    function testConstructionRequiresTwoDistinctDeployedTargets() public {
        vm.expectRevert(ProvianSuccessionImporter.InvalidImport.selector); new ProvianSuccessionImporter(address(0), address(authorization));
        vm.expectRevert(ProvianSuccessionImporter.InvalidImport.selector); new ProvianSuccessionImporter(address(history), address(history));
    }
}

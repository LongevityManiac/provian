// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Immutable custody snapshot, imported one proof at a time. No caller
/// can choose a replacement party, amount or seed after construction.
abstract contract RecourseInstitutionSeeds {
    struct SeedManifest {
        address predecessor;
        uint256 cutoffBlock;
        bytes32 cutoffHash;
        bytes32 root;
        uint256 count;
        uint256 total;
    }
    bytes32 public immutable custodySeedDomain;
    bytes32 public immutable custodySeedRoot;
    uint256 public immutable custodySeedCount;
    uint256 public immutable custodySeedTotal;
    uint256 public importedCustodySeeds;
    uint256 public importedCustodyTotal;
    mapping(uint256 => bytes32) public importedCustodyLeaf;
    error InvalidCustodySeed();
    error CustodySeedsIncomplete();
    event CustodySeedImported(uint256 indexed index, bytes32 leaf, uint256 amount);
    constructor(address token, uint8 kind, SeedManifest memory manifest) {
        if (manifest.count == 0) {
            if (manifest.root != bytes32(0) || manifest.total != 0) revert InvalidCustodySeed();
        } else if (manifest.root == bytes32(0) || manifest.total == 0 || manifest.predecessor == address(0)
            || manifest.cutoffBlock == 0 || manifest.cutoffHash == bytes32(0)) revert InvalidCustodySeed();
        custodySeedDomain = sha256(abi.encode("Provian custody snapshot", block.chainid, token, kind,
            manifest.predecessor, manifest.cutoffBlock, manifest.cutoffHash));
        custodySeedRoot = manifest.root; custodySeedCount = manifest.count; custodySeedTotal = manifest.total;
    }
    function custodySeedsReady() public view returns (bool) {
        return importedCustodySeeds == custodySeedCount && importedCustodyTotal == custodySeedTotal;
    }
    modifier whenCustodyReady() { if (!custodySeedsReady()) revert CustodySeedsIncomplete(); _; }
    function importCustodySeed(uint256 index, bytes calldata data, bytes32[] calldata proof) external {
        if (index >= custodySeedCount || proof.length > 256) revert InvalidCustodySeed();
        bytes32 leaf = sha256(abi.encode(custodySeedDomain, index, sha256(data)));
        bytes32 digest = leaf;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            digest = digest < sibling ? sha256(abi.encodePacked(digest, sibling)) : sha256(abi.encodePacked(sibling, digest));
        }
        if (digest != custodySeedRoot) revert InvalidCustodySeed();
        if (importedCustodyLeaf[index] != bytes32(0)) {
            if (importedCustodyLeaf[index] != leaf) revert InvalidCustodySeed();
            return;
        }
        uint256 amount = _applyCustodySeed(data);
        importedCustodyLeaf[index] = leaf; ++importedCustodySeeds; importedCustodyTotal += amount;
        if (importedCustodyTotal > custodySeedTotal || (importedCustodySeeds == custodySeedCount
            && importedCustodyTotal != custodySeedTotal)) revert InvalidCustodySeed();
        emit CustodySeedImported(index, leaf, amount);
    }
    function _applyCustodySeed(bytes calldata data) internal virtual returns (uint256);
}

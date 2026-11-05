// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MockPVT
 * @notice Minimal stand-in for ProvianPVTv3, used ONLY by Hardhat tests.
 *
 * Implements just the surface FoundationMembership (and similar contracts)
 * touch: balance tracking, approvals, transfer / transferFrom, and
 * protocolBurn. The `transferFromShouldFail` switch exists to exercise the
 * FeeTransferFailed branch.
 *
 * Not wired into any production deploy script.
 */
contract MockPVT {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalBurned;
    uint256 public totalSupply;

    bool public transferFromShouldFail;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (transferFromShouldFail) return false;
        require(allowance[from][msg.sender] >= amount, "no allowance");
        require(balanceOf[from] >= amount, "insufficient");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function protocolBurn(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "burn underflow");
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        totalBurned += amount;
    }

    function setTransferFromShouldFail(bool v) external {
        transferFromShouldFail = v;
    }

    // --- Unused IPVT surface (stubs to satisfy the interface) ---

    function slashReputation(address, uint256, address) external {}
    function voiceBurn(uint256, uint256) external {}
    function burnForProposal(address, uint256) external {}
    function setVoiceContract(address) external {}

    function currentSupplyScaler() external pure returns (uint256) { return 1e18; }
    function effectiveMintRate() external pure returns (uint256) { return 1e18; }
    function stakeRatioBps() external pure returns (uint256) { return 500; }

    function tokenomicSnapshot() external pure returns (
        uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, bool, uint256
    ) {
        return (0, 0, 0, 0, 0, 0, 0, 0, 0, false, 0);
    }
}

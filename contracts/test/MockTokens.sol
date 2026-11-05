// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../src/interfaces/IERC20.sol";
import {IPVT} from "../src/interfaces/IPVT.sol";

/**
 * @title MockUSDC
 * @notice Minimal ERC20 with 6 decimals for testing Provian Agent Bank V4
 *         contracts. Anyone can mint to anyone - simplifies test setup.
 */
contract MockUSDC is IERC20 {
    string public constant name = "Mock USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/**
 * @title MockPVT
 * @notice Minimal IPVT-conformant token for testing. 18 decimals.
 *
 *         Implements BOTH burn surfaces, because the suites that share this
 *         mock now straddle two generations of the PVT interface:
 *           - burn(uint256)         - the PVT9 self-burn (IPVTBurnable), called
 *             by the ported Agent Bank fee sinks: EscrowV4 / PromiseV3 /
 *             PoolV3 / BondPool.
 *           - protocolBurn(uint256) - the legacy PVTv3-PVTv8 registered-contract
 *             burn (IPVT), still called by the UNPORTED EscrowV3 / PoolV2 /
 *             PromiseV2 / FoundationMembership. ProvianCourtV2.t.sol drives a
 *             real ProvianEscrowV3 against this mock, so this surface is still
 *             live-reachable and must not be removed.
 *
 *         Tracks totalBurned and per-burner totals so test invariants can
 *         assert that PVT fee paths always reach a burn and never leak to
 *         feeWallet (which holds USDC only). Both burn paths feed the SAME
 *         counters, so a sink's burned amount is asserted identically before
 *         and after the protocolBurn -> burn port. These counters are mock
 *         instrumentation for assertions - real ProvianPVT9 has no totalBurned
 *         storage.
 *
 *         Mock-specific: anyone can call either burn entrypoint. Production
 *         PVTv3-PVTv8 restrict protocolBurn to registered contracts via
 *         setProtocolContract; PVT9's burn is an unrestricted self-burn of the
 *         caller's own balance. The point of these tests is to verify the sink
 *         contracts burn the right amounts; PVT-side authorization is verified
 *         separately in PVT-specific tests.
 */
contract MockPVT is IPVT {
    string public constant name = "Mock PVT";
    string public constant symbol = "PVT";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // Burn tracking for test invariants. Path-AGNOSTIC: fed by both burn()
    // and protocolBurn(), so burned-amount assertions keep their exact
    // expected values across the port.
    uint256 public totalBurned;
    mapping(address => uint256) public burnedBy;

    // Path-DISCRIMINATING counters: incremented ONLY by burn() (the PVT9
    // self-burn), never by protocolBurn(). These let the ported sinks' suites
    // assert WHICH entrypoint was called, so a silent regression back to
    // protocolBurn cannot pass on the amount assertions alone.
    uint256 public totalSelfBurned;
    mapping(address => uint256) public selfBurnedBy;

    // Reputation staking surface (kept simple for tests)
    mapping(address => uint256) public reputationStakes;
    uint256 public totalSlashed;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event ProtocolBurned(address indexed burner, uint256 amount);
    // Mirrors ProvianPVT9's burn event exactly (src/ProvianPVT9.sol).
    event Burned(address indexed holder, uint256 amount);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    /**
     * @dev PVT9 self-burn (IPVTBurnable) - burns msg.sender's OWN balance.
     *      Bookkeeping is identical to protocolBurn below, so burn-amount
     *      assertions are unchanged across the port. Underflow on an
     *      over-burn reverts via checked arithmetic here; real PVT9 reverts
     *      with InsufficientBalance() - both fail closed.
     *      Emit order follows real ProvianPVT9._burn (Transfer, then Burned).
     */
    function burn(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        totalBurned += amount;
        burnedBy[msg.sender] += amount;
        totalSelfBurned += amount;
        selfBurnedBy[msg.sender] += amount;
        emit Transfer(msg.sender, address(0), amount);
        emit Burned(msg.sender, amount);
    }

    /// @dev Legacy PVTv3-PVTv8 registered-contract burn (IPVT). Retained for the
    ///      unported sinks (EscrowV3 / PoolV2 / PromiseV2 / FoundationMembership).
    function protocolBurn(uint256 amount) external override {
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        totalBurned += amount;
        burnedBy[msg.sender] += amount;
        emit ProtocolBurned(msg.sender, amount);
        emit Transfer(msg.sender, address(0), amount);
    }

    function slashReputation(address agent, uint256 amount, address recipient) external override {
        reputationStakes[agent] -= amount;
        uint256 burnPortion = (amount * 1000) / 10000;
        uint256 payout = amount - burnPortion;
        totalBurned += burnPortion;
        totalSlashed += amount;
        balanceOf[recipient] += payout;
        emit Transfer(address(0), recipient, payout);
    }

    // --- Unused IPVT surface - minimal stubs so the interface is satisfied ---

    function voiceBurn(uint256, uint256 amount) external override {
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        totalBurned += amount;
    }

    function burnForProposal(address proposer, uint256 amount) external override {
        balanceOf[proposer] -= amount;
        totalSupply -= amount;
        totalBurned += amount;
    }

    function setVoiceContract(address) external override {}

    function currentSupplyScaler() external pure override returns (uint256) {
        return 1e18;
    }

    function effectiveMintRate() external pure override returns (uint256) {
        return 1e18;
    }

    function stakeRatioBps() external pure override returns (uint256) {
        return 0;
    }

    function tokenomicSnapshot() external view override returns (
        uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, bool, uint256
    ) {
        return (totalSupply, totalSupply, 0, totalBurned, totalSupply + totalBurned, 1e18, 1e18, 0, 0, false, 0);
    }
}

/**
 * @title MockBlacklistUSDC
 * @notice MockUSDC that REVERTS on transfer/transferFrom whenever the `to` or
 *         `from` address is blacklisted — mirroring Circle's real USDC, which
 *         reverts (does NOT return false) to a blacklisted counterparty. Used to
 *         reproduce Pass-3 #5 (a single reverting contributor freezing a pool)
 *         and #18 (a reverting recipient bricking the release verdict).
 */
contract MockBlacklistUSDC is IERC20 {
    string public constant name = "Mock Blacklist USDC";
    string public constant symbol = "bUSDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blacklisted;

    error AccountBlacklisted(address account);

    function setBlacklisted(address account, bool value) external {
        blacklisted[account] = value;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (blacklisted[msg.sender]) revert AccountBlacklisted(msg.sender);
        if (blacklisted[to]) revert AccountBlacklisted(to);
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (blacklisted[from]) revert AccountBlacklisted(from);
        if (blacklisted[to]) revert AccountBlacklisted(to);
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/**
 * @title MockBlacklistPVT
 * @notice IPVT-conformant token that REVERTS on transfer/transferFrom to/from a
 *         blacklisted address. The PVT twin of MockBlacklistUSDC, so the escrow
 *         PVT-principal dispute path can be exercised against a reverting recipient
 *         (Pass-3 #18). Burn bookkeeping mirrors MockPVT, including carrying BOTH
 *         the PVT9 burn(uint256) and the legacy protocolBurn(uint256) surfaces
 *         onto the same totalBurned / burnedBy counters.
 */
contract MockBlacklistPVT is IPVT {
    string public constant name = "Mock Blacklist PVT";
    string public constant symbol = "bPVT";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blacklisted;

    // Path-agnostic (both burn paths) and path-discriminating (burn() only)
    // counters, same contract as MockPVT above.
    uint256 public totalBurned;
    mapping(address => uint256) public burnedBy;
    uint256 public totalSelfBurned;
    mapping(address => uint256) public selfBurnedBy;

    error AccountBlacklisted(address account);

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event ProtocolBurned(address indexed burner, uint256 amount);
    // Mirrors ProvianPVT9's burn event exactly (src/ProvianPVT9.sol).
    event Burned(address indexed holder, uint256 amount);

    function setBlacklisted(address account, bool value) external {
        blacklisted[account] = value;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        if (blacklisted[msg.sender]) revert AccountBlacklisted(msg.sender);
        if (blacklisted[to]) revert AccountBlacklisted(to);
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        if (blacklisted[from]) revert AccountBlacklisted(from);
        if (blacklisted[to]) revert AccountBlacklisted(to);
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    /// @dev PVT9 self-burn (IPVTBurnable). Same bookkeeping as protocolBurn; see MockPVT.burn.
    function burn(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        totalBurned += amount;
        burnedBy[msg.sender] += amount;
        totalSelfBurned += amount;
        selfBurnedBy[msg.sender] += amount;
        emit Transfer(msg.sender, address(0), amount);
        emit Burned(msg.sender, amount);
    }

    /// @dev Legacy PVTv3-PVTv8 registered-contract burn (IPVT). Retained for unported sinks.
    function protocolBurn(uint256 amount) external override {
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        totalBurned += amount;
        burnedBy[msg.sender] += amount;
        emit ProtocolBurned(msg.sender, amount);
        emit Transfer(msg.sender, address(0), amount);
    }

    function slashReputation(address, uint256, address) external override {}
    function voiceBurn(uint256, uint256 amount) external override {
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        totalBurned += amount;
    }
    function burnForProposal(address proposer, uint256 amount) external override {
        balanceOf[proposer] -= amount;
        totalSupply -= amount;
        totalBurned += amount;
    }
    function setVoiceContract(address) external override {}
    function currentSupplyScaler() external pure override returns (uint256) { return 1e18; }
    function effectiveMintRate() external pure override returns (uint256) { return 1e18; }
    function stakeRatioBps() external pure override returns (uint256) { return 0; }
    function tokenomicSnapshot() external view override returns (
        uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, bool, uint256
    ) {
        return (totalSupply, totalSupply, 0, totalBurned, totalSupply + totalBurned, 1e18, 1e18, 0, 0, false, 0);
    }
}

/// @dev Minimal stand-in for the Court's arbitrator-reward sink. A BondPool
///      UNIT test wires `courtContract` to a stand-in address; since slashBond/dismissClaim
///      now route the claim processing fee to courtContract and call fundBondClaimReward on
///      it, that address MUST be a contract implementing this selector (in production it is
///      the real ProvianCourtV2). Records what it received so a unit test can assert the fee
///      was routed to the panel sink rather than to Provian Tech.
contract MockCourtRewardSink {
    uint256 public totalFunded;
    mapping(bytes32 => uint256) public fundedFor;

    function fundBondClaimReward(bytes32 claimId, uint256 amount) external {
        totalFunded += amount;
        fundedFor[claimId] += amount;
    }

    /// @dev the pool asks the Court whether a claim is under a live panel before
    ///      letting it expire. A unit-test stand-in has no panels unless a test opens one.
    mapping(bytes32 => bool) public openCase;

    function setBondClaimCaseOpen(bytes32 claimId, bool open) external {
        openCase[claimId] = open;
    }

    function bondClaimCaseOpen(bytes32 claimId) external view returns (bool) {
        return openCase[claimId];
    }
}

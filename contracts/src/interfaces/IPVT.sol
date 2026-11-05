// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @dev Minimal interface for ProvianPVT - used by Agent Bank contracts
 *      for PVT fee payment (protocolBurn at 50% discount), reputation slashing,
 *      voice burns, and governance proposal burns.
 *
 *      Historical compatibility interface spanning PVTv3/PVTv4 and the burn/
 *      transfer subset used by current Agent Bank contracts. PVTv4 added the differential
 *      Foundation rate surface (getCurrentAgentFoundationBPS,
 *      getAutomaticBaseline, getCompositionFraction, activationState). Agent
 *      Bank callers do not need to know about those functions; they are
 *      exposed here so downstream integrations (backend, SDK, analytics) can
 *      type against a single interface. This interface does not define policy
 *      authority: live PVTv8 economic setters are Frank-EOA-direct, while the
 *      executor/governance/Safe paths are dormant and non-gating for PVT9 bootstrap.
 *      Human-resolving and Genesis mints use 99/0.5/0.5; agent-side contributor
 *      residuals use the prospective Foundation rate and beneficiary snapshot.
 */
interface IPVT {
    // ERC-20 surface and PVTv3 compatibility
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function protocolBurn(uint256 amount) external;
    function slashReputation(address agent, uint256 amount, address recipient) external;
    function voiceBurn(uint256 sessionSeconds, uint256 amount) external;
    function burnForProposal(address proposer, uint256 amount) external;
    function setVoiceContract(address _voice) external;
    function currentSupplyScaler() external view returns (uint256);
    function effectiveMintRate() external view returns (uint256);
    function stakeRatioBps() external view returns (uint256);
    function tokenomicSnapshot() external view returns (
        uint256 _totalSupply,
        uint256 _circulatingSupply,
        uint256 _totalStaked,
        uint256 _totalBurned,
        uint256 _totalEverMinted,
        uint256 _effectiveMintRate,
        uint256 _supplyScaler,
        uint256 _stakeRatioBps,
        uint256 _currentEpoch,
        bool _circuitBreakerTripped,
        uint256 _supplyTier
    );
}

/**
 * @dev Differential-rate surface added in PVTv4. Downstream consumers
 *      (backend minter, analytics, dashboards) that need the agent
 *      Foundation rate or composition metric type against this extension.
 *      The split between IPVT and IPVTv4Extension keeps IPVT minimal for
 *      Agent Bank V4 contracts that only need burn and transfer behavior.
 */
interface IPVTv4Extension {
    function VERSION() external view returns (string memory);
    function activationState() external view returns (uint8);
    function getCurrentAgentFoundationBPS() external view returns (uint256);
    function getAutomaticBaseline() external view returns (uint256);
    function getCompositionFraction() external view returns (uint256);
    function baselineBPS() external view returns (uint256);
    function standardGovBPS() external view returns (uint256);
    function emergencyGovBPS() external view returns (uint256);
    function PROVIAN_BPS() external view returns (uint256);
    function HUMAN_FOUNDATION_BPS() external view returns (uint256);
    function emergencyLastInvoked() external view returns (uint256);
    function EMERGENCY_COOLDOWN_SECONDS() external view returns (uint256);
    function registry() external view returns (address);
    function verificationInfrastructure() external view returns (address);
    function humanGovernanceContract() external view returns (address);
}

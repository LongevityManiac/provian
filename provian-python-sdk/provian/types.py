"""Type definitions for the Provian SDK."""

from typing import TypedDict, Optional, Dict, List, Any


class PEMetadata(TypedDict, total=False):
    """Optional metadata attached to a Provenance Envelope."""
    tool: str
    input_hash: str
    output_hash: str
    model_id: str


class ReplicationPack(TypedDict, total=False):
    """Replication pack recording the software_verified attestation tier.

    A pricing upgrade (0.8x -> 1.2x) on standard-priced action types; on the
    evidence-priced compute/work family self-attested
    software earns the family discount at 0.8x, while a replication pack's
    software_verified is capped at the family's flat 1.0x, parity with proof.
    """
    input_hash: str
    output_hash: str
    model_id: str
    model_checkpoint_hash: str
    pack_hash: str


class RecordedPE(TypedDict):
    """What ``PeRecorder.record`` returns: the PE kept on this machine (the relay keeps none)."""
    pe_id: str
    pe_hash: str
    recorded_locally: bool


class MeterActReceipt(TypedDict, total=False):
    """One act in a batch receipt (relay-assigned; never part of the PE)."""
    pe_id: str
    pe_hash: str
    relay_pe_id: str
    leaf_index: int
    disposition: str
    reason: str
    note: str
    record_points_atomic: str
    mint_status: Optional[str]


class MeterBatchReceipt(TypedDict, total=False):
    """The relay's answer to POST /v1/meter/batch, filed beside the PEs (receipts.jsonl)."""
    schema: str
    device_id: str
    actor_id: str
    seq: int
    batch_hash: str
    acts_root: str
    batch_leaf: str
    accepted_at_ms: int
    acts: List[MeterActReceipt]
    totals: Dict[str, Any]


class ProvisionalStatus(TypedDict):
    """Response from GET /v1/provisional/:identifier/status."""
    pe_count: int
    estimated_pvt: float
    claimed: bool
    chain_age_days: int


class ActivitySummary(TypedDict, total=False):
    """Activity summary in agent profile."""
    first_pe_at: int
    last_pe_at: int
    chain_age_days: int
    active_days: int


class TrustSignals(TypedDict, total=False):
    """Trust signals in agent profile."""
    has_human_link: bool
    human_attestations: int
    unique_artifact_invokers: int
    governance_score: int


class AgentProfile(TypedDict, total=False):
    """Response from GET /v1/agents/:identifier/profile."""
    identifier: str
    wallet_type: str
    wallet_address: Optional[str]
    pe_count: int
    estimated_pvt: float
    attestation_tiers: Dict[str, int]
    action_type_breakdown: Dict[str, int]
    activity_summary: ActivitySummary
    trust_signals: TrustSignals
    badges: List[str]
    claimed: bool
    public_url: str


class Artifact(TypedDict, total=False):
    """Commons artifact."""
    artifact_id: str
    creator_wallet_id: str
    type: str
    name: str
    description: str
    version: str
    content_hash: str
    tags: List[str]
    stake_pvt: float
    invocation_count: int
    human_attestation_count: int
    visibility_score: int
    created_at: int
    deprecated: bool


class ArtifactListResponse(TypedDict, total=False):
    """Response from GET /v1/commons/artifacts."""
    artifacts: List[Artifact]
    next_cursor: Optional[str]


class ArtifactInvokeResponse(TypedDict, total=False):
    """Response from POST /v1/commons/artifacts/:id/invoke."""
    invocation_id: str
    artifact_id: str
    pe_id: str
    residual_pvt: float

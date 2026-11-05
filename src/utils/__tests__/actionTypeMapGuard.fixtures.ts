/**
 * REAL pre-fix source, copied verbatim from master at `16b9ed2c` the commit
 * before // removed these.
 *
 * The synthetic fixtures in the suite prove each RULE fires. These prove the
 * rules match the code that actually SHIPPED: every shape below reached users,
 * and `AgentAuthorizationScreen_rawFallback` rendered "SHARE_DATA" to them. A
 * detector validated only against examples its own author imagined is tuned to
 * that author's imagination — the first draft of this file truncated the
 * ActionApproval map mid-literal, which left it below the key threshold and
 * passed nothing, and the control caught exactly that.
 *
 * Do not "tidy" these. Their value is being byte-identical to what shipped.
 */

export const PRE_FIX_SOURCES: ReadonlyArray<{
    readonly name: string;
    readonly source: string;
    readonly expect: readonly string[];
}> = [
    {
        name: 'AgentDetailScreen_humanizer',
        expect: ['local_humanizer'],
        source: `
function humanizeActionType(actionType: string): string {
    if (!actionType) return 'Activity';
    const s = actionType.replace(/_/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
}
`,
    },
    {
        name: 'AgentAuthorizationScreen_typeConfig',
        expect: ['local_action_type_map'],
        source: `
                                        const typeConfig: Record<string, { icon: string; color: string; label: string }> = {
                                            public_post: { icon: 'megaphone', color: COLORS.primary, label: 'Social Post' },
                                            system_access: { icon: 'terminal', color: '#4CC38A', label: 'System Access' },
                                            uncategorized: { icon: 'ellipsis-horizontal-circle', color: '#6B7280', label: 'Action' },
                                            egress_data: { icon: 'globe', color: '#EC4899', label: 'Data Egress' },
                                        };
`,
    },
    {
        name: 'AgentAuthorizationScreen_rawFallback',
        expect: ['inline_action_type_format'],
        source: `
                                                    {config ? config.label.toUpperCase() : request.actionType.toUpperCase()}
`,
    },
    {
        name: 'ActionApprovalScreen_ACTION_CONFIG',
        expect: ['local_action_type_map'],
        source: `
const ACTION_CONFIG = {
    communicate: {
        icon: 'chatbubbles' as const,
        color: '#6BA3F0', // blue
        titleKey: 'actionApproval.messageApproval',
        bannerKey: 'actionApproval.messageBanner',
    },
    commit: {
        icon: 'calendar' as const,
        color: '#E8A838', // orange
        titleKey: 'actionApproval.commitmentApproval',
        bannerKey: 'actionApproval.commitmentBanner',
    },
    share_data: {
        icon: 'share-social' as const,
        color: COLORS.error, // red
        titleKey: 'actionApproval.dataSharingApproval',
        bannerKey: 'actionApproval.dataSharingBanner',
    },
    public_post: {
        icon: 'megaphone' as const,
        color: '#9B72F0', // purple
        titleKey: 'actionApproval.publicPostApproval',
        bannerKey: 'actionApproval.publicPostBanner',
    },
    system_access: {
        icon: 'terminal' as const,
        color: COLORS.error, // red - high risk
        titleKey: 'actionApproval.systemAccessApproval',
        bannerKey: 'actionApproval.systemAccessBanner',
    },
    uncategorized: {
        icon: 'help-circle' as const,
        color: COLORS.warning, // amber
        titleKey: 'actionApproval.uncategorizedApproval',
        bannerKey: 'actionApproval.uncategorizedBanner',
    },
    egress_data: {
        icon: 'cloud-upload' as const,
        color: '#22B8CF', // cyan
        titleKey: 'actionApproval.egressDataApproval',
        bannerKey: 'actionApproval.egressDataBanner',
    },
};
`,
    },
    {
        name: 'AIControlsDashboardScreen_NON_FINANCIAL',
        expect: ['local_action_type_map'],
        source: `
const NON_FINANCIAL_ACTION_CONFIG: Record<string, { icon: IoniconsName; color: string; label: string }> = {
    communicate: { icon: 'chatbubbles', color: '#6BA3F0', label: 'Message' },
    commit: { icon: 'calendar', color: '#E8A838', label: 'Commitment' },
    share_data: { icon: 'share-social', color: COLORS.error, label: 'Data Sharing' },
    public_post: { icon: 'megaphone', color: COLORS.primary, label: 'Social Post' },
    system_access: { icon: 'terminal', color: '#4CC38A', label: 'System' },
    uncategorized: { icon: 'ellipsis-horizontal-circle', color: '#6B7280', label: 'Action' },
    egress_data: { icon: 'cloud-upload', color: '#22B8CF', label: 'Data Egress' },
};
`,
    },
];

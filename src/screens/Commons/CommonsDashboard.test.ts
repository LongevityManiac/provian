/**
 * The Commons tab (four tabs — Feed · Work · People · Inbox).
 *
 * The Vitest harness here has no React renderer wired up, so these assert the invariants at the
 * source level (the same deterministic strategy as CommonsGovernance.test.ts). Each block names the
 * earlier ruling it still carries forward into the new layout.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    LIVE_INSTITUTION_ROW,
    NOT_OPEN_INSTITUTION_ROW,
    INSTITUTION_NAME_KEYS,
    INSTITUTION_SCREENS,
    selectInstitutionRows,
} from '../../core/commons/institutionRows';
import en from '../../i18n/locales/en.json';

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');
const SRC = read('CommonsDashboard.tsx');
const PEOPLE = read('tabs/CommonsPeopleTab.tsx');
const INBOX = read('tabs/CommonsInboxTab.tsx');
const ABOUT = read('tabs/CommonsAboutSheet.tsx');
const LAYOUT = read('tabs/layout.ts');
const WORK = read('tabs/CommonsWorkTab.tsx');

describe('Commons tab - four tabs across the top ', () => {
    it('declares exactly Feed, Work, People, Inbox, with Feed first (the default)', () => {
        expect(SRC).toContain("const HOME_TABS: readonly CommonsHomeTab[] = ['feed', 'work', 'people', 'inbox'];");
        expect(SRC).toContain("useState<CommonsHomeTab>('feed')");
    });

    it('renders the forum feed, work, people, and inbox tabs', () => {
        expect(SRC).toContain('<ForumFeed navigation={navigation} />');
        expect(SRC).toContain('<CommonsWorkTab navigation={navigation} />');
        expect(SRC).toContain('<CommonsPeopleTab navigation={navigation} />');
        expect(SRC).toContain("<CommonsInboxTab navigation={navigation} active={tab === 'inbox'} />");
    });

    it('badges the Inbox tab with the unread count', () => {
        expect(SRC).toContain("badge: inboxUnread");
    });

    it('keeps visited tabs mounted so switching back keeps your place', () => {
        expect(SRC).toContain('visited.has(k)');
        expect(SRC).toContain("display: 'none'");
    });
});

describe('Commons tab - joined agent profile lookup (C9, now on People)', () => {
    // the relay's only agent record is the beneficiary-linked record (`linked_agents[]`),
    // which carries the wallet id as `wallet_id` and the runtime id as `agent_id`.
    it('iterates the linked-agent records (the only relay-side agent record)', () => {
        expect(PEOPLE).toContain('linkedData.linked_agents.map(async (a) =>');
    });

    it("looks up the Commons profile by the linked record's wallet id", () => {
        expect(PEOPLE).toContain('getAgentProfile(a.wallet_id)');
        expect(PEOPLE).not.toContain('getAgentProfile(a.agent_id)');
        expect(PEOPLE).not.toContain('getAgentProfile(s.agent_id)');
    });

    it('still keys the resulting map by agent_id (the render lookup key)', () => {
        expect(PEOPLE).toContain('profileMap.set(a.agent_id, p)');
    });

    it("goes straight to the AGENT connect flow when there are no agents", () => {
        expect(PEOPLE).toContain("navigation.navigate('ConnectAgent', { mode: 'agent' })");
    });
});

describe('Commons tab - pending consent is a live call-to-action (P4-10, now in Inbox)', () => {
    it('lists pending requests in the Inbox and opens the response surface', () => {
        expect(INBOX).toContain('getPendingConsents');
        expect(INBOX).toContain("navigation.navigate('CommonsConsentRequests')");
    });

    it("RED guard : a hidden Inbox never loads or marks replies seen", () => {
        expect(INBOX).toContain('if (active) void load();');
        expect(INBOX).toContain('[active, load]');
    });

    it('opens a reply in its thread, focused on the comment', () => {
        expect(INBOX).toContain("navigation.navigate('CommonsForumPost', { postId: item.postId, focusCommentId: item.commentId })");
    });
});

describe('Commons tab - clears the floating navigation bar', () => {
    it('reserves the same 120-point clearance as the other root tabs', () => {
        expect(LAYOUT).toContain('export const FLOATING_TAB_BAR_CLEARANCE = 120;');
        expect(INBOX).toContain('paddingBottom: FLOATING_TAB_BAR_CLEARANCE');
    });
});

describe('Commons tab - operator announcements', () => {
    // Operator broadcast: a pinned announcement + push to all users. The composer is gated on the
    // server-provided capability, never a client-only guess. (The pinned card lives in the Feed.)
    it('renders the operator composer only when the backend grants the capability', () => {
        expect(SRC).toContain('canAnnounce');
        expect(SRC).toContain('getAnnounceCapability');
        expect(SRC).toContain('{canAnnounce && (');
    });
});

describe('Commons tab - About sheet keeps the dashboard content (not-open-yet row)', () => {
    it('names the SAME institution rows as the Work-tab cards, and keeps the activity list', () => {
        expect(ABOUT).toContain('selectInstitutionRows(institutions)');
        expect(ABOUT).toContain("commonsDashboard.notOpenYet");
        expect(ABOUT).toContain('commonsDashboard.recentActivity');
        // rows are chosen by id, never by audience (the Market is audience 'both').
        expect(ABOUT).not.toContain("i.audience === 'agent'");
    });

    it('contains no retired Research or Standards institution', () => {
        expect(ABOUT).not.toContain('research');
        expect(ABOUT).not.toContain('standards');
    });
});

describe('Commons › Work - institution cards (rows, restored)', () => {
    it('pins the LIVE row to exactly Escrow, Bonds, Agent market (by id, in order;)', () => {
        expect([...LIVE_INSTITUTION_ROW]).toEqual(['escrow', 'bonds', 'market']);
    });

    it('pins the NOT OPEN row to exactly Disputes, Voting, Compute market, Insurance (Court is not activated,)', () => {
        expect([...NOT_OPEN_INSTITUTION_ROW]).toEqual(['court', 'governance', 'compute', 'insurance']);
    });

    it('renders every card even before the catalog loads (RED control: an empty catalog drops nothing)', () => {
        const rows = selectInstitutionRows([]);
        expect(rows.live.map((c) => c.id)).toEqual(['escrow', 'bonds', 'market']);
        expect(rows.notOpen.map((c) => c.id)).toEqual(['court', 'governance', 'compute', 'insurance']);
    });

    it('selects by id from the catalog, not by audience (market is audience both)', () => {
        const rows = selectInstitutionRows([
            { id: 'market', name: 'Agent market', description: '', route: '/commons/market', status: 'live', audience: 'both' },
            { id: 'escrow', name: 'Escrow', description: '', route: '/commons/escrow', status: 'unavailable', audience: 'agent' },
        ]);
        expect(rows.live.find((c) => c.id === 'market')?.info?.audience).toBe('both');
        expect(rows.live.find((c) => c.id === 'escrow')?.info?.name).toBe('Escrow');
    });

    it('no tile does nothing on tap — every LIVE card opens its screen, every NOT OPEN card explains itself', () => {
        expect(INSTITUTION_SCREENS).toEqual({ escrow: 'CommonsInstitutions', bonds: 'CommonsBonds', market: 'CommonsMarket' });
        const rows = selectInstitutionRows([]);
        // RED control: a card with neither a screen nor an explanation is exactly the inert tile.
        for (const c of rows.live) expect(c.screen, c.id).not.toBeNull();
        for (const c of rows.notOpen) {
            expect(c.screen, c.id).toBeNull();
            expect(c.notOpenBodyKey, c.id).not.toBeNull();
        }
        // The Work tab has no non-pressable tile wrapper left.
        expect(WORK).not.toMatch(/<View\s+key=\{c\.id\}/);
        expect(WORK).toContain('c.notOpenBodyKey');
        const dash = (en as { commonsDashboard: Record<string, string> }).commonsDashboard;
        for (const c of rows.notOpen) expect(typeof dash[c.notOpenBodyKey!.replace('commonsDashboard.', '')], c.id).toBe('string');
    });

    it('the Escrow and Bonds screens attach the wallet token (pre-launch the gate 404s a tokenless read)', () => {
        const svc = read('../../core/commons/CommonsService.ts');
        expect(svc).toContain("request('GET', '/institutions/stats', undefined, true, biometricAction)");
        expect(svc).toContain("request('GET', '/bonds/stats', undefined, true, biometricAction)");
        // RED control: the pre-fix tokenless form is gone.
        expect(svc).not.toMatch(/request\('GET', '\/(bank|bonds)\/stats'\)/);
    });

    it('every card name is a real English key (localized across the 12 locales by the parity guard)', () => {
        const dash = (en as { commonsDashboard: Record<string, string> }).commonsDashboard;
        for (const key of Object.values(INSTITUTION_NAME_KEYS)) {
            const leaf = key.replace('commonsDashboard.', '');
            expect(typeof dash[leaf], key).toBe('string');
        }
    });

    it('the Work tab renders both rows at its top', () => {
        expect(WORK).toContain('selectInstitutionRows(catalog)');
        expect(WORK).toContain('rows.live.map');
        expect(WORK).toContain('rows.notOpen.map');
        expect(WORK).toContain("t('commonsDashboard.institutionsLive')");
    });
});

/**
 * phone regression (2026-09-23, iPhone): the Work tab stacked the institution cards, the
 * Jobs/Requests switch, the hint, the board's tabs and two filter rows as FIXED chrome above the
 * list, so the list got a sliver of height behind the floating tab bar and the first job card
 * could not be seen. The chrome now scrolls WITH the list.
 */
const JOBS = read('CommonsHumanJobs.tsx');
const WANTS = read('CommonsWants.tsx');

/** Everything between the first `<ScrollView` that follows `marker` and its closing tag. */
function scrollBodyAfter(src: string, marker: string): string {
    const at = src.indexOf(marker);
    if (at < 0) return '';
    const open = src.indexOf('<ScrollView', at);
    const close = src.indexOf('</ScrollView>', open);
    return open < 0 || close < 0 ? '' : src.slice(open, close);
}

describe('Commons › Work — the header scrolls with the list (phone regression)', () => {
    it('the Work tab hands its cards + switch to the board as `header`, rendering no fixed chrome of its own', () => {
        expect(WORK).toContain('<CommonsHumanJobs navigation={navigation} embedded header={header} />');
        expect(WORK).toContain('<CommonsWants navigation={navigation} embedded header={header} />');
        const ret = WORK.slice(WORK.lastIndexOf('  return (\n    <View style={styles.container}>'));
        expect(ret).not.toContain('rows.live.map');
        expect(ret).not.toContain('styles.switchRow');
    });

    it('embedded, the jobs board renders the header AND its tabs/filters inside the one list ScrollView', () => {
        const body = scrollBodyAfter(JOBS, '{embedded ? (');
        expect(body.length).toBeGreaterThan(0);
        expect(body).toContain('{header}');
        expect(body).toContain('{controls}');
        expect(body).toContain('listBody');
        expect(JOBS).toContain('{!embedded && controls}');
    });

    it('the requests board renders the header inside its list ScrollView', () => {
        const body = scrollBodyAfter(WANTS, '<ScrollView contentContainerStyle');
        expect(body).toContain('{header}');
    });

    it('RED: the pre-fix shape (chrome fixed above an embedded list) is refused by the same check', () => {
        const prefix = [
            '{/* Tab Bar */}', '<View style={styles.tabBar}>', '</View>',
            '{/* Job List */}', '{loading ? (<Spinner/>) : (', '<ScrollView style={styles.scrollView}>',
            '<View style={styles.banner}/>', '</ScrollView>', ')}',
        ].join('\n');
        expect(scrollBodyAfter(prefix, '{embedded ? (')).toBe('');
        expect(scrollBodyAfter(prefix, '{/* Job List */}')).not.toContain('{header}');
    });
});

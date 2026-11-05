/**
 * speechGate — "a presentation opens a voice, once" on the phone, presented as the TALKING PASS
 *.
 *
 * Every Commons write (forum post / reply / vote / flag, a want, a job post, a thread with a
 * stranger) needs a LIVE presentation window: the relay answers 428 `rail_handshake_required`
 * with `present_to` (the audience — 'provian:commons' or a wallet id) when none is live. This
 * helper recognizes that refusal and offers the one action that opens the window: a burn-backed
 * presentation to that audience from the HumanPresentment screen (self-challenged, one burn at
 * the presentation floor, seven days). Nothing else is charged inside the window, and every
 * speech act mints once at its class base, bounded by that burn.
 *
 * The forum screens use the fuller flow in `pendingSpeech.ts` (save the action, one sheet, resume on
 * return). `offerSpeechWindow` stays for the other screens: it opens the same sheet through the
 * talking-pass host, or falls back to an Alert when the caller has its own Modal open (a second
 * Modal cannot stack over it) or no host is mounted.
 */
import { Alert } from 'react-native';
import type { TFunction } from 'i18next';
import { CommonsError } from './CommonsService';
import { presentTalkingPass } from './talkingPassBus';

export function speechWindowRequired(err: unknown): string | null {
    if (err instanceof CommonsError && err.status === 428 && err.reason === 'rail_handshake_required') {
        return err.presentTo ?? 'provian:commons';
    }
    return null;
}

/** The presentation floor (reputation tier). The relay's live floor is read on the burn screen. */
export const PRESENTATION_FLOOR_PVT = 15;

/** What a talking pass (speech window) is opened at: one presentation at the floor. */
export const SPEECH_WINDOW_BURN_PVT = PRESENTATION_FLOOR_PVT;

/** Answering a challenge is one presentation at the floor. */
export const CHALLENGE_ANSWER_FEE_PVT = PRESENTATION_FLOOR_PVT;

/**
 * The challenge stake floor (the `challenge_stake` burn product; the relay schedules it). A string,
 * because `spendBurn` takes the decimal PVT amount it will burn.
 */
export const CHALLENGE_STAKE_PVT = '15';

type Navigator = { navigate: (screen: string, params?: Record<string, unknown>) => void };

/** Send the person to open a talking pass for `audience`. */
export function openTalkingPass(navigation: Navigator, audience: string): void {
    navigation.navigate('HumanPresentment', { audience, selfChallenge: true });
}

/**
 * If `err` is the speech-window refusal, explain it — naming the PVT burn and its amount — and
 * offer to open the window. `beforeNavigate` runs first so a compose sheet (a Modal) is closed
 * and never stays on top of the burn screen. Returns true when the error was handled (the caller
 * should not show a generic alert).
 */
export function offerSpeechWindow(
    err: unknown,
    navigation: Navigator,
    t: TFunction,
    beforeNavigate?: () => void,
): boolean {
    const presentTo = speechWindowRequired(err);
    if (!presentTo) return false;
    // No Modal of the caller's to close → the one talking-pass sheet (when its host is mounted).
    if (!beforeNavigate && presentTalkingPass({ audience: presentTo, onStart: () => openTalkingPass(navigation, presentTo) })) {
        return true;
    }
    const isCommons = presentTo === 'provian:commons';
    const pvt = SPEECH_WINDOW_BURN_PVT;
    Alert.alert(
        t('commons.speechWindowTitle'),
        isCommons ? t('commons.speechWindowBody', { pvt }) : t('commons.speechWindowBodyTo', { who: presentTo, pvt }),
        [
            { text: t('common.cancel'), style: 'cancel' },
            {
                text: t('commons.speechWindowOpen', { pvt }),
                onPress: () => {
                    beforeNavigate?.();
                    openTalkingPass(navigation, presentTo);
                },
            },
        ],
    );
    return true;
}

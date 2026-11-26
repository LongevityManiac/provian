/** The web app's root overlays: the passkey + PIN prompt every seed access goes through, and alerts. */
import React from 'react';
import WebUnlockHost from './web/WebUnlockHost';
import WebAlertHost from './web/WebAlertHost';

export default function WebOverlays(): React.ReactElement {
    return (
        <>
            <WebAlertHost />
            <WebUnlockHost />
        </>
    );
}

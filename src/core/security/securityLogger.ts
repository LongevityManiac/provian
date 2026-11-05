// [Opus-audit M-4] Conditional security logger - no-op in production builds
const securityLog = {
    log: (tag: string, message: string) => {
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
            console.log(`[${tag}] ${message}`);
        }
    },
    warn: (tag: string, message: string) => {
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
            console.warn(`[${tag}] ${message}`);
        }
    },
    error: (tag: string, message: string) => {
        // Errors always log (needed for crash reporting)
        console.error(`[${tag}] ${message}`);
    },
};

export default securityLog;

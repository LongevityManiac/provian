/**
 * The text a dApp reply or a PE record carries for a failure: always English, whatever language
 * the screen shows. Errors with localized on-screen copy keep their English in `englishMessage`.
 */
export function englishErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof Error) {
        const english: unknown = (error as Error & { englishMessage?: unknown }).englishMessage;
        return typeof english === 'string' ? english : error.message;
    }
    return fallback;
}

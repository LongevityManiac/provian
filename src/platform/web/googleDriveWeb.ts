/**
 * Google Drive backup for the web app: the ProvianCloudKeychainSync bridge in a browser.
 *
 * It reads and writes exactly what the Android app does: files named `provian_backup_<key>.enc`
 * (application/octet-stream, the UTF-8 text of the encrypted envelope) in the Drive app data
 * folder of the same Google Cloud project, so a backup made on either restores on the other. The
 * web OAuth client lives in that project; the folder is private to Provian's app and invisible in
 * the Drive UI. Only the `drive.appdata` scope is ever requested.
 *
 * Sign-in uses Google Identity Services' token client in a popup. Browsers allow the popup only
 * from a click, so screens call `signIn()` from the button that starts a backup or a restore; the
 * access token is kept in memory only, for its lifetime (about an hour).
 */
export const GOOGLE_WEB_CLIENT_ID = '813001427078-itqapt208si1d36lonmoi7pr2p4us4ra.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_PREFIX = 'provian_backup_';
const FILE_SUFFIX = '.enc';
const MIME_TYPE = 'application/octet-stream';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

interface TokenResponse { access_token?: string; expires_in?: number; error?: string; error_description?: string }
interface TokenClient { requestAccessToken(overrides?: { prompt?: string }): void }
interface GoogleOAuth2 {
    initTokenClient(config: {
        client_id: string; scope: string; prompt?: string;
        callback: (response: TokenResponse) => void;
        error_callback?: (error: { type?: string; message?: string }) => void;
    }): TokenClient;
    revoke?(token: string, done?: () => void): void;
}
type GoogleGlobal = { accounts?: { oauth2?: GoogleOAuth2 } };

let token: { value: string; expiresAt: number } | null = null;
let scriptPromise: Promise<GoogleOAuth2> | null = null;

export class DriveSignInError extends Error {
    constructor(message: string) { super(message); this.name = 'DriveSignInError'; }
}

function googleOAuth(): GoogleOAuth2 | undefined {
    return (globalThis as unknown as { google?: GoogleGlobal }).google?.accounts?.oauth2;
}

/** Load Google Identity Services once. Called at startup so the click can open the popup at once. */
export function preloadGoogleIdentity(): Promise<GoogleOAuth2> {
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise<GoogleOAuth2>((resolve, reject) => {
        const ready = googleOAuth();
        if (ready) { resolve(ready); return; }
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.onload = () => {
            const loaded = googleOAuth();
            if (loaded) resolve(loaded);
            else reject(new DriveSignInError('google_identity_unavailable'));
        };
        script.onerror = () => { scriptPromise = null; reject(new DriveSignInError('google_identity_unavailable')); };
        document.head.appendChild(script);
    });
    return scriptPromise;
}

function tokenValid(): boolean {
    return !!token && token.expiresAt > Date.now() + 30_000;
}

/** Whether a popup may open now: browsers allow one only right after a click or a key press. */
export function popupAllowedNow(): boolean {
    const activation = (globalThis as unknown as { navigator?: { userActivation?: { isActive?: boolean } } }).navigator?.userActivation;
    return activation?.isActive !== false;
}

/**
 * Ask Google for Drive app-folder access. Call from a click. Resolves true once signed in.
 * Outside a click (a restore that continues on its own, a background check) the browser would block
 * Google's popup and Google never answers, so this resolves false at once instead of waiting forever.
 */
export async function signIn(): Promise<boolean> {
    if (tokenValid()) return true;
    if (!popupAllowedNow()) return false;
    const oauth = googleOAuth() ?? await preloadGoogleIdentity();
    return new Promise<boolean>((resolve, reject) => {
        const client = oauth.initTokenClient({
            client_id: GOOGLE_WEB_CLIENT_ID,
            scope: SCOPE,
            callback: (response) => {
                if (response.access_token) {
                    token = { value: response.access_token, expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000 };
                    resolve(true);
                } else {
                    reject(new DriveSignInError(response.error_description ?? response.error ?? 'google_sign_in_failed'));
                }
            },
            error_callback: (error) => reject(new DriveSignInError(error.type === 'popup_closed' ? 'google_sign_in_cancelled' : (error.message ?? 'google_sign_in_failed'))),
        });
        client.requestAccessToken({ prompt: '' });
    });
}

export function signOut(): void {
    if (token) googleOAuth()?.revoke?.(token.value);
    token = null;
}

async function drive(url: string, init: RequestInit = {}): Promise<Response> {
    if (!tokenValid()) throw new DriveSignInError('Google Drive not signed in');
    const response = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token!.value}` } });
    if (response.status === 401) {
        token = null;
        throw new DriveSignInError('Google Drive not signed in');
    }
    if (!response.ok) throw new Error(`Drive request failed (${response.status})`);
    return response;
}

const fileName = (key: string): string => FILE_PREFIX + key + FILE_SUFFIX;

async function findFileId(name: string): Promise<string | null> {
    const q = `name = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and trashed = false`;
    const params = new URLSearchParams({ spaces: 'appDataFolder', q, fields: 'files(id, name)', pageSize: '10' });
    const body = await (await drive(`${API}?${params}`)).json() as { files?: { id?: string }[] };
    return body.files?.[0]?.id ?? null;
}

export const googleDriveWeb = {
    async store(key: string, value: string): Promise<boolean> {
        const name = fileName(key);
        const existing = await findFileId(name);
        if (existing) {
            await drive(`${UPLOAD}/${encodeURIComponent(existing)}?uploadType=media`, {
                method: 'PATCH', headers: { 'Content-Type': MIME_TYPE }, body: new TextEncoder().encode(value),
            });
        } else {
            const boundary = `provian${crypto.randomUUID().replace(/-/g, '')}`;
            const metadata = JSON.stringify({ name, parents: ['appDataFolder'], mimeType: MIME_TYPE });
            const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`
                + `--${boundary}\r\nContent-Type: ${MIME_TYPE}\r\n\r\n${value}\r\n--${boundary}--`;
            await drive(`${UPLOAD}?uploadType=multipart&fields=id`, {
                method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
            });
        }
        return true;
    },
    async retrieve(key: string): Promise<string | null> {
        if (!tokenValid()) return null;
        const id = await findFileId(fileName(key));
        if (!id) return null;
        const bytes = new Uint8Array(await (await drive(`${API}/${encodeURIComponent(id)}?alt=media`)).arrayBuffer());
        return new TextDecoder().decode(bytes);
    },
    async storeWithSync(key: string, value: string): Promise<boolean> {
        return googleDriveWeb.store(key, value);
    },
    async readSyncedItem(key: string): Promise<string | null> {
        return googleDriveWeb.retrieve(key);
    },
    async deleteSyncedItem(key: string): Promise<boolean> {
        // Never report a deletion that did not happen: without a token nothing can be deleted.
        if (!tokenValid()) throw new DriveSignInError('Google Drive not signed in');
        const id = await findFileId(fileName(key));
        if (id) await drive(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' });
        return true;
    },
    async verifySync(key: string): Promise<boolean> {
        try {
            return tokenValid() && (await findFileId(fileName(key))) !== null;
        } catch {
            return false;
        }
    },
    async listKeys(): Promise<string[]> {
        const keys = new Set<string>();
        let pageToken: string | undefined;
        do {
            const params = new URLSearchParams({ spaces: 'appDataFolder', q: 'trashed = false', fields: 'nextPageToken, files(name)', pageSize: '1000' });
            if (pageToken) params.set('pageToken', pageToken);
            const page = await (await drive(`${API}?${params}`)).json() as { nextPageToken?: string; files?: { name?: string }[] };
            for (const file of page.files ?? []) {
                const name = file.name;
                if (name && name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX)) keys.add(name.slice(FILE_PREFIX.length, -FILE_SUFFIX.length));
            }
            pageToken = page.nextPageToken;
        } while (pageToken);
        return [...keys];
    },
    async isSyncVerified(): Promise<boolean> {
        return tokenValid();
    },
    async signIn(): Promise<boolean> {
        return signIn();
    },
};

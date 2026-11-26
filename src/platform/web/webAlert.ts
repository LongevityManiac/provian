/**
 * Alerts on the web. react-native-web's `Alert.alert` does nothing, so every confirmation, warning
 * and error the app shows with it would silently vanish in a browser. `installWebAlert()` replaces
 * it with a queue that WebAlertHost draws as an in-app dialog, with the same buttons and callbacks.
 */
import { Alert, type AlertButton } from 'react-native';

export interface WebAlert {
    readonly id: number;
    readonly title: string;
    readonly message?: string;
    readonly buttons: AlertButton[];
}

const queue: WebAlert[] = [];
const listeners = new Set<(alert: WebAlert | null) => void>();
let nextId = 1;

function notify(): void {
    for (const listener of listeners) listener(queue[0] ?? null);
}

export function subscribeWebAlerts(listener: (alert: WebAlert | null) => void): () => void {
    listeners.add(listener);
    listener(queue[0] ?? null);
    return () => listeners.delete(listener);
}

export function showWebAlert(title: string, message?: string, buttons?: AlertButton[]): void {
    queue.push({ id: nextId++, title: title ?? '', message, buttons: buttons && buttons.length ? buttons : [{ text: 'OK' }] });
    notify();
}

export function pressWebAlert(id: number, index: number): void {
    const position = queue.findIndex(alert => alert.id === id);
    if (position < 0) return;
    const [alert] = queue.splice(position, 1);
    notify();
    alert.buttons[index]?.onPress?.();
}

/** Dismissing with no button pressed runs the cancel button, as the phone's back gesture does. */
export function dismissWebAlert(id: number): void {
    const alert = queue.find(item => item.id === id);
    if (!alert) return;
    const cancel = alert.buttons.findIndex(button => button.style === 'cancel');
    pressWebAlert(id, cancel);
}

export function installWebAlert(): void {
    (Alert as unknown as { alert: typeof showWebAlert }).alert = showWebAlert;
}

/** A two-button question, resolved with which one was pressed. */
export function webConfirm(options: { title: string; message?: string; confirm: string; cancel: string }): Promise<boolean> {
    return new Promise(resolve => {
        showWebAlert(options.title, options.message, [
            { text: options.cancel, style: 'cancel', onPress: () => resolve(false) },
            { text: options.confirm, onPress: () => resolve(true) },
        ]);
    });
}

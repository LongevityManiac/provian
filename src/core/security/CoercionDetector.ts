import { Accelerometer } from 'expo-sensors';
import { translate } from '../../i18n/translate';

export interface CoercionStatus {
    isCoerced: boolean;
    riskLevel: 'critical' | 'high' | 'medium' | 'low';
    triggers: string[];
}

class CoercionDetector {
    private static instance: CoercionDetector;
    private tapHistory: number[] = [];
    private shakeCount: number = 0;
    private lastShake: number = 0;
    private subscription: any = null;

    private constructor() { }

    static getInstance(): CoercionDetector {
        if (!CoercionDetector.instance) {
            CoercionDetector.instance = new CoercionDetector();
        }
        return CoercionDetector.instance;
    }

    /**
     * Start monitoring for coercion signals
     */
    startMonitoring() {
        this.tapHistory = [];
        this.shakeCount = 0;

        // Monitor device shaking (sign of struggle or nervousness)
        this.subscription = Accelerometer.addListener(data => {
            const totalForce = Math.abs(data.x) + Math.abs(data.y) + Math.abs(data.z);
            if (totalForce > 2.5) { // Threshold for shake
                const now = Date.now();
                if (now - this.lastShake > 500) {
                    this.shakeCount++;
                    this.lastShake = now;
                }
            }
        });
        Accelerometer.setUpdateInterval(100);
    }

    /**
     * Stop monitoring
     */
    stopMonitoring() {
        if (this.subscription) {
            this.subscription.remove();
            this.subscription = null;
        }
    }

    /**
     * Record a user interaction (tap)
     */
    recordInteraction() {
        this.tapHistory.push(Date.now());
        // Keep only last 10 taps
        if (this.tapHistory.length > 10) {
            this.tapHistory.shift();
        }
    }

    /**
     * Analyze current state for coercion
     */
    analyze(): CoercionStatus {
        const triggers: string[] = [];
        let riskScore = 0;

        // 1. Check for rapid tapping (Panic tapping)
        if (this.tapHistory.length >= 5) {
            const duration = this.tapHistory[this.tapHistory.length - 1] - this.tapHistory[0];
            const avgTimeBetweenTaps = duration / (this.tapHistory.length - 1);

            if (avgTimeBetweenTaps < 200) { // Tapping faster than 5 times per second
                triggers.push(translate('coercion.rapidInteraction', 'Extremely rapid interaction detected'));
                riskScore += 0.6;
            }
        }

        // 2. Check for shaking
        if (this.shakeCount > 3) {
            triggers.push(translate('coercion.deviceShaking', 'Device shaking detected'));
            riskScore += 0.4;
        }

        // Determine risk level
        let riskLevel: 'critical' | 'high' | 'medium' | 'low' = 'low';
        if (riskScore >= 0.8) riskLevel = 'critical';
        else if (riskScore >= 0.5) riskLevel = 'high';
        else if (riskScore >= 0.3) riskLevel = 'medium';

        return {
            isCoerced: riskScore >= 0.5,
            riskLevel,
            triggers
        };
    }
}

export default CoercionDetector.getInstance();

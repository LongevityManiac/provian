import AsyncStorage from '@react-native-async-storage/async-storage';
import { translate } from '../../i18n/translate';

const STORAGE_KEY = 'provian_sent_addresses';
const CONTACTS_KEY = 'provian_contacts';
const SEND_HISTORY_KEY = 'provian_send_history';

export type ChainType = 'evm';

export interface SentAddressRecord {
    address: string;
    lastSentAt: number;
    sendCount: number;
    totalAmountUsd: number;
    chain?: ChainType;
}

export interface SendHistoryItem {
    id: string;
    address: string;
    amount: number;
    amountUsd: number;
    asset: string;
    chain: ChainType;
    timestamp: number;
    txHash?: string;
}

export interface Contact {
    id: string;
    address: string;
    name: string;
    addedAt: number;
    chain?: ChainType;
    isFavorite?: boolean;
    // Merged from send history (computed)
    lastSentAt?: number;
    sendCount?: number;
    totalSentUsd?: number;
    // Support multiple addresses per contact
    additionalAddresses?: { address: string; chain: ChainType }[];
}

export interface LookalikeMatch {
    /** The known (contact or previously-sent-to) address the candidate resembles. */
    address: string;
    /** Contact name, if the known address is saved. */
    name?: string;
}

class AddressHistoryService {
    private static instance: AddressHistoryService;
    private addressHistory: Map<string, SentAddressRecord> = new Map();
    private contacts: Map<string, Contact> = new Map();
    private sendHistory: SendHistoryItem[] = [];
    private loaded = false;

    private constructor() {}

    static getInstance(): AddressHistoryService {
        if (!AddressHistoryService.instance) {
            AddressHistoryService.instance = new AddressHistoryService();
        }
        return AddressHistoryService.instance;
    }

    private async ensureLoaded(): Promise<void> {
        if (this.loaded) return;

        try {
            const [historyData, contactsData, sendHistoryData] = await Promise.all([
                AsyncStorage.getItem(STORAGE_KEY),
                AsyncStorage.getItem(CONTACTS_KEY),
                AsyncStorage.getItem(SEND_HISTORY_KEY),
            ]);

            if (historyData) {
                const records: SentAddressRecord[] = JSON.parse(historyData);
                records.forEach(r => this.addressHistory.set(r.address.toLowerCase(), r));
            }

            if (contactsData) {
                const contacts: Contact[] = JSON.parse(contactsData);
                contacts.forEach(c => this.contacts.set(c.address.toLowerCase(), c));
            }

            if (sendHistoryData) {
                this.sendHistory = JSON.parse(sendHistoryData);
            }
        } catch (error) {
            console.error('[AddressHistoryService] Failed to load:', error);
        }

        this.loaded = true;
    }

    private async save(): Promise<void> {
        try {
            await Promise.all([
                AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(this.addressHistory.values()))),
                AsyncStorage.setItem(CONTACTS_KEY, JSON.stringify(Array.from(this.contacts.values()))),
                AsyncStorage.setItem(SEND_HISTORY_KEY, JSON.stringify(this.sendHistory)),
            ]);
        } catch (error) {
            console.error('[AddressHistoryService] Failed to save:', error);
        }
    }

    /**
     * Generate unique ID
     * SECURITY: Uses crypto.randomUUID() for better uniqueness
     */
    private generateId(): string {
        return crypto.randomUUID();
    }

    /**
     * Detect chain type from address format
     */
    detectChainFromAddress(_address: string): ChainType {
        return 'evm';
    }

    // ==================== ADDRESS HISTORY ====================

    /**
     * Check if this is the first time sending to an address
     */
    async isFirstTimeSend(address: string): Promise<boolean> {
        await this.ensureLoaded();
        return !this.addressHistory.has(address.toLowerCase());
    }

    /**
     * Get send history for an address
     */
    async getAddressHistory(address: string): Promise<SentAddressRecord | null> {
        await this.ensureLoaded();
        return this.addressHistory.get(address.toLowerCase()) || null;
    }

    /**
     * Record a successful send to an address
     */
    async recordSend(
        address: string,
        amountUsd: number,
        details?: { amount: number; asset: string; chain: ChainType; txHash?: string }
    ): Promise<void> {
        await this.ensureLoaded();

        const normalizedAddress = address.toLowerCase();
        const chain = details?.chain || this.detectChainFromAddress(address);
        const existing = this.addressHistory.get(normalizedAddress);

        if (existing) {
            existing.lastSentAt = Date.now();
            existing.sendCount += 1;
            existing.totalAmountUsd += amountUsd;
            existing.chain = chain;
        } else {
            this.addressHistory.set(normalizedAddress, {
                address: normalizedAddress,
                lastSentAt: Date.now(),
                sendCount: 1,
                totalAmountUsd: amountUsd,
                chain,
            });
        }

        // Also record in detailed send history
        if (details) {
            this.sendHistory.unshift({
                id: this.generateId(),
                address: normalizedAddress,
                amount: details.amount,
                amountUsd,
                asset: details.asset,
                chain,
                timestamp: Date.now(),
                txHash: details.txHash,
            });

            // Keep last 100 transactions
            if (this.sendHistory.length > 100) {
                this.sendHistory = this.sendHistory.slice(0, 100);
            }
        }

        await this.save();
    }

    /**
     * Get recent addresses sorted by lastSentAt (most recent first)
     */
    async getRecentAddresses(limit: number = 10): Promise<Contact[]> {
        await this.ensureLoaded();

        const records = Array.from(this.addressHistory.values())
            .sort((a, b) => b.lastSentAt - a.lastSentAt)
            .slice(0, limit);

        // Merge with contact info if available
        return records.map(record => {
            const contact = this.contacts.get(record.address.toLowerCase());
            return {
                id: contact?.id || record.address,
                address: record.address,
                name: contact?.name || '',
                addedAt: contact?.addedAt || record.lastSentAt,
                chain: record.chain || contact?.chain,
                isFavorite: contact?.isFavorite || false,
                lastSentAt: record.lastSentAt,
                sendCount: record.sendCount,
                totalSentUsd: record.totalAmountUsd,
            };
        });
    }

    /**
     * Get send history for a specific address
     */
    async getSendHistoryForAddress(address: string): Promise<SendHistoryItem[]> {
        await this.ensureLoaded();
        const normalizedAddress = address.toLowerCase();
        return this.sendHistory.filter(item => item.address === normalizedAddress);
    }

    /**
     * Detect a classic address-poisoning lookalike: a candidate address that
     * shares the same visible prefix + suffix (the exact substring this
     * app's own truncated "0x1234...5678" display shows) with an address
     * already known to this wallet - a saved contact or a prior send - but
     * is not actually that address. Attackers dust-transfer from vanity
     * addresses crafted to pass this "looks the same" visual check, so this
     * comparison is done against the FULL stored address, independent of
     * any truncated display string.
     *
     * Returns null when the candidate exactly matches a known address (not
     * a lookalike - it IS the known address) or when nothing resembles it.
     */
    async findLookalikeMatch(candidate: string): Promise<LookalikeMatch | null> {
        await this.ensureLoaded();

        const normalizedCandidate = candidate.toLowerCase();
        if (normalizedCandidate.length < 10) return null;

        const prefix = normalizedCandidate.slice(0, 6);
        const suffix = normalizedCandidate.slice(-4);

        const knownAddresses = new Set<string>([
            ...this.addressHistory.keys(),
            ...this.contacts.keys(),
        ]);

        for (const known of knownAddresses) {
            if (known === normalizedCandidate) continue;
            if (known.length < 10) continue;
            if (known.slice(0, 6) === prefix && known.slice(-4) === suffix) {
                const contact = this.contacts.get(known);
                return { address: known, name: contact?.name };
            }
        }

        return null;
    }

    // ==================== CONTACTS ====================

    /**
     * Get contact by address
     */
    async getContact(address: string): Promise<Contact | null> {
        await this.ensureLoaded();
        return this.contacts.get(address.toLowerCase()) || null;
    }

    /**
     * Get contact name for an address, if saved
     */
    async getContactName(address: string): Promise<string | null> {
        await this.ensureLoaded();
        const contact = this.contacts.get(address.toLowerCase());
        return contact?.name || null;
    }

    /**
     * Save a new contact
     */
    async saveContact(address: string, name: string, chain?: ChainType): Promise<Contact> {
        await this.ensureLoaded();

        const normalizedAddress = address.toLowerCase();
        const detectedChain = chain || this.detectChainFromAddress(address);
        const existing = this.contacts.get(normalizedAddress);

        const contact: Contact = {
            id: existing?.id || this.generateId(),
            address: normalizedAddress,
            name,
            addedAt: existing?.addedAt || Date.now(),
            chain: detectedChain,
            isFavorite: existing?.isFavorite || false,
            additionalAddresses: existing?.additionalAddresses,
        };

        this.contacts.set(normalizedAddress, contact);
        await this.save();

        return contact;
    }

    /**
     * Update an existing contact
     */
    async updateContact(address: string, updates: Partial<Pick<Contact, 'name' | 'isFavorite' | 'chain'>>): Promise<Contact | null> {
        await this.ensureLoaded();

        const normalizedAddress = address.toLowerCase();
        const contact = this.contacts.get(normalizedAddress);

        if (!contact) return null;

        if (updates.name !== undefined) contact.name = updates.name;
        if (updates.isFavorite !== undefined) contact.isFavorite = updates.isFavorite;
        if (updates.chain !== undefined) contact.chain = updates.chain;

        this.contacts.set(normalizedAddress, contact);
        await this.save();

        return contact;
    }

    /**
     * Delete a contact
     */
    async deleteContact(address: string): Promise<boolean> {
        await this.ensureLoaded();

        const normalizedAddress = address.toLowerCase();
        const existed = this.contacts.has(normalizedAddress);

        if (existed) {
            this.contacts.delete(normalizedAddress);
            await this.save();
        }

        return existed;
    }

    /**
     * Add additional address to an existing contact
     */
    async addAddressToContact(contactAddress: string, newAddress: string, chain: ChainType): Promise<Contact | null> {
        await this.ensureLoaded();

        const normalizedAddress = contactAddress.toLowerCase();
        const contact = this.contacts.get(normalizedAddress);

        if (!contact) return null;

        if (!contact.additionalAddresses) {
            contact.additionalAddresses = [];
        }

        // Check if address already exists
        const exists = contact.additionalAddresses.some(
            a => a.address.toLowerCase() === newAddress.toLowerCase()
        );

        if (!exists) {
            contact.additionalAddresses.push({
                address: newAddress.toLowerCase(),
                chain,
            });
            await this.save();
        }

        return contact;
    }

    /**
     * Get all contacts
     */
    async getAllContacts(): Promise<Contact[]> {
        await this.ensureLoaded();
        return Array.from(this.contacts.values()).sort((a, b) =>
            a.name.toLowerCase().localeCompare(b.name.toLowerCase())
        );
    }

    /**
     * Get all contacts merged with their send history
     */
    async getContactsWithHistory(): Promise<Contact[]> {
        await this.ensureLoaded();

        return Array.from(this.contacts.values()).map(contact => {
            const history = this.addressHistory.get(contact.address.toLowerCase());
            return {
                ...contact,
                lastSentAt: history?.lastSentAt,
                sendCount: history?.sendCount || 0,
                totalSentUsd: history?.totalAmountUsd || 0,
            };
        }).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    }

    /**
     * Get favorite contacts
     */
    async getFavorites(): Promise<Contact[]> {
        await this.ensureLoaded();

        return Array.from(this.contacts.values())
            .filter(c => c.isFavorite)
            .map(contact => {
                const history = this.addressHistory.get(contact.address.toLowerCase());
                return {
                    ...contact,
                    lastSentAt: history?.lastSentAt,
                    sendCount: history?.sendCount || 0,
                    totalSentUsd: history?.totalAmountUsd || 0,
                };
            })
            .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    }

    /**
     * Toggle favorite status for a contact
     */
    async toggleFavorite(address: string): Promise<boolean> {
        await this.ensureLoaded();

        const normalizedAddress = address.toLowerCase();
        const contact = this.contacts.get(normalizedAddress);

        if (!contact) return false;

        contact.isFavorite = !contact.isFavorite;
        this.contacts.set(normalizedAddress, contact);
        await this.save();

        return contact.isFavorite;
    }

    /**
     * Search contacts by name or address
     */
    async searchContacts(query: string): Promise<Contact[]> {
        await this.ensureLoaded();

        if (!query || query.length < 2) return [];

        const lowerQuery = query.toLowerCase();

        return Array.from(this.contacts.values())
            .filter(contact =>
                contact.name.toLowerCase().includes(lowerQuery) ||
                contact.address.toLowerCase().includes(lowerQuery)
            )
            .map(contact => {
                const history = this.addressHistory.get(contact.address.toLowerCase());
                return {
                    ...contact,
                    lastSentAt: history?.lastSentAt,
                    sendCount: history?.sendCount || 0,
                    totalSentUsd: history?.totalAmountUsd || 0,
                };
            });
    }

    /**
     * Check if an address is a saved contact
     */
    async isContact(address: string): Promise<boolean> {
        await this.ensureLoaded();
        return this.contacts.has(address.toLowerCase());
    }

    // ==================== DISPLAY HELPERS ====================

    /**
     * Format address for display - show contact name or truncated address
     */
    async formatAddressForDisplay(address: string): Promise<{ display: string; isContact: boolean; isNew: boolean }> {
        await this.ensureLoaded();

        const contactName = await this.getContactName(address);
        const isFirstTime = await this.isFirstTimeSend(address);

        if (contactName) {
            return {
                display: contactName,
                isContact: true,
                isNew: false,
            };
        }

        // Truncate address: 0x742d...fE21
        const truncated = `${address.slice(0, 6)}...${address.slice(-4)}`;

        return {
            display: isFirstTime ? `${truncated} (New)` : truncated,
            isContact: false,
            isNew: isFirstTime,
        };
    }

    /**
     * Get chain display name
     */
    getChainDisplayName(chain: ChainType | undefined): string {
        switch (chain) {
            case 'evm': return 'Ethereum/EVM';
            default: return 'Unknown';
        }
    }

    /**
     * Get short chain name
     */
    getChainShortName(chain: ChainType | undefined): string {
        switch (chain) {
            case 'evm': return 'EVM';
            default: return '';
        }
    }

    /**
     * Format relative time
     */
    formatRelativeTime(timestamp: number | undefined): string {
        if (!timestamp) return '';

        const now = Date.now();
        const diff = now - timestamp;

        const minutes = Math.floor(diff / (1000 * 60));
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const weeks = Math.floor(days / 7);
        const months = Math.floor(days / 30);

        if (minutes < 1) return translate('relativeTime.justNow', 'Just now');
        if (minutes < 60) return translate('relativeTime.minutesAgo', `${minutes}m ago`, { count: minutes });
        if (hours < 24) return translate('relativeTime.hoursAgo', `${hours}h ago`, { count: hours });
        if (days < 7) return translate('relativeTime.daysAgo', `${days}d ago`, { count: days });
        if (weeks < 4) return translate('relativeTime.weeksAgo', `${weeks}w ago`, { count: weeks });
        return translate('relativeTime.monthsAgo', `${months}mo ago`, { count: months });
    }
}

export default AddressHistoryService.getInstance();

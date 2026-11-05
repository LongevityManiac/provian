/**
 * CategoryMatcher - Merchant Category Classification
 *
 * Classifies merchants into categories for policy enforcement.
 * Uses keyword matching for basic classification.
 *
 * In production, this could be enhanced with:
 * - MCC (Merchant Category Code) lookup
 * - ML-based classification
 * - External API integration
 */

import { MerchantCategory } from './types';

/**
 * Keyword patterns for each category.
 * Order matters - first match wins.
 */
const CATEGORY_PATTERNS: Array<{ category: MerchantCategory; patterns: RegExp[] }> = [
    // High-risk categories first
    {
        category: 'gambling',
        patterns: [
            /casino/i,
            /betting/i,
            /poker/i,
            /lottery/i,
            /gambling/i,
            /sportsbook/i,
            /fanduel/i,
            /draftkings/i,
        ],
    },
    {
        category: 'adult',
        patterns: [
            /adult/i,
            /xxx/i,
            /onlyfans/i,
        ],
    },

    // Food & Dining
    {
        category: 'food_dining',
        patterns: [
            /restaurant/i,
            /cafe/i,
            /coffee/i,
            /starbucks/i,
            /mcdonald/i,
            /burger/i,
            /pizza/i,
            /sushi/i,
            /doordash/i,
            /ubereats/i,
            /grubhub/i,
            /postmates/i,
            /chipotle/i,
            /taco/i,
            /wendys/i,
            /subway/i,
            /panera/i,
            /diner/i,
            /bistro/i,
            /bar\b/i,
            /pub\b/i,
            /grill/i,
            /kitchen/i,
            /eatery/i,
        ],
    },

    // Groceries
    {
        category: 'groceries',
        patterns: [
            /grocery/i,
            /supermarket/i,
            /whole\s*foods/i,
            /trader\s*joe/i,
            /safeway/i,
            /kroger/i,
            /albertsons/i,
            /costco/i,
            /walmart.*grocery/i,
            /target.*grocery/i,
            /aldi/i,
            /publix/i,
            /wegmans/i,
            /h-?e-?b\b/i,
            /instacart/i,
            /fresh\s*direct/i,
        ],
    },

    // Transportation
    {
        category: 'transportation',
        patterns: [
            /uber(?!eats)/i,
            /lyft/i,
            /taxi/i,
            /cab\b/i,
            /parking/i,
            /gas\s*station/i,
            /shell/i,
            /chevron/i,
            /exxon/i,
            /mobil/i,
            /bp\b/i,
            /arco/i,
            /valero/i,
            /ev\s*charging/i,
            /chargepoint/i,
            /electrify/i,
            /transit/i,
            /metro/i,
            /bart/i,
            /mta/i,
            /caltrain/i,
            /amtrak/i,
            /toll/i,
        ],
    },

    // Travel
    {
        category: 'travel',
        patterns: [
            /airline/i,
            /hotel/i,
            /airbnb/i,
            /booking\.com/i,
            /expedia/i,
            /marriott/i,
            /hilton/i,
            /hyatt/i,
            /delta/i,
            /united/i,
            /american\s*airlines/i,
            /southwest/i,
            /jetblue/i,
            /frontier/i,
            /spirit\s*airlines/i,
            /kayak/i,
            /hotwire/i,
            /priceline/i,
            /vrbo/i,
            /rental\s*car/i,
            /hertz/i,
            /enterprise/i,
            /avis/i,
        ],
    },

    // Entertainment
    {
        category: 'entertainment',
        patterns: [
            /netflix/i,
            /spotify/i,
            /hulu/i,
            /disney\+/i,
            /hbo/i,
            /prime\s*video/i,
            /youtube/i,
            /twitch/i,
            /steam/i,
            /playstation/i,
            /xbox/i,
            /nintendo/i,
            /movie/i,
            /cinema/i,
            /theater/i,
            /concert/i,
            /ticketmaster/i,
            /stubhub/i,
            /eventbrite/i,
            /museum/i,
            /zoo/i,
            /theme\s*park/i,
            /disneyland/i,
            /universal\s*studios/i,
            /spotify/i,
            /apple\s*music/i,
            /pandora/i,
        ],
    },

    // Shopping
    {
        category: 'shopping',
        patterns: [
            /amazon(?!.*web\s*services)/i,
            /ebay/i,
            /walmart(?!.*grocery)/i,
            /target(?!.*grocery)/i,
            /best\s*buy/i,
            /apple\s*store/i,
            /nike/i,
            /adidas/i,
            /zara/i,
            /h&m/i,
            /nordstrom/i,
            /macy/i,
            /kohls/i,
            /jcpenney/i,
            /ikea/i,
            /home\s*depot/i,
            /lowes/i,
            /wayfair/i,
            /etsy/i,
            /shopify/i,
            /alibaba/i,
            /wish\.com/i,
            /shein/i,
            /fashion/i,
            /clothing/i,
            /apparel/i,
            /shoes/i,
            /jewelry/i,
        ],
    },

    // Subscriptions
    {
        category: 'subscriptions',
        patterns: [
            /subscription/i,
            /recurring/i,
            /monthly\s*plan/i,
            /annual\s*plan/i,
            /membership/i,
            /patreon/i,
            /substack/i,
            /medium/i,
            /notion/i,
            /slack/i,
            /zoom/i,
            /dropbox/i,
            /icloud/i,
            /google\s*one/i,
            /adobe/i,
            /microsoft\s*365/i,
            /office\s*365/i,
            /canva/i,
            /figma/i,
            /github/i,
            /vercel/i,
            /heroku/i,
            /aws/i,
            /azure/i,
            /google\s*cloud/i,
        ],
    },

    // Utilities
    {
        category: 'utilities',
        patterns: [
            /electric/i,
            /water\s*bill/i,
            /gas\s*bill/i,
            /internet/i,
            /comcast/i,
            /xfinity/i,
            /at&t/i,
            /verizon/i,
            /t-?mobile/i,
            /sprint/i,
            /pge/i,
            /pg&e/i,
            /edison/i,
            /utility/i,
            /phone\s*bill/i,
            /cell\s*phone/i,
            /mobile\s*phone/i,
        ],
    },

    // Healthcare
    {
        category: 'healthcare',
        patterns: [
            /pharmacy/i,
            /cvs/i,
            /walgreens/i,
            /rite\s*aid/i,
            /hospital/i,
            /clinic/i,
            /doctor/i,
            /dentist/i,
            /medical/i,
            /health/i,
            /insurance/i,
            /kaiser/i,
            /blue\s*cross/i,
            /aetna/i,
            /united\s*health/i,
            /cigna/i,
            /optum/i,
            /teladoc/i,
            /one\s*medical/i,
        ],
    },

    // Education
    {
        category: 'education',
        patterns: [
            /university/i,
            /college/i,
            /school/i,
            /tuition/i,
            /coursera/i,
            /udemy/i,
            /skillshare/i,
            /masterclass/i,
            /linkedin\s*learning/i,
            /duolingo/i,
            /khan\s*academy/i,
            /education/i,
            /learning/i,
            /textbook/i,
            /chegg/i,
        ],
    },

    // Financial Services
    {
        category: 'financial_services',
        patterns: [
            /bank/i,
            /chase/i,
            /wells\s*fargo/i,
            /bank\s*of\s*america/i,
            /citi/i,
            /capital\s*one/i,
            /paypal/i,
            /venmo/i,
            /cash\s*app/i,
            /zelle/i,
            /stripe/i,
            /square/i,
            /wise/i,
            /transferwise/i,
            /remittance/i,
            /loan/i,
            /mortgage/i,
            /investment/i,
            /brokerage/i,
            /robinhood/i,
            /fidelity/i,
            /schwab/i,
            /vanguard/i,
        ],
    },

    // Crypto
    {
        category: 'crypto',
        patterns: [
            /coinbase/i,
            /binance/i,
            /kraken/i,
            /gemini/i,
            /crypto/i,
            /bitcoin/i,
            /ethereum/i,
            /blockchain/i,
            /defi/i,
            /nft/i,
            /opensea/i,
            /uniswap/i,
            /metamask/i,
        ],
    },
];

/**
 * Classify a merchant name into a category.
 */
export function classifyMerchant(merchantName: string): MerchantCategory {
    const normalized = merchantName.trim();

    for (const { category, patterns } of CATEGORY_PATTERNS) {
        for (const pattern of patterns) {
            if (pattern.test(normalized)) {
                return category;
            }
        }
    }

    return 'other';
}

/**
 * Get all categories that a merchant might belong to (for UI display).
 */
export function getSuggestedCategories(merchantName: string): MerchantCategory[] {
    const normalized = merchantName.trim();
    const matches: MerchantCategory[] = [];

    for (const { category, patterns } of CATEGORY_PATTERNS) {
        for (const pattern of patterns) {
            if (pattern.test(normalized)) {
                matches.push(category);
                break;
            }
        }
    }

    if (matches.length === 0) {
        matches.push('other');
    }

    return matches;
}

/**
 * Check if a merchant is in a specific category.
 */
export function isMerchantInCategory(merchantName: string, category: MerchantCategory): boolean {
    return classifyMerchant(merchantName) === category;
}

/**
 * Get human-readable category label.
 */
export function getCategoryLabel(category: MerchantCategory): string {
    const labels: Record<MerchantCategory, string> = {
        food_dining: 'Food & Dining',
        groceries: 'Groceries',
        transportation: 'Transportation',
        entertainment: 'Entertainment',
        shopping: 'Shopping',
        travel: 'Travel',
        utilities: 'Utilities',
        subscriptions: 'Subscriptions',
        healthcare: 'Healthcare',
        education: 'Education',
        financial_services: 'Financial Services',
        gambling: 'Gambling',
        adult: 'Adult Content',
        crypto: 'Cryptocurrency',
        other: 'Other',
    };

    return labels[category] || category;
}

/**
 * Get all available categories.
 */
export function getAllCategories(): MerchantCategory[] {
    return [
        'food_dining',
        'groceries',
        'transportation',
        'entertainment',
        'shopping',
        'travel',
        'utilities',
        'subscriptions',
        'healthcare',
        'education',
        'financial_services',
        'crypto',
        'gambling',
        'adult',
        'other',
    ];
}

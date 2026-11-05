import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        void: '#06080f',
        surface: {
          DEFAULT: '#0c1020',
          raised: '#121830',
          highlight: '#1a2245',
        },
        provian: {
          blue: '#4a9eff',
          'blue-bright': '#6bb3ff',
          'blue-dim': '#2a6cc7',
          gold: '#e8a634',
          'gold-bright': '#f0bd5c',
          'gold-dim': '#b87e1a',
          amber: '#d4913a',
        },
        // The PVT coin (the app's COLORS.platinum scale).
        platinum: {
          DEFAULT: '#F5F7FB',
          deep: '#C2C9D5',
          edge: '#8A93A3',
          check: '#152233',
          seal: '#1B2637',
        },
        text: {
          primary: '#e8ecf4',
          secondary: '#949eb4',
          // Muted text still carries labels and captions, so it has to read:
          // 5.4:1 on void, 4.8:1 on surface-raised (was #5a6478, about 3.3:1).
          muted: '#7c869c',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        body: ['var(--font-body)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      backgroundImage: {
        // The "ascent" gradient: blue rim at top falling to amber glow at the
        // base, echoing the shield's rising light beam. The brand's signature.
        ascent: 'linear-gradient(180deg, #6bb3ff 0%, #4a9eff 28%, #2a6cc7 48%, #b87e1a 74%, #f0bd5c 100%)',
        'ascent-h': 'linear-gradient(90deg, #4a9eff 0%, #6bb3ff 45%, #e8a634 100%)',
        'edge-top': 'linear-gradient(180deg, rgba(107,179,255,0.55) 0%, rgba(107,179,255,0) 100%)',
        'glow-amber-radial': 'radial-gradient(60% 80% at 50% 100%, rgba(232,166,52,0.22) 0%, rgba(232,166,52,0) 70%)',
        'glow-blue-radial': 'radial-gradient(50% 60% at 50% 0%, rgba(74,158,255,0.20) 0%, rgba(74,158,255,0) 70%)',
      },
      boxShadow: {
        'glow-blue': '0 0 40px -8px rgba(74,158,255,0.45)',
        'glow-amber': '0 0 48px -6px rgba(232,166,52,0.40)',
        'glow-soft': '0 0 90px -24px rgba(74,158,255,0.40)',
      },
      animation: {
        'fade-in': 'fadeIn 2s ease-out forwards',
        'fade-in-delay': 'fadeIn 1.5s ease-out 1.8s forwards',
        'fade-in-delay-2': 'fadeIn 1.5s ease-out 2.8s forwards',
        'fade-in-delay-3': 'fadeIn 1s ease-out 3.6s forwards',
        'glow-pulse': 'glowPulse 4s ease-in-out infinite',
        'scroll-hint': 'scrollHint 2s ease-in-out infinite',
        'slide-up': 'slideUp 0.8s ease-out forwards',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        glowPulse: {
          '0%, 100%': { filter: 'drop-shadow(0 0 20px rgba(74, 158, 255, 0.3)) drop-shadow(0 0 40px rgba(232, 166, 52, 0.15))' },
          '50%': { filter: 'drop-shadow(0 0 30px rgba(74, 158, 255, 0.5)) drop-shadow(0 0 60px rgba(232, 166, 52, 0.25))' },
        },
        scrollHint: {
          '0%, 100%': { transform: 'translateY(0)', opacity: '0.4' },
          '50%': { transform: 'translateY(8px)', opacity: '0.8' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(40px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      typography: {
        provian: {
          css: {
            '--tw-prose-body': '#949eb4',
            '--tw-prose-headings': '#e8ecf4',
            '--tw-prose-links': '#4a9eff',
            '--tw-prose-bold': '#e8ecf4',
            '--tw-prose-code': '#6bb3ff',
            '--tw-prose-quotes': '#949eb4',
            '--tw-prose-quote-borders': '#2a6cc7',
          },
        },
      },
    },
  },
  plugins: [],
}

export default config

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        // Green-tinted near-blacks: 500 is the app background, 400 panels,
        // 300 raised cards, 200 hover/borders.
        surface: {
          50:  '#f3f6f4',
          100: '#e3e9e5',
          200: '#25302b',
          300: '#18211d',
          400: '#111815',
          500: '#0a0f0d',
        },
        accent: {
          DEFAULT: '#16a34a',
          light:   '#4ade80',
          dark:    '#15803d',
        }
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(74, 222, 128, 0.18), 0 10px 30px -12px rgba(34, 197, 94, 0.45)',
        card: '0 1px 0 rgba(255, 255, 255, 0.03) inset, 0 12px 32px -18px rgba(0, 0, 0, 0.8)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      keyframes: {
        slide: {
          '0%':   { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(400%)' },
        },
        'page-in': {
          '0%':   { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pop: {
          '0%':   { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'rise-in': {
          '0%':   { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        slide: 'slide 1.5s ease-in-out infinite',
        'page-in': 'page-in 260ms cubic-bezier(0.22, 1, 0.36, 1) both',
        pop: 'pop 180ms cubic-bezier(0.22, 1, 0.36, 1) both',
        'rise-in': 'rise-in 320ms cubic-bezier(0.22, 1, 0.36, 1) both',
        shimmer: 'shimmer 2.2s linear infinite',
      },
    }
  },
  plugins: []
}

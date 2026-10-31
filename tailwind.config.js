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
      },
      animation: {
        slide: 'slide 1.5s ease-in-out infinite',
      },
    }
  },
  plugins: []
}

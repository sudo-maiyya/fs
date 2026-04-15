/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class', // Enables toggleable Dark/Light mode
  theme: {
    extend: {
      fontFamily: {
        mono: ['"JetBrains Mono"', 'monospace'],
        sans: ['Anybody', 'sans-serif'],
      },
      colors: {
        trade: {
          bg: '#04070d',
          surf: '#0b101a',
          border: '#1e2533',
          bull: '#00e5a0',
          bear: '#ff4d6d',
          warn: '#f59e0b',
          gold: '#ffd166',
          blue: '#60a5fa',
          purple: '#a78bfa',
        }
      }
    },
  },
  plugins: [],
}
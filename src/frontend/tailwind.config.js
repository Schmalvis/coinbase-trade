export default {
  content: ['./src/**/*.{svelte,ts,html}', './index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: { primary: 'var(--bg-primary)', card: 'var(--bg-card)', hover: 'var(--bg-card-hover)' },
        accent: { green: '#4ade80', red: '#f87171', blue: '#60a5fa', yellow: '#fbbf24' },
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
    },
  },
  plugins: [],
};

export default {
  content: ['./src/**/*.{svelte,ts,html}', './index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          primary: 'var(--bg-primary)',
          card: 'var(--bg-card)',
          hover: 'var(--bg-card-hover)',
          inset: 'var(--bg-inset)',
        },
        clay: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          soft: 'var(--accent-soft)',
        },
        gain: { DEFAULT: 'var(--gain)', soft: 'var(--gain-soft)' },
        loss: { DEFAULT: 'var(--loss)', soft: 'var(--loss-soft)' },
        warn: { DEFAULT: 'var(--warn)', soft: 'var(--warn-soft)' },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        display: ['ui-serif', 'Georgia', '"Iowan Old Style"', '"Palatino Linotype"', 'serif'],
        mono: ['ui-monospace', '"SF Mono"', '"Cascadia Mono"', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--bg-canvas)',
        band: 'var(--bg-band)',
        surface: 'var(--bg-surface)',
        elevated: 'var(--bg-elevated)',
        hairline: 'var(--border-hairline)',
        hairlineStrong: 'var(--border-strong)',
        ink: 'var(--ink-primary)',
        muted: 'var(--ink-secondary)',
        subtle: 'var(--ink-tertiary)',
        brand: 'var(--accent-teal)',
        brandStrong: 'var(--accent-teal-strong)',
        brandSoft: 'var(--accent-teal-soft)',
        flame: 'var(--accent-flame)',
        flameSoft: 'var(--accent-flame-soft)',
        cyanTool: 'var(--tool-antigravity)',
        claudeTool: 'var(--tool-claude)',
        codexTool: 'var(--tool-codex)',
      },
      fontFamily: {
        display: ['"Schibsted Grotesk"', 'system-ui', '-apple-system', 'sans-serif'],
        sans: ['"Schibsted Grotesk"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};

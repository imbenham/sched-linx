// PostCSS pipeline for Next.js. Tailwind v4 ships its compiler as a
// PostCSS plugin — no JS config file (tailwind.config.js) needed; theme
// customization happens in CSS via @theme blocks if/when we want it.
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

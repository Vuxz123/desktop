/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./*.html",
    "./**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      boxShadow: {
        light: "0 0 8px rgba(127,127,127,0.4)",
        dark: "0 0 8px rgba(0,0,0,0.4)",
      },
    },
  },
  plugins: [
  ],
}

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        heading: ['Instrument Serif', 'serif'],
        body: ['Barlow', 'sans-serif'],
        dirtyline: ['Dirtyline', 'sans-serif'],
        display: ['"Neue Haas Grotesk Display Pro 55 Roman"', '"Neue Haas Grotesk Text Pro"', '"Helvetica Neue"', 'Helvetica', 'Arial', 'sans-serif'],
      },
      borderRadius: { DEFAULT: '9999px' },
    },
  },
  plugins: [],
}

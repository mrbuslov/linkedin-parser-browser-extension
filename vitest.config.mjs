// Vitest config — jsdom env for DOM-touching tests, node otherwise.
// We declare jsdom globally so any test that needs `document` just works;
// pure-logic tests don't pay any cost beyond initial setup.
export default {
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['tests/**/*.test.js'],
    reporters: ['default'],
  },
};

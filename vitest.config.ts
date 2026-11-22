import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['cards/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'], testTimeout: 15000 }
})

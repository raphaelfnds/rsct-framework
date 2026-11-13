import { vi } from 'vitest'

export const BASH_BLOCK_TIMEOUT_MS = 120_000
export const BASH_TEST_TIMEOUT_MS = 600_000

vi.setConfig({ testTimeout: BASH_TEST_TIMEOUT_MS })

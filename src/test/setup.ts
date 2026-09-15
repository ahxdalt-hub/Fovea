import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Vitest globals are off, so Testing Library's auto-cleanup never registers.
// Without this, each test's render leaks into the next document.body.
afterEach(cleanup)

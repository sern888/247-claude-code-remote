// Test setup for web app
import { vi } from 'vitest';

// framer-motion drives animations through the Web Animations API whenever
// Element.prototype.animate exists. happy-dom implements it since 20.14, but
// its Animation.cancel() rejects the "finished" promise, which framer-motion
// does not handle and vitest then reports as an unhandled rejection on every
// unmount. Without the API framer-motion falls back to JS animations, which
// is what the tests ran against before.
delete (Element.prototype as { animate?: unknown }).animate;

function createStorageMock() {
  let store: Record<string, string> = {};

  return {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  } as Storage;
}

if (
  !('localStorage' in window) ||
  !window.localStorage ||
  typeof window.localStorage.getItem !== 'function'
) {
  Object.defineProperty(window, 'localStorage', {
    writable: true,
    value: createStorageMock(),
  });
}

if (
  !('sessionStorage' in window) ||
  !window.sessionStorage ||
  typeof window.sessionStorage.getItem !== 'function'
) {
  Object.defineProperty(window, 'sessionStorage', {
    writable: true,
    value: createStorageMock(),
  });
}

// Mock Next.js router
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock Notification API
Object.defineProperty(window, 'Notification', {
  writable: true,
  value: class MockNotification {
    static permission = 'default';
    static requestPermission = vi.fn().mockResolvedValue('granted');
    constructor() {}
    close = vi.fn();
  },
});

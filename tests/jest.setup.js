// FILE: tests/jest.setup.js
import { ReadableStream, WritableStream } from 'web-streams-polyfill';
import { webcrypto } from 'crypto';
import { TextEncoder, TextDecoder } from 'util';
import 'fake-indexeddb/auto';
import { jest } from '@jest/globals';

// Manually apply the streams polyfill
global.ReadableStream = ReadableStream;
global.WritableStream = WritableStream;
// Polyfill for Web Worker
global.Worker = class Worker {
  constructor(stringUrl) {
    this.url = stringUrl;
  }
  onmessage(e) {}
  postMessage(msg) {}
  addEventListener(event, cb) {}
  terminate() {}
};
// Polyfill for IntersectionObserver
global.IntersectionObserver = class IntersectionObserver {
  constructor(callback, options) {}
  observe(element) {}
  unobserve(element) {}
  disconnect() {}
};
// Polyfills
if (!global.crypto) {
  global.crypto = {};
}
if (!global.crypto.subtle) {
  global.crypto.subtle = webcrypto.subtle;
}
if (!global.TextEncoder) {
  global.TextEncoder = TextEncoder;
}
if (!global.TextDecoder) {
  global.TextDecoder = TextDecoder;
}

// Mock WebRTC
global.RTCPeerConnection = jest.fn();

// Mock localStorage with a more robust implementation
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: jest.fn(key => store[key] || null),
    setItem: jest.fn((key, value) => {
      store[key] = value.toString();
    }),
    removeItem: jest.fn(key => {
      delete store[key];
    }),
    clear: jest.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(global, 'localStorage', {
  value: localStorageMock,
  writable: true
});

// Suppress console during tests
global.console = {
  ...console,
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

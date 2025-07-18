import { jest, describe, beforeEach, test, expect } from '@jest/globals';

// 1. Mock the modules BEFORE they are imported by any other file.
jest.unstable_mockModule('webtorrent', () => ({
  __esModule: true,
  default: jest.fn(),
}));

// EXPANDED THIS MOCK to include all necessary functions
jest.unstable_mockModule('../ui.js', () => ({
  __esModule: true,
  updateConnectionStatus: jest.fn(),
  notify: jest.fn(),
  updateStatus: jest.fn(),
  refreshPost: jest.fn(),
  renderPost: jest.fn(),
  setSendPeer: jest.fn(),
  updateProfilePicturesInPosts: jest.fn(),
}));

jest.unstable_mockModule('../services/instances.js', () => ({
  __esModule: true,
  getServices: () => ({
    peerManager: {
      updateScore: jest.fn(),
    },
  }),
}));

// 2. Now, dynamically import the modules needed for the test.
const { initNetwork, handlePeerMessage, sendPeer } = await import('./network-manager.js');
const { state } = await import('../state.js');
const WebTorrent = (await import('webtorrent')).default;

// 3. Proceed with the tests.
describe('Network Manager', () => {
  let mockClient;
  let mockWire;

  beforeEach(() => {
    // Clear any previous mock implementations and calls
    jest.clearAllMocks();

    // Reset state
    state.peers = new Map();
    state.client = null;
    state.dht = null;
    state.hyparview = null;
    state.identityRegistry = null;
    state.peerIdentities = new Map();

    // Mock WebTorrent client implementation for this test
    mockClient = {
      on: jest.fn(),
      seed: jest.fn((data, opts, cb) => {
        const mockTorrent = {
          on: jest.fn(),
          infoHash: 'mock-hash',
          numPeers: 0,
        };
        if (cb) cb(mockTorrent);
        return mockTorrent;
      }),
      destroy: jest.fn(),
    };
    WebTorrent.mockImplementation(() => mockClient);

    // Mock wire for handling peer messages
    mockWire = {
      peerId: 'test-peer-id',
      destroyed: false,
      extended: jest.fn(),
      ephemeral_msg: { _ready: true, peerId: 1 },
      on: jest.fn(),
      use: jest.fn(),
      destroy: jest.fn(),
    };
  });

  describe('Network Initialization', () => {
    test('should initialize WebTorrent client', () => {
      initNetwork();
      expect(WebTorrent).toHaveBeenCalled();
      expect(state.client).toBe(mockClient);
      expect(mockClient.seed).toHaveBeenCalled();
    });

    test('should handle WebRTC not supported', () => {
      const originalRTC = global.RTCPeerConnection;
      global.RTCPeerConnection = undefined; // Simulate no WebRTC support

      initNetwork();

      // Ensure the client was not created when WebRTC is unavailable
      expect(state.client).toBeNull();

      global.RTCPeerConnection = originalRTC; // Restore for other tests
    });
  });

  describe('Peer Message Handling', () => {
    test('should handle rate limiting by dropping messages', async () => {
      const peerId = 'rate-limited-peer';
      const peerData = {
        messageTimestamps: [],
        wire: mockWire,
      };
      state.peers.set(peerId, peerData);
      mockWire.peerId = peerId;

      const handler = jest.fn();
      // Temporarily register a handler to see if it gets called
      (await import('./network-manager.js')).registerHandler('new_post', handler);

      // Exceed the rate limit
      for (let i = 0; i < 60; i++) {
        peerData.messageTimestamps.push(Date.now());
      }

      const msg = { type: 'new_post', msgId: 'test-msg-rate-limit' };
      await handlePeerMessage(msg, mockWire);

      // The handler should NOT have been called because the message was dropped
      expect(handler).not.toHaveBeenCalled();
    });

    test('should handle DHT RPC messages', async () => {
      state.dht = {
        handleRPC: jest.fn(),
      };
      const msg = { type: 'dht_rpc', method: 'PING' };
      await handlePeerMessage(msg, mockWire);
      expect(state.dht.handleRPC).toHaveBeenCalledWith(msg, mockWire);
    });

    test('should handle identity announcements', async () => {
      state.identityRegistry = {
        lookupHandle: jest.fn().mockResolvedValue({ publicKey: 'test-key' }),
      };
      const msg = {
        type: 'identity_announce',
        handle: 'alice',
        publicKey: 'test-key',
        wirePeerId: 'wire-peer-123',
      };
      await handlePeerMessage(msg, mockWire);
      expect(state.peerIdentities.has(mockWire.peerId)).toBe(true);
      expect(state.peerIdentities.get(mockWire.peerId).handle).toBe('alice');
    });
  });

  describe('Message Sending', () => {
    test('should send messages via wire extension', () => {
      const msg = { type: 'test', data: 'hello' };
      sendPeer(mockWire, msg);
      expect(mockWire.extended).toHaveBeenCalled();
    });

    test('should queue messages if extension not ready', () => {
      mockWire.ephemeral_msg._ready = false;
      mockWire.extendedMapping = undefined;
      const msg = { type: 'test' };
      sendPeer(mockWire, msg);
      expect(mockWire._pendingMessages).toBeDefined();
      expect(mockWire._pendingMessages.length).toBe(1);
    });

    test('should enforce message size limits', () => {
      const largeMsg = { data: 'x'.repeat(2 * 1024 * 1024) }; // 2MB
      sendPeer(mockWire, largeMsg);
      expect(mockWire.extended).not.toHaveBeenCalled();
    });
  });
});

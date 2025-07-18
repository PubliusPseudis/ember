import { jest, describe, beforeEach, test, expect } from '@jest/globals';

// FIX: Path is relative to the project root for mocks
jest.unstable_mockModule('/p2p/message-bus.js', () => ({
  __esModule: true,
  messageBus: {
    sendPeer: jest.fn(),
    setSendPeer: jest.fn(),
  },
}));

// Import modules
const { KademliaDHT } = await import('./dht.js');

describe('KademliaDHT', () => {
  let dht;
  const nodeId = new Uint8Array(20).fill(1);

  beforeEach(() => {
    dht = new KademliaDHT(nodeId);
    jest.clearAllMocks();
  });

  describe('Basic Operations', () => {
    test('should initialize with correct node ID', () => {
      expect(dht.nodeId).toEqual(nodeId);
      expect(dht.buckets.length).toBe(160);
    });

    test('should calculate XOR distance correctly', () => {
      const id1 = new Uint8Array(20).fill(0);
      const id2 = new Uint8Array(20).fill(255);
      const distance = dht.distance(id1, id2);
      expect(distance.every(byte => byte === 255)).toBe(true);
    });

    test('should find correct bucket index', () => {
      const peerId = new Uint8Array(20).fill(2);
      const bucketIndex = dht.getBucketIndex(peerId);
      expect(bucketIndex).toBeGreaterThanOrEqual(0);
      expect(bucketIndex).toBeLessThan(160);
    });
  });

  describe('Peer Management', () => {
    test('should add peer to correct bucket', () => {
      const peerId = new Uint8Array(20).fill(2);
      const peerInfo = { wire: {} };
      dht.addPeer(peerId, peerInfo);
      const bucketIndex = dht.getBucketIndex(peerId);
      const bucket = dht.buckets[bucketIndex];
      expect(bucket.length).toBe(1);
      expect(bucket[0].id).toEqual(peerId);
    });

    test('should not add self as peer', () => {
      dht.addPeer(nodeId, { wire: {} });
      const allPeers = dht.buckets.flat();
      expect(allPeers.length).toBe(0);
    });

    test('should handle k-bucket overflow', () => {
      const bucketIndex = 159;
      for (let i = 0; i < dht.k; i++) {
        const peerId = new Uint8Array(20);
        peerId[0] = 128;
        peerId[19] = i;
        dht.addPeer(peerId, { wire: {} });
      }
      expect(dht.buckets[bucketIndex].length).toBe(dht.k);

      const newPeerId = new Uint8Array(20);
      newPeerId[0] = 128;
      newPeerId[19] = 255;
      dht.ping = jest.fn().mockResolvedValue(true);
      dht.addPeer(newPeerId, { wire: {} });
      expect(dht.buckets[bucketIndex].length).toBe(dht.k);
    });
  });

  describe('Storage Operations', () => {
    test('should store and retrieve values locally', async () => {
      const key = 'test-key';
      const value = { data: 'test-value' };
      await dht.store(key, value, { propagate: false });
      const retrieved = await dht.get(key);
      expect(retrieved).toEqual(value);
    });

    test('should handle storage with replication', async () => {
      const peers = [];
      for (let i = 0; i < 5; i++) {
        const peerId = new Uint8Array(20).fill(i + 2);
        dht.addPeer(peerId, { wire: { destroyed: false } });
      }
      dht.sendRPC = jest.fn().mockResolvedValue({ stored: true });
      const result = await dht.store('test-key', 'test-value');
      expect(result.stored).toBe(true);
      expect(result.replicas).toBeGreaterThan(1);
    });

    test('should enforce storage limits', async () => {
      const handler = dht.rpcHandlers.get('STORE');
      const largeValue = 'x'.repeat(64 * 1024 + 1);
      const result = handler({ key: 'large', value: largeValue }, 'sender1');
      expect(result.stored).toBe(false);
      expect(result.error).toBe('Value too large');
    });
  });

  describe('Serialization', () => {
    test('should serialize and deserialize state correctly', async () => {
      const peerId = new Uint8Array(20).fill(2);
      dht.addPeer(peerId, { wire: {} });
      await dht.store('key1', 'value1', { propagate: false });
      const serializedState = dht.serialize();
      const dht2 = new KademliaDHT(nodeId);
      dht2.deserialize(serializedState);
      expect(dht2.storage.size).toBe(1);
      expect(dht2.buckets.flat().length).toBe(1);
    });
  });

  describe('Network Partitioning', () => {
    test('should handle operations with no peers', async () => {
      const value = await dht.get('nonexistent-key');
      expect(value).toBeNull();
      const result = await dht.store('test-key', 'test-value');
      expect(result.stored).toBe(true);
      expect(result.replicas).toBe(1);
    });

    test('should timeout on unresponsive peers', async () => {
      const peerId = new Uint8Array(20).fill(2);
      dht.addPeer(peerId, { wire: {} });
      dht.sendRPC = jest.fn(() => new Promise(() => {}));
      const promise = dht.getWithTimeout('test-key', 100);
      await expect(promise).resolves.toBeNull();
    });
  });
});

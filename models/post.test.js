import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';
import nacl from 'tweetnacl';

// Mock dependencies
jest.unstable_mockModule('../services/instances.js', () => ({
  __esModule: true,
  getImageStore: () => ({
    storeImage: jest.fn().mockResolvedValue({ hash: 'mock-hash' }),
    images: new Map(),
  }),
}));

// Import modules
const { Post } = await import('./post.js');
const { state } = await import('../state.js');

describe('Post Model', () => {
  let mockIdentity;

  beforeEach(() => {
    const keyPair = nacl.sign.keyPair();
    mockIdentity = {
      handle: 'test-user',
      publicKey: keyPair.publicKey,
      secretKey: keyPair.secretKey,
      vdfProof: { y: '', pi: '', l: '', r: '', iterations: 1000n },
      vdfInput: 'mock-input',
    };
    state.myIdentity = mockIdentity;
  });

  afterEach(() => {
    state.myIdentity = null;
  });

  test('should create and sign a post successfully', () => {
    const post = new Post('This is a test post.');
    post.sign(mockIdentity.secretKey);
    expect(post).toBeInstanceOf(Post);
    expect(post.signature).toBeInstanceOf(Uint8Array);
    expect(post.signature.length).toBeGreaterThan(64);
  });

  test('should successfully verify a correctly signed post', () => {
    const post = new Post('This is a test post.');
    post.sign(mockIdentity.secretKey);
    const isVerified = post.verify();
    expect(isVerified).toBe(true);
  });

  test('should fail verification if the post content is tampered with', () => {
    const post = new Post('Original content.');
    post.sign(mockIdentity.secretKey);
    post.content = 'Tampered content!';
    const isVerified = post.verify();
    expect(isVerified).toBe(false);
  });

  test('should fail verification if the signature is tampered with', () => {
    const post = new Post('This is a test post.');
    post.sign(mockIdentity.secretKey);
    post.signature[5] = post.signature[5] ^ 1;
    const isVerified = post.verify();
    expect(isVerified).toBe(false);
  });

  test('should serialize to JSON and reconstruct correctly', () => {
    const post = new Post('Testing JSON serialization.');
    post.sign(mockIdentity.secretKey);
    const json = post.toJSON();
    const reconstructedPost = Post.fromJSON(json);
    expect(reconstructedPost.id).toBe(post.id);
    expect(reconstructedPost.author).toBe('test-user');
    const isVerified = reconstructedPost.verify();
    expect(isVerified).toBe(true);
  });
});

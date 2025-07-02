# Ember: An Ephemeral P2P Social Network 🔥

A trust-minimized, censorship-resistant social network where content persistence is determined by community interest rather than corporate algorithms or permanent storage.

**Live Network**: https://ember-network.netlify.app/  
**Repository**: https://github.com/PubliusPseudis/ember/tree/main

## Overview

Ember implements a novel approach to decentralized social networking where posts exist only as long as network participants actively choose to "carry" them. This creates a natural attention economy without artificial engagement metrics, while preserving user autonomy through local-first moderation and cryptographic identity guarantees.

The protocol combines several cryptographic and distributed systems primitives to achieve properties traditionally considered mutually exclusive: ephemerality with reliability, openness with spam resistance, and community governance without central coordination.

## Design Philosophy

### Trust Minimization
Following cypherpunk principles, Ember minimizes trust requirements at every layer:
- **Identity**: Self-sovereign identities secured by Verifiable Delay Functions (VDFs)
- **Content**: Cryptographically signed posts with community attestation
- **Moderation**: Local-first filtering with user-controlled rulesets
- **Network**: No privileged nodes or coordinators

### Ephemeral by Design
Posts naturally expire when community interest wanes, creating:
- **Organic content lifecycle** without arbitrary deletion policies
- **Natural spam resistance** through carry cost
- **Privacy through forgetfulness** - the network has no permanent memory

## Technical Architecture

### Network Stack

The protocol employs a multi-layer P2P architecture:

```
Application Layer:     Posts, Carries, Replies, DMs
├── Routing Layer:     Dandelion, Traffic Mixing  
├── Multicast Layer:   Scribe Trees, Plumtree Gossip
├── Overlay Layer:     HyParView, Kademlia DHT
└── Transport Layer:   WebTorrent (WebRTC + Trackers)
```

**WebTorrent Bootstrap**: Leverages existing WebRTC infrastructure for NAT traversal and initial peer discovery through a shared bootstrap torrent.

**Kademlia DHT**: Provides decentralized storage for identity claims and routing information with configurable replication factor (default: 20).

**HyParView**: Maintains a partial view overlay for reliable message dissemination with Active View (5 peers) and Passive View (30 peers).

**Scribe/Plumtree**: Topic-based multicast trees with efficient gossip dissemination and lazy push for bandwidth optimization.

### Cryptographic Identity System

Identity creation employs VDFs to impose computational cost without ongoing proof-of-work:

```rust
identity = {
  handle: string,
  publicKey: Ed25519PublicKey,
  vdfProof: WesolowskiVDFProof,
  nodeId: SHA1(publicKey)
}
```

**VDF Implementation**: 
- Wesolowski's construction with RSA-2048 modulus
- Adaptive difficulty based on device calibration (1-30 seconds)
- Deterministic verification in O(log T) time
- WASM implementation for consistent cross-platform behavior

**Benefits**:
- Sybil resistance without ongoing computational waste
- One-time identity cost encourages reputation building
- Device-agnostic time-lock puzzles

### Content Attestation Protocol

Posts undergo progressive verification through community attestation:

1. **Signature Verification**: Ed25519 signature validates authorship
2. **VDF Verification**: Proof-of-work prevents spam at creation time
3. **Trust Accumulation**: Peers attest to post validity weighted by reputation
4. **Threshold Acceptance**: Posts accepted after reaching configurable trust score

This creates a "web of trust" without central authorities, where peer reputation emerges from attestation accuracy over time.

### Privacy-Preserving Routing

**Dandelion++ Implementation (no Onion routing yet)**:
- Stem phase: 90% probability of forwarding to single peer
- Fluff phase: Epidemic broadcast after random walk
- Planned - Onion routing: 3-layer encryption for high-value posts

**Traffic Analysis Resistance**:
- Noise injection at 10-second intervals
- Message mixing pools with random delays
- Padding to obscure message sizes

### Local-First Moderation

Content filtering operates entirely client-side with pluggable rulesets:

```javascript
contentSafety: {
  patterns: RegExp[],        // Detection patterns
  obfuscation: Analyzer,     // Leetspeak, unicode tricks
  contextual: Evaluator,     // Consider surrounding text
  severity: Classifier       // critical/high/medium/low
}
```

**Key Features**:
- N-gram similarity detection for obfuscation
- Context-aware evaluation (quotes, education, fiction)
- Hot-reloadable JSON rulesets
- No network consensus required

**Image Screening**: Local NSFWJS model prevents illegal content without central scanning.

### Ephemeral Storage Model

Content persistence follows thermodynamic principles:

```
Heat(post) = Carriers(post) + 2 × Replies(post)
Priority = Heat / (Age + 1)^1.5
```

**Carrier Mechanics**:
- Users explicitly "carry" posts they value
- Carried posts propagate to new peers
- Zero carriers → post evaporates
- Replies automatically carried with parent

**Memory Management**:
- Adaptive cleanup based on heap usage
- Priority queue eviction
- Explicit carries never evicted

### Direct Messaging

End-to-end encrypted DMs using NaCl box construction:

```
ciphertext = nacl.box(message, nonce, recipientPublicKey, senderSecretKey)
```

**Routing**: DHT-based peer location with store-and-forward for offline recipients.

## Running Ember

### Web Client

```bash
git clone https://github.com/PubliusPseudis/ember
cd ember
npm install
npm run build
# Serve the 'docs' directory on any HTTP server
```

### Headless Relay Node

Support the network by running a headless relay:

```bash
# Create identity in browser first, export to headless-identity.json
node headless.js
```

Relay nodes strengthen the network by:
- Maintaining DHT state across sessions
- Relaying posts between browser peers  
- Providing stable routing infrastructure

## Protocol Properties

### Achieved
- **Censorship Resistance**: No single point of control
- **Sybil Resistance**: VDF-based identity cost
- **Privacy**: Dandelion routing, local filtering
- **Ephemerality**: Natural content expiration
- **Spam Resistance**: Computational and social costs

### Trade-offs
- **No Persistent History**: Feature, not bug
- **Online Requirement**: Peers must be active to maintain content
- **Bootstrap Dependency**: Initial WebTorrent trackers needed

## Future Directions

- **Proof of Carry**: Cryptographic evidence of content propagation
- **Reputation Markets**: Transferable attestation credits
- **Bridge Nodes**: Gateway to other protocols (Nostr, ActivityPub)
- **Mobile Clients**: Native implementations for better battery life

## Contributing

Ember is an experiment in trust-minimized social protocols. Contributions welcome, particularly in:
- Cryptographic protocol improvements
- Network resilience enhancements  
- Privacy-preserving features
- Accessibility improvements

## License

GPL-3.0 - Copyleft ensures the protocol remains open.

---

*"In a world of permanent records, the right to be forgotten is revolutionary. In a world of corporate algorithms, community curation is radical. Ember is both."*

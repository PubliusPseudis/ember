# Ember: An Ephemeral P2P Social Network 🔥

A trust-minimized, censorship-resistant social network where content persistence is determined by community interest rather than corporate algorithms or permanent storage.

**Live Network**: https://ember-network.netlify.app/
**Repository**: https://github.com/PubliusPseudis/ember/

---

## Overview

Ember implements a novel approach to decentralized social networking where posts exist only as long as network participants actively choose to "carry" them. This creates a natural attention economy without artificial engagement metrics, while preserving user autonomy through local-first moderation and cryptographic identity guarantees.

The protocol combines several cryptographic and distributed systems primitives to achieve properties traditionally considered mutually exclusive: ephemerality with reliability, openness with spam resistance, and community governance without central coordination.

---

## Design Philosophy

### Trust Minimization
Following cypherpunk principles, Ember minimizes trust requirements at every layer:
- **Identity**: Self-sovereign identities secured by Verifiable Delay Functions (VDFs).
- **Content**: Cryptographically signed posts with community attestation.
- **Moderation**: Local-first filtering with user-controlled rulesets.
- **Network**: No privileged nodes or coordinators.

### Ephemeral by Design
Posts naturally expire when community interest wanes, creating:
- **Organic content lifecycle** without arbitrary deletion policies.
- **Natural spam resistance** through carry cost.
- **Privacy through forgetfulness** - the network has no permanent memory.

---

## Technical Architecture

### Network Stack

The protocol employs a multi-layer P2P architecture running directly in the browser:

```
Application Layer:    Posts, Carries, Replies, DMs, Profiles
├── Privacy Layer:      Reputation-Aware Relays, Traffic Mixing
├── Multicast Layer:    Scribe Trees
├── Overlay Layer:      HyParView, Kademlia DHT
└── Transport Layer:    WebTorrent (WebRTC + Trackers)
```

**WebTorrent Bootstrap**: Leverages existing WebRTC infrastructure for NAT traversal and initial peer discovery through a shared bootstrap infohash.

**Kademlia DHT**: Provides a decentralized key-value store for identity claims, user profiles, and peer routing information with a high replication factor.

**HyParView**: Maintains a robust and resilient partial view of the network, ensuring efficient message propagation even in a dynamic environment with high churn. It manages a small **Active View** (e.g., 5 peers) for direct connections and a larger **Passive View** (e.g., 30 peers) for fault tolerance.

**Scribe**: A topic-based multicast protocol built on top of HyParView and the DHT. It creates dynamic distribution trees for each topic (e.g., `#general`), ensuring that messages are only sent to interested peers.

### Cryptographic Identity System

Identity creation employs VDFs to impose a one-time computational cost, preventing mass account creation without requiring ongoing proof-of-work.

```javascript
// Simplified structure
identity = {
  handle: string,
  publicKey: Ed25519PublicKey, // For signing
  encryptionPublicKey: Curve25519PublicKey, // For DMs
  vdfProof: WesolowskiVDFProof,
  nodeId: SHA1(publicKey)
}
```

**VDF Implementation**:

  - **Wesolowski's VDF** construction with the standard RSA-2048 modulus, which has an unknown factorization.
  - **Adaptive Difficulty** based on a brief device calibration, targeting a \~30-second computation time regardless of hardware speed.
  - **Fast Verification** allows any node to instantly validate the proof-of-work.
  - **WASM Implementation** written in Rust ensures consistent, high-performance execution across all browsers.

### Content Attestation Protocol

Posts undergo a progressive, trust-based verification process to balance speed and security:

1.  **Local Pre-Checks**: Content and images are checked against local toxicity filters before being sent.
2.  **Signature & VDF Verification**: All posts must have a valid Ed25519 signature and a valid VDF proof from the author's identity.
3.  **Trust Accumulation**: Upon receipt, peers with high reputation can attest to a post's validity. This attestation is broadcast to the network.
4.  **Threshold Acceptance**: A post that accumulates a sufficient trust score from attestations is immediately accepted and displayed, bypassing the slower full VDF verification in the browser.

This creates a "web of trust" where the community collaboratively accelerates content validation, and peer reputation emerges from the accuracy of these attestations over time.

### Privacy-Preserving Routing

To decouple a user's IP address from their posts, Ember uses a privacy layer before multicasting content.

**Reputation-Aware Relays**:

  - Instead of broadcasting a post directly, a user encrypts it and sends it to a random **relay topic**.
  - High-reputation nodes act as **mixing nodes**, listening on these relay topics. They collect, batch, and re-broadcast the decrypted posts after a random delay, obscuring the original sender.

**Traffic Analysis Resistance**:

  - **Noise Injection**: The network periodically sends random noise packets to obscure real traffic patterns.
  - **Message Mixing**: A traffic mixer service introduces random delays to incoming messages to resist timing analysis.

### Local-First Moderation

Content filtering operates entirely on the client-side, giving users full control.

```javascript
contentSafety: {
  patterns: RegExp[],      // Detection patterns
  obfuscation: Analyzer,   // Leetspeak, unicode tricks
  contextual: Evaluator,   // Considers quotes, news, fiction
  severity: Classifier     // critical/high/medium/low
}
```

**Key Features**:

  - **Advanced Obfuscation Detection**: Identifies leetspeak, homoglyphs (unicode variants), excessive spacing, and other common evasion tactics.
  - **Context-Aware Evaluation**: The system is designed to differentiate between a genuine threat and the same words used in a news report, a fictional story, or an educational context.
  - **Hot-Reloadable Rulesets**: The moderation engine can load updated filtering rules from a JSON file without requiring a full application update.
  - **Image Screening**: An integrated **TensorFlow.js** (`nsfwjs`) model screens images locally for potentially harmful content before they are displayed.

### Ephemeral Storage Model

Content persistence is a function of community interest, not a default state. A post's priority for being kept in memory is determined by its "heat" and age.

**Priority Calculation**:
`Priority = (Carriers + 2 * Replies) / (AgeInHours + 1)^1.5`

**Carrier Mechanics**:

  - Users explicitly **"carry"** posts they value to keep them alive.
  - Carried posts are propagated to new peers, increasing their lifespan.
  - When a post has zero carriers and is not part of an active thread, it eventually "evaporates" from the network.

**Memory Management**:

  - An adaptive cleanup process runs periodically, checking the browser's heap usage.
  - If memory is high, the lowest-priority posts are pruned from local storage.
  - Posts that a user has explicitly carried are protected from automatic cleanup.

### Direct Messaging

DMs are end-to-end encrypted using the `nacl.box` (Curve25519) construction, ensuring only the sender and recipient can read them.

```javascript
ciphertext = nacl.box(message, nonce, recipientPublicKey, senderSecretKey)
```

**Routing**: The DHT is used to look up a recipient's last known location. If the user is offline, messages are stored locally by the sender and are delivered automatically the next time both users are online.

-----

## Running Ember

### Web Client

```bash
# 1. Clone the repository
git clone [https://github.com/PubliusPseudis/ember.git](https://github.com/PubliusPseudis/ember.git)
cd ember

# 2. Install dependencies
npm install

# 3. Run the local development server
npm run dev
```

The application will be available at `http://localhost:5173` (or the next available port).

-----

## Protocol Properties

### Status of Protocol as Implemented

  - **Censorship Resistance**: No central servers or single point of failure.
  - **Sybil Resistance**: VDF-based computational cost for identity creation.
  - **Privacy**: Traffic mixing and a reputation-aware relay system help obscure message origins.
  - **Ephemerality**: Content expires naturally based on community interest.
  - **Spam Resistance**: A combination of VDFs, rate limiting, and a peer reputation system.

### Community Rating System

Posts support community ratings using a Bayesian approach:

  - **Weighted Voting**: A user's vote impact is weighted by their peer reputation score.
  - **Beta-Binomial Model**: Calculates a post's score while accounting for uncertainty, preventing a single vote from having a disproportionate impact.

### Reputation System

Peers build reputation through positive network actions:

  - Relaying valid posts and providing correct attestations.
  - Maintaining uptime and contributing to the network.
  - Reputation is used to weight attestations and community ratings.

### Advanced Features

  - **Image Storage**: Images are split into content-addressed chunks and verified with a Merkle tree to ensure integrity and enable efficient P2P sharing.
  - **Offline Messaging**: DMs are queued for offline recipients and delivered upon their return.
  - **Rate Limiting**: The network manager automatically throttles connections and messages from excessively active peers.
  - **Dual-Key Identity**: Users have separate Ed25519 (signing) and Curve25519 (encryption) keypairs for enhanced security.

### Trade-offs

  - **No Persistent History**: This is a core feature, not a bug. Content is not meant to be permanent.
  - **Online Requirement**: Active peers are required to maintain content persistence.
  - **Bootstrap Dependency**: The network relies on public WebTorrent trackers for initial peer discovery.

## License

GPL-3.0 - Copyleft ensures the protocol and its derivatives remain open and free.

-----

*"In a world of permanent records, the right to be forgotten is revolutionary. In a world of corporate algorithms, community curation is radical. Ember is both."*

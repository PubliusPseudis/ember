# 🔥 Ember: The Ephemeral Social Network – Where Posts Live and Die

## About

Ember is a decentralized, peer-to-peer social network where the lifespan of content is determined by the community. Unlike traditional social media, posts on Ember are ephemeral; they "live" as long as users actively "carry" them, metaphorically fanning their flames. When a post runs out of "breaths" (carriers), it "dies" and vanishes from the network.

This project is an experiment in decentralized content persistence, privacy-preserving routing, and proof-of-work based identity. It leverages a modern P2P stack, WebAssembly for performance-critical operations, and advanced cryptographic principles.

**Experience a truly open social network, free from the constraints of corporate control. No ads. No algorithms dictating your feed. No hidden data mining. Just genuine, ephemeral interactions driven by the community.**

## Features

* **Ephemeral Posts:** Content persists only as long as it is actively carried by peers. When all carriers drop a post, it disappears.
* **Modular, Modern Architecture:** The entire application is built with a clean separation of concerns, using ES Modules for maintainability and scalability.
* **Advanced P2P Stack:** Ember uses a multi-layered P2P networking stack for resilience and efficiency:
    * **HyParView & Plumtree:** For maintaining a robust active peer set and enabling efficient, low-overhead message gossip.
    * **Scribe:** A topic-based multicast protocol for hashtag-based content discovery and filtering.
    * **Kademlia-based DHT:** For peer discovery and distributed data storage.
    * **Dandelion++ Routing:** For privacy-preserving message routing that obscures the origin of posts.
* **High-Performance VDF Identity (Rust & WASM):** New user identities are generated via a Verifiable Delay Function written in Rust and compiled to WebAssembly. This computation runs in a Web Worker to prevent UI blocking, providing a smooth and secure Sybil-resistant identity mechanism.
* **Robust Verification Pipeline:** Post and identity signatures are verified cryptographically in a background worker queue, ensuring network integrity without impacting user experience.
* **Content-Addressed Images:** Images are chunked, hashed, and stored using a content-addressed model with Merkle trees for data integrity, enabling resilient and efficient P2P image sharing.
* **Local Data Persistence:** Posts are saved locally using IndexedDB, managed by a dedicated `StateManager`, and intelligently re-integrated into the network on rejoining.
* **Client-Side Content Moderation:** Integrates TensorFlow.js models for optional, client-side toxicity detection and NSFW image filtering. **Your data remains on your device.**

## Technology Stack

* **P2P Networking:** WebTorrent.js for browser-to-browser connectivity.
* **Custom P2P Protocol Suite:**
    * **HyParView, Plumtree, Scribe, Dandelion:** Custom implementations for robust and efficient gossip and pub/sub.
    * **Kademlia DHT:** For peer routing and discovery.
* **Core Technologies:** Modern HTML5, CSS3, and ES6+ JavaScript.
* **Cryptography:** TweetNacl.js for Ed25519 digital signatures.
* **VDF Engine:** A custom Rust-based Verifiable Delay Function compiled to **WebAssembly** for high performance.
* **Background Processing:** **Web Workers** for non-blocking VDF computation and post verification.
* **Client-Side AI:** TensorFlow.js with the Toxicity and NSFW.js models.
* **Security:** DOMPurify for sanitizing user-generated content to prevent XSS attacks.
* **Storage:** IndexedDB for persistent local storage.

## Access it in Pages

You can access the live version of Ember via GitHub Pages: [publiuspseudis.github.io/ember](https://publiuspseudis.github.io/ember)

## How to Run Locally

Ember is designed to run entirely in your web browser.

1.  **Clone the repository:**
    ```bash
    git clone [https://github.com/PubliusPseudis/ember.git](https://github.com/PubliusPseudis/ember.git)
    cd ember
    ```
2.  **Serve the files:** You'll need a simple local web server. Python's built-in server is a good option:
    ```bash
    # For Python 3
    python -m http.server
    ```
    Alternatively, use Node.js with `http-server`:
    ```bash
    npm install -g http-server
    http-server .
    ```
3.  **Open in your browser:** Navigate to `http://localhost:8000` (or the port indicated by your server).

**Note:** For the NSFW.js and VDF modules to work, the `nsfwjs-model/` and `wasm/` directories must be served correctly alongside `index.html`.

## Project Structure

The codebase is organized into a modular structure to ensure separation of concerns and maintainability.

* `index.html`: The main HTML document and application entry point.
* `style.css`: Defines all application styling and themes.
* `main.js`: The central orchestrator; initializes all modules and manages global state.
* `ui.js`: Handles all DOM manipulation, rendering, and UI event listeners.
* `storage.js`: Manages data persistence and all interactions with IndexedDB.
* `config.js`: Contains global configuration constants for the application.
* `p2p/`: Contains all networking protocol implementations (Dandelion, DHT, HyParView, Scribe, Plumtree, etc.).
* `identity/`: Contains the logic for VDF-based identity creation, management, and verification.
* `services/`: Contains background services like the `MemoryManager`, `PeerManager`, and `ImageStore`.
* `models/`: Contains the `Post` class definition.
* `vdf-wasm/`: Contains the Rust source code and compiled WebAssembly module for the Verifiable Delay Function.
* `*-worker.js`: Web Worker scripts for offloading heavy computations (e.g., `vdf-worker.js`, `verify-worker.js`).

## License

This project is open-source and available under the GNU GPL v3 License.

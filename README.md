Ember: The Ephemeral Social Network – Where Posts Live and Die

## About

Ember is a decentralized, peer-to-peer social network where the lifespan of content is determined by the community. Unlike traditional social media, posts on Ember are ephemeral; they "live" as long as users actively "carry" them, metaphorically fanning their flames. When a post runs out of "breaths" (carriers), it "dies" and vanishes from the network.

This project is an experiment in decentralized content persistence, privacy-preserving routing, and proof-of-work based identity. It leverages WebTorrent for P2P communication, NaCl for cryptographic signing, and a custom Verifiable Delay Function (VDF) for Sybil resistance and identity creation.

**Experience a truly open social network, free from the constraints of corporate control. No ads. No algorithms dictating your feed. No hidden data mining. Just genuine, ephemeral interactions driven by the community.**

## Features

* **Ephemeral Posts:** Content persists only as long as it is actively carried by peers. When all carriers drop a post, it disappears.
* **Decentralized Network:** Built on WebTorrent, Ember operates without central servers. All data transfer and storage are peer-to-peer.
* **Proof-of-Work Identity:** New user identities are generated via a Verifiable Delay Function (VDF), providing a lightweight, Sybil-resistant mechanism for account creation.
* **Content-Addressed Images:** Images are chunked, hashed, and stored in a content-addressed manner, ensuring data integrity and efficient sharing. Merkle trees are used for verification.
* **Privacy-Preserving Routing (Dandelion++):** Messages are routed through a Dandelion++ protocol, which includes an onion-routing-like mechanism to obscure the origin of posts and protect user IP addresses.
* **Dynamic Sharding:** The network dynamically creates and joins "shards" (WebTorrent torrents) to improve scalability and content discovery.
* **Local Data Persistence:** Posts that a user explicitly carries are saved locally using IndexedDB and intelligently re-integrated into the network upon rejoining.
* **Client-Side Content Moderation:** Integrates TensorFlow.js models for client-side toxicity detection and NSFW image filtering, empowering users with optional content filtering. **Your data remains on your device.**
* **The Bonfire:** A "hot posts" section showcasing currently popular or active threads based on carrier count and replies.
* **Threaded Conversations:** Posts can be replies to other posts, forming conversational threads.
* **Theme Toggling:** Supports light and dark modes for user interface preference.

## Technology Stack

* **WebTorrent.js:** For peer-to-peer networking and data sharing.
* **TweetNacl.js:** A high-security cryptography library for digital signatures (Ed25519).
* **TensorFlow.js & Toxicity Model:** For client-side text toxicity classification.
* **NSFW.js:** For client-side NSFW image classification.
* **DOMPurify:** For sanitizing user-generated content to prevent XSS attacks.
* **IndexedDB:** For local, persistent storage of user data and carried posts.
* **Custom VDF Implementation:** A Verifiable Delay Function based on RSA-2048 modulus for Sybil resistance in identity creation.
* **Custom Dandelion++ Router:** An implementation of the Dandelion++ protocol for privacy-preserving message routing.
* **HTML, CSS, JavaScript:** The core web technologies for the front-end application.

## Access it in Pages
You can access the live version of Ember via GitHub Pages: [publiuspseudis.github.io/ember](https://publiuspseudis.github.io/ember)


## How to Run Locally

Ember is designed to run entirely in your web browser, leveraging WebTorrent. You can easily run it locally:

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/PubliusPseudis/ember.git
    cd ember
    ```
2.  **Serve the files:** You'll need a simple local web server to run the `index.html` file. Python's built-in server is a good option:
    ```bash
    # For Python 3
    python -m http.server
    # For Python 2
    python -m SimpleHTTPServer
    ```
    Alternatively, you can use Node.js with `http-server`:
    ```bash
    npm install -g http-server
    http-server .
    ```
3.  **Open in your browser:** Navigate to `http://localhost:8000` (or the port indicated by your server) in your web browser.

**Note:** For the NSFW.js image filter to work, the `nsfwjs-model/` directory must be served correctly alongside `index.html`. Using a local web server (as described above) usually handles this automatically.

## How to Use

1.  **Identity Creation:** The first time you open Ember, you'll go through a one-time proof-of-work process to generate your unique identity. This may take a few seconds to a minute, depending on your device's processing power.
2.  **Write Posts:** Use the "Write something ephemeral..." text area to compose your message. You can also attach an image.
3.  **"Light it up":** Click the "🔥 Light it up" button to publish your post to the network. Your post is now "alive" because you are carrying it.
4.  **"Blow" / "Withdraw" (Carry Posts):**
    * To keep a post alive, click the "🌬️ Blow" button on it. This means you are now a "carrier" of that post, contributing to its lifespan.
    * If you are already carrying a post, the button will change to "💨 Withdraw". Clicking this will remove you as a carrier, and the post will eventually die if no other peers are carrying it.
5.  **Reply to Posts:** Click the "💬 Reply" button on any post to open a reply input field.
6.  **"The Bonfire":** The "Bonfire" column on the right displays the "hottest" posts and threads, determined by the number of active carriers and replies.
7.  **Theme Toggle:** Use the "☀️ Light Mode" / "🌙 Dark Mode" button to switch between themes.
8.  **Clear Local Data:** The "🗑️️ Clear Local Data" button allows you to clear your browser's stored posts and reset your identity.

## Project Structure

* `index.html`: The main application file, containing the UI and all JavaScript logic.
* `style.css`: Defines the application's styling and themes.
* `nsfwjs-model/`: Directory containing the pre-trained NSFW.js model files.
* `README.md`: This file.

## Design Principles

* **User-Centric Ephemerality:** Empowering users to directly influence content persistence.
* **Privacy by Design:** Implementing Dandelion++ and other techniques to enhance user privacy.
* **Resilience through Decentralization:** Relying on a P2P network to avoid single points of failure.
* **Sybil Resistance:** Utilizing VDFs for identity creation to prevent abuse.
* **Lightweight and Browser-Based:** Making the network accessible without installing complex software.
* **No Ads, No Data Mining:** A fundamental commitment to a clean, user-focused experience without commercial interests.

## Contributing

Contributions are welcome! If you'd like to contribute, please feel free to open issues or submit pull requests.

## License

This project is open-source and available under the GNU GPL v3 License.

---

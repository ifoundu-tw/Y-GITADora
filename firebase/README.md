# Firebase setup

1. Enable Anonymous Authentication.
2. Create a Realtime Database in `asia-southeast1`.
3. Open Realtime Database > Rules.
4. Paste `database.rules.json` and publish.

Cloudflare is not used. Firebase stores room membership, presence, host state,
song selection, ready state, start commands, and WebRTC signaling only. Drum
hit events travel directly between browser peers over WebRTC DataChannels.

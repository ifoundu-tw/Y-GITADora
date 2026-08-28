# Firebase setup

1. Enable Anonymous Authentication.
2. Create a Realtime Database in `asia-southeast1`.
3. Open Realtime Database > Rules.
4. Paste `database.rules.json` and publish.

Firebase stores room membership, presence, host state, song selection, ready
state, start commands, and real-time hit events. Deploy `database.rules.json`.
Online clients compete for a five-minute maintenance lease; only the winner
reads the compact cleanup index and removes expired hit sessions and rooms that
have remained empty for ten minutes. No paid Cloud Functions are required.

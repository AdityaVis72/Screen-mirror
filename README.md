# Peer-View

Peer-View is a remote-support prototype with a React/Vite browser UI, a Spring
Boot WebSocket signaling/relay service, and a native Java desktop sender.

## Run locally on Windows

Prerequisites: JDK 21 or newer, Maven, and Node.js/npm.

1. Start the backend from the project root:

   ```powershell
   mvn -f backend\pom.xml spring-boot:run
   ```

   It listens on port `5001`; `http://localhost:5001/` reports its health.

2. Start the web UI in a second terminal:

   ```powershell
   Set-Location frontend
   npm install
   npm run dev
   ```

   Open the Vite URL printed in the terminal (normally `http://localhost:5173`).

3. To use the native desktop sender, build it once and launch `run-desktop.bat`:

   ```powershell
   mvn -f desktop\pom.xml package
   .\run-desktop.bat
   ```

   The launcher connects to the local backend by default. To use another
   backend, set `PEERVIEW_WS_URL` to its WebSocket URL (`ws://.../ws` or
   `wss://.../ws`) before launching the desktop client.

## Validate

```powershell
Set-Location frontend
npm run lint
npm run build
Set-Location ..
mvn -f backend\pom.xml test
mvn -f desktop\pom.xml package -DskipTests
node test\e2e-relay.mjs
```

The relay test expects the backend to be running locally on port `5001`.

## Current feature boundaries

- Sessions use an eight-digit code and WebSocket signaling. The browser sender
  shares its screen through WebRTC; the native desktop sender streams captured
  screen frames through the WebSocket relay.
- Remote OS mouse/keyboard injection is implemented by the native desktop
  sender and requires the sender to approve each control request. Browser-only
  sender mode can dispatch events only inside its own page; it cannot control
  the host operating system.
- File transfer is available in both sender modes. The native sender saves
  receiver uploads in Downloads and only serves requested files from Downloads.
  Browser sender mode uses the browser's download and file-picker flows; it
  cannot read or write arbitrary host paths.
- Receiver microphone audio is relayed to the sender. Capturing and sharing
  the sender computer's system audio is not currently implemented.

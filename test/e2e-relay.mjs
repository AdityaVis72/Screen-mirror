// End-to-end relay test: runs against the REAL backend on ws://localhost:5001/ws
// Simulates receiver (browser) and sender (desktop client) and asserts that
// control requests, grants, control events and real-time audio chunks all
// traverse the backend correctly.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const URL = "ws://localhost:5001/ws";
let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
};

const sender = new WebSocket(URL);
const receiver = new WebSocket(URL);
const extraReceiver = new WebSocket(URL);
const queued = new Map(); // socket -> messages not yet consumed

function waitFor(sock, type, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const q = queued.get(sock) || [];
    queued.set(sock, q);
    const idx = q.findIndex((m) => m.type === type);
    if (idx >= 0) { queued.set(sock, q.filter((_, i) => i !== idx)); return resolve(q[idx]); }
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    (sock.__waiters ||= []).push({ type, resolve, reject, timer });
  });
}
function wire(sock) {
  sock.on("message", (d) => {
    const msg = JSON.parse(d.toString());
    const waiters = sock.__waiters ||= [];
    const index = waiters.findIndex((waiter) => waiter.type === msg.type);
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
      return;
    }
    const q = queued.get(sock) || [];
    q.push(msg);
    queued.set(sock, q);
  });
}

let sessionId;
const pcmChunk = Buffer.from(new Int16Array(2048).fill(500)).toString("base64");

await new Promise((res) => {
  let open = 0;
  sender.on("open", () => { if (++open === 3) res(); });
  receiver.on("open", () => { if (++open === 3) res(); });
  extraReceiver.on("open", () => { if (++open === 3) res(); });
});
wire(sender); wire(receiver);
wire(extraReceiver);
sender.__audioCount = 0;
sender.on("message", (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === "audio-message") sender.__audioCount++;
});

console.log("\n== 1. Session create + join ==");
sender.send(JSON.stringify({ type: "create-session" }));
const created = await waitFor(sender, "session-created");
sessionId = created.data.sessionId;
ok("sender receives 8-digit session id", /^\d{8}$/.test(sessionId));

receiver.send(JSON.stringify({ type: "join-session", sessionId }));
const joined = await waitFor(receiver, "session-joined");
ok("receiver joins", joined.data.sessionId === sessionId);
const connected = await waitFor(sender, "receiver-connected");
ok("sender notified of receiver", !!connected);
extraReceiver.send(JSON.stringify({ type: "join-session", sessionId }));
const duplicate = await waitFor(extraReceiver, "session-error");
ok("additional receiver is rejected", duplicate.data.message === "Session already has a receiver");

console.log("\n== 2. Control request + grant (AnyDesk-style) ==");
receiver.send(JSON.stringify({ type: "control-request", sessionId, controlType: "mouse" }));
const ctrlReq = await waitFor(sender, "control-request");
ok("sender gets control-request with controlType", ctrlReq.data.controlType === "mouse");

sender.send(JSON.stringify({ type: "control-response", sessionId, controlType: "mouse", allowed: true }));
const ctrlRes = await waitFor(receiver, "control-response");
ok("receiver gets grant allowed=true", ctrlRes.data.controlType === "mouse" && ctrlRes.data.allowed === true);

console.log("\n== 3. Control events (mouse move + keyboard) relay to sender ==");
receiver.send(JSON.stringify({ type: "control-event", sessionId, event: { kind: "mousemove", x: 0.42, y: 0.17 } }));
const ev1 = await waitFor(sender, "control-event");
ok("mousemove event relayed", ev1.event?.kind === "mousemove" && ev1.event.x === 0.42);

receiver.send(JSON.stringify({ type: "control-event", sessionId, event: { kind: "keydown", key: "a", code: "KeyA", ctrlKey: false } }));
const ev2 = await waitFor(sender, "control-event");
ok("keydown KeyA relayed", ev2.event?.kind === "keydown" && ev2.event.code === "KeyA");

console.log("\n== 4. Application control request/response relay ==");
receiver.send(JSON.stringify({ type: "get-windows", sessionId, data: { search: "" } }));
const windowsRequest = await waitFor(sender, "get-windows");
ok("window list request reaches sender", windowsRequest.data.search === "");
sender.send(JSON.stringify({
  type: "windows-list",
  sessionId,
  windows: [{ title: "Test window", hwnd: 1 }]
}));
const windowsList = await waitFor(receiver, "windows-list");
ok("window list response reaches receiver", windowsList.windows[0].title === "Test window");
receiver.send(JSON.stringify({ type: "control-app", sessionId, data: { action: "focus", hwnd: 1 } }));
const appCommand = await waitFor(sender, "control-app");
ok("application command reaches sender", appCommand.data.action === "focus");
sender.send(JSON.stringify({
  type: "control-app-response",
  sessionId,
  success: true,
  message: "Focused"
}));
const appResult = await waitFor(receiver, "control-app-response");
ok("application command response reaches receiver", appResult.success === true);

console.log("\n== 5. Real-time receiver -> sender audio ==");
for (let i = 0; i < 5; i++) {
  receiver.send(JSON.stringify({ type: "audio-message", sessionId, pcm: pcmChunk, sampleRate: 24000 }));
}
const audio = await waitFor(sender, "audio-message");
ok("audio chunk reaches sender", audio.pcm === pcmChunk && audio.sampleRate === 24000);
await new Promise((r) => setTimeout(r, 500));
const audioTotal = sender.__audioCount || 0;
ok("all 5 audio chunks delivered in 500ms", audioTotal === 5);

console.log("\n== 6. File transfer messages ==");
receiver.send(JSON.stringify({
  type: "file-message",
  sessionId,
  data: { kind: "upload-meta", name: "sample.txt", size: 4 }
}));
const uploadMeta = await waitFor(sender, "file-message");
ok("file upload request reaches sender", uploadMeta.data.kind === "upload-meta");
sender.send(JSON.stringify({
  type: "file-message",
  sessionId,
  data: { kind: "upload-result", name: "sample.txt", message: "Received" }
}));
const uploadResult = await waitFor(receiver, "file-message");
ok("file receipt result reaches receiver", uploadResult.data.kind === "upload-result");

console.log("\n== 7. Revoke + disconnect safety ==");
receiver.send(JSON.stringify({ type: "control-revoke", sessionId }));
const revoked = await waitFor(sender, "control-revoke");
ok("sender receives control-revoke", !!revoked);

console.log("\n== 8. Explicit leave + reconnect ==");
receiver.send(JSON.stringify({ type: "leave-session", sessionId }));
const left = await waitFor(receiver, "session-left");
ok("receiver leaves without closing its WebSocket", left.data.sessionId === sessionId);
const leftNotice = await waitFor(sender, "peer-disconnected");
ok("sender is notified when receiver leaves", leftNotice.data.role === "receiver");
receiver.send(JSON.stringify({ type: "join-session", sessionId }));
const rejoined = await waitFor(receiver, "session-joined");
ok("receiver can rejoin the same session", rejoined.data.sessionId === sessionId);
await waitFor(sender, "receiver-connected");

receiver.close();
const peerGone = await waitFor(sender, "peer-disconnected");
ok("sender notified when receiver drops", peerGone.data.role === "receiver");

extraReceiver.close();
sender.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

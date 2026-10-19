import { useEffect, useRef, useState } from "react";
import "./Sender.css";

const rtcConfig = {
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302"
    }
  ]
};

const WINDOWS_CAPTURE_EXCLUSION_AFFINITY = 0x00000011;

function Sender() {
  const [sessionId, setSessionId] = useState("");
  const [connected, setConnected] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [micLive, setMicLive] = useState(false);
  const [captureExclusionRequested, setCaptureExclusionRequested] = useState(false);
  const [captureExclusionStatus, setCaptureExclusionStatus] = useState("");
  const [grantedControl, setGrantedControl] = useState({ mouse: false, keyboard: false });
  const [controlActivity, setControlActivity] = useState("");
  const [pendingControlRequest, setPendingControlRequest] = useState(null);
  const [pendingDownloadRequest, setPendingDownloadRequest] = useState("");
  const [receivedFile, setReceivedFile] = useState(null);
  const [fileTransferStatus, setFileTransferStatus] = useState("");

  const peerRef = useRef(null);
  const streamRef = useRef(null);
  const socketRef = useRef(null);
  const fileInputRef = useRef(null);
  const incomingUploadRef = useRef(null);
  // --- Receiver -> Sender microphone playback (Web Audio streaming queue) ---
  const audioContextRef = useRef(null);
  const nextStartTimeRef = useRef(0);
  const micIndicatorTimeoutRef = useRef(null);
  const controlChannelRef = useRef(null);
  const grantedControlRef = useRef({ mouse: false, keyboard: false });
  const sessionIdRef = useRef("");
  const controlRequestHandlerRef = useRef(null);
  const fileMessageHandlerRef = useRef(null);

  useEffect(() => {
    const socket = new WebSocket(import.meta.env.VITE_WS_URL || "ws://localhost:5001/ws");
    socketRef.current = socket;

    socket.onopen = () => {
      console.log("WebSocket connected");
      socket.send(JSON.stringify({ type: "create-session" }));
    };

    socket.onmessage = async (event) => {
      const message = JSON.parse(event.data);
      const { type } = message;
      // Control messages are validated and wrapped by the backend; file and
      // media messages are raw relays and carry their data at the top level.
      const data = message.data ?? message;

      switch (type) {
        case "session-created":
          setSessionId(data.sessionId);
          sessionIdRef.current = data.sessionId;
          console.log("Session ID:", data.sessionId);
          break;
        case "receiver-connected":
          console.log("Receiver connected");
          setConnected(true);
          break;
        case "peer-disconnected":
          setConnected(false);
          setGrantedControl({ mouse: false, keyboard: false });
          grantedControlRef.current = { mouse: false, keyboard: false };
          setPendingControlRequest(null);
          setPendingDownloadRequest("");
          setControlActivity("Receiver disconnected. Remote control was revoked.");
          stopSharing();
          resetMicPlayback();
          break;
        case "answer":
          try {
            if (!peerRef.current) return;
            await peerRef.current.setRemoteDescription(
              new RTCSessionDescription(data)
            );
            console.log("Answer received");
          } catch (error) {
            console.error("Answer error:", error);
          }
          break;
        case "ice-candidate":
          try {
            if (peerRef.current && data) {
              await peerRef.current.addIceCandidate(new RTCIceCandidate(data));
            }
          } catch (error) {
            console.error("ICE error:", error);
          }
          break;
        case "audio-message":
          playIncomingMicAudio(message);
          break;
        case "audio-stop":
          resetMicPlayback();
          break;
        case "control-request":
          if (controlRequestHandlerRef.current) {
            controlRequestHandlerRef.current(data);
          }
          break;
        case "file-message":
          fileMessageHandlerRef.current?.(data);
          break;
        case "display-affinity-result":
          setCaptureExclusionStatus(
            data.captureExcluded
              ? "Capture exclusion is active in the connected desktop client."
              : "The connected client could not enable capture exclusion."
          );
          break;
        case "session-error":
          setCaptureExclusionStatus(data.message);
          break;
        default:
          break;
      }
    };

    socket.onclose = () => {
      console.log("WebSocket closed");
    };

    socket.onerror = (error) => {
      console.error("WebSocket error", error);
    };

    return () => {
      socket.close();
    };
  }, []);

  // ---------------------------------------------------------------------
  // Remote control (mouse / keyboard)
  // ---------------------------------------------------------------------

  function handleControlRequest(data) {
    const controlType = data?.controlType;
    if (controlType !== "mouse" && controlType !== "keyboard") return;
    // Use an in-page dialog instead of window.confirm(): browsers silently
    // auto-dismiss confirm() (returning false) when the tab is unfocused,
    // which denied control requests without the sender ever choosing.
    setPendingControlRequest({ controlType });
  }

  function respondToControlRequest(allowed) {
    const controlType = pendingControlRequest?.controlType;
    setPendingControlRequest(null);
    if (!controlType) return;

    if (allowed) {
      grantedControlRef.current = { ...grantedControlRef.current, [controlType]: true };
      setGrantedControl(grantedControlRef.current);
      setControlActivity(
        `${controlType === "mouse" ? "Mouse" : "Keyboard"} control granted to receiver.`
      );
    } else {
      setControlActivity(
        `${controlType === "mouse" ? "Mouse" : "Keyboard"} control request denied.`
      );
    }

    socketRef.current?.send(
      JSON.stringify({
        type: "control-response",
        sessionId: sessionIdRef.current,
        controlType,
        allowed
      })
    );
  }

  const sendFileMessage = (data) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !sessionIdRef.current) {
      return false;
    }
    socket.send(JSON.stringify({
      type: "file-message",
      sessionId: sessionIdRef.current,
      data
    }));
    return true;
  };

  function handleFileMessage(data) {
    switch (data?.kind) {
      case "upload-meta":
        incomingUploadRef.current = {
          name: data.name,
          size: Number(data.size),
          parts: []
        };
        setReceivedFile(null);
        setFileTransferStatus(`Receiving ${data.name} from the receiver...`);
        break;
      case "upload-chunk": {
        const upload = incomingUploadRef.current;
        if (!upload || upload.name !== data.name || !Number.isInteger(data.index)) {
          setFileTransferStatus("Received an unexpected file chunk.");
          break;
        }
        const binary = atob(data.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        upload.parts[data.index] = bytes;
        break;
      }
      case "upload-end": {
        const upload = incomingUploadRef.current;
        if (!upload || upload.name !== data.name) {
          setFileTransferStatus("The incoming file transfer could not be completed.");
          break;
        }
        const blob = new Blob(upload.parts, { type: "application/octet-stream" });
        if (blob.size !== upload.size) {
          setFileTransferStatus(
            `File transfer incomplete: expected ${upload.size} bytes, received ${blob.size}.`
          );
          sendFileMessage({
            kind: "upload-result",
            name: upload.name,
            error: "The received file size did not match the announced size."
          });
          incomingUploadRef.current = null;
          break;
        }
        setReceivedFile({ name: upload.name, blob });
        setFileTransferStatus(
          `${upload.name} is ready. Choose “Save received file” to download it.`
        );
        sendFileMessage({
          kind: "upload-result",
          name: upload.name,
          message: "File received and ready to save in the sender's browser."
        });
        incomingUploadRef.current = null;
        break;
      }
      case "download-request":
        setPendingDownloadRequest(data.name || "");
        setFileTransferStatus(
          `The receiver requested ${data.name || "a file"}. Choose a file to share from this browser.`
        );
        break;
      default:
        break;
    }
  }

  function saveReceivedFile() {
    if (!receivedFile) return;
    const url = URL.createObjectURL(receivedFile.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = receivedFile.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setFileTransferStatus(`Saved ${receivedFile.name} through the browser download.`);
    setReceivedFile(null);
  }

  async function sendSelectedFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const chunkSize = 256 * 1024;
    const total = Math.ceil(file.size / chunkSize);
    try {
      if (!sendFileMessage({ kind: "download-meta", name: file.name, size: file.size })) {
        throw new Error("WebSocket is not connected.");
      }
      for (let index = 0; index < total; index++) {
        const bytes = new Uint8Array(
          await file.slice(index * chunkSize, (index + 1) * chunkSize).arrayBuffer()
        );
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset++) {
          binary += String.fromCharCode(bytes[offset]);
        }
        if (!sendFileMessage({
          kind: "download-chunk",
          name: file.name,
          index,
          data: btoa(binary)
        })) {
          throw new Error("WebSocket connection closed during transfer.");
        }
        if (index % 8 === 7) {
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
      }
      if (!sendFileMessage({ kind: "download-end", name: file.name })) {
        throw new Error("WebSocket connection closed before transfer completed.");
      }
      setPendingDownloadRequest("");
      setFileTransferStatus(`Sent ${file.name} to the receiver.`);
    } catch (error) {
      setFileTransferStatus(`Could not send ${file.name}: ${error.message}`);
    }
  }

  function chooseFileToSend() {
    fileInputRef.current?.click();
  }

  useEffect(() => {
    controlRequestHandlerRef.current = handleControlRequest;
  });

  useEffect(() => {
    fileMessageHandlerRef.current = handleFileMessage;
  });

  const dispatchMouseEvent = (kind, event) => {
    const clientX = (event.x ?? 0.5) * window.innerWidth;
    const clientY = (event.y ?? 0.5) * window.innerHeight;
    const target = document.elementFromPoint(clientX, clientY) || document.body;
    target.dispatchEvent(
      new MouseEvent(kind, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        button: event.button ?? 0,
        buttons: kind === "mousedown" ? 1 : 0
      })
    );
    setControlActivity(
      `Remote mouse ${kind} at ${Math.round(clientX)}, ${Math.round(clientY)}`
    );
  };

  const dispatchKeyboardEvent = (kind, event) => {
    const active = document.activeElement || document.body;
    active.dispatchEvent(
      new KeyboardEvent(kind, {
        bubbles: true,
        cancelable: true,
        key: event.key ?? "",
        code: event.code ?? "",
        ctrlKey: Boolean(event.ctrlKey),
        altKey: Boolean(event.altKey),
        shiftKey: Boolean(event.shiftKey)
      })
    );
    setControlActivity(`Remote key ${kind}: ${event.key ?? "unknown"}`);
  };

  const applyRemoteControlEvent = (event) => {
    switch (event.kind) {
      case "mousemove":
      case "mousedown":
      case "mouseup":
      case "click":
      case "wheel":
        if (grantedControlRef.current.mouse) {
          dispatchMouseEvent(event.kind, event);
        }
        break;
      case "keydown":
      case "keyup":
        if (grantedControlRef.current.keyboard) {
          dispatchKeyboardEvent(event.kind, event);
        }
        break;
      default:
        break;
    }
  };

  const setupControlChannel = (channel) => {
    controlChannelRef.current = channel;
    channel.onmessage = (messageEvent) => {
      try {
        const event = JSON.parse(messageEvent.data);
        if (event.type === "control-event") {
          applyRemoteControlEvent(event);
        }
      } catch (error) {
        console.error("Control event error:", error);
      }
    };
  };

  const copySessionId = async () => {
    await navigator.clipboard.writeText(sessionId);
    alert("Session ID copied");
  };

  const updateCaptureExclusionRequest = (requested) => {
    setCaptureExclusionRequested(requested);

    if (!requested) {
      setCaptureExclusionStatus("Capture exclusion request disabled.");
      return;
    }

    if (!connected || !sessionId || socketRef.current?.readyState !== WebSocket.OPEN) {
      setCaptureExclusionStatus("Connect a receiver before requesting capture exclusion.");
      return;
    }

    socketRef.current.send(
      JSON.stringify({
        type: "display-affinity",
        sessionId,
        windowDisplayAffinity: WINDOWS_CAPTURE_EXCLUSION_AFFINITY,
        captureExclusionRequested: true,
        captureExcluded: false
      })
    );
    setCaptureExclusionStatus(
      "Request sent. A Windows desktop client must apply and confirm the setting."
    );
  };

  const startSharing = async () => {
    try {
      if (!connected) {
        alert("Please connect a receiver first.");
        return;
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false
      });

      streamRef.current = stream;
      const peer = new RTCPeerConnection(rtcConfig);
      peerRef.current = peer;

      // Data channel used by the receiver to send mouse/keyboard events.
      const controlChannel = peer.createDataChannel("control");
      setupControlChannel(controlChannel);

      stream.getTracks().forEach((track) => {
        peer.addTrack(track, stream);
      });

      peer.onicecandidate = (event) => {
        if (event.candidate) {
          socketRef.current?.send(
            JSON.stringify({
              type: "ice-candidate",
              sessionId,
              candidate: event.candidate
            })
          );
        }
      };

      stream.getVideoTracks()[0].onended = () => {
        stopSharing();
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      socketRef.current?.send(
        JSON.stringify({
          type: "offer",
          sessionId,
          offer
        })
      );

      setSharing(true);
      console.log("Screen sharing started");
    } catch (error) {
      console.error("Screen share error:", error);
      alert("Screen sharing was cancelled or blocked.");
    }
  };

  function stopSharing() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (peerRef.current) {
      peerRef.current.close();
      peerRef.current = null;
    }

    controlChannelRef.current = null;
    setSharing(false);
    setControlActivity("");
    console.log("Screen sharing stopped");
  }

  // ---------------------------------------------------------------------
  // Receiver -> Sender microphone playback (base64 PCM over WebSocket)
  // ---------------------------------------------------------------------

  function playIncomingMicAudio(message) {
    try {
      const { pcm, sampleRate } = message;
      if (!pcm) return;

      // Lazily create one persistent AudioContext at the incoming rate.
      if (
        !audioContextRef.current ||
        audioContextRef.current.sampleRate !== (sampleRate || 24000)
      ) {
        audioContextRef.current?.close().catch(() => {});
        audioContextRef.current = new AudioContext({
          sampleRate: sampleRate || 24000
        });
        nextStartTimeRef.current = 0;
      }
      const context = audioContextRef.current;

      // base64 -> Int16 (little-endian PCM) -> Float32 in [-1, 1]
      const binary = atob(pcm);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 0x8000;
      }

      const audioBuffer = context.createBuffer(
        1,
        float32.length,
        context.sampleRate
      );
      audioBuffer.copyToChannel(float32, 0);

      // Gapless streaming queue: schedule at the running play cursor.
      const startAt = Math.max(
        context.currentTime,
        nextStartTimeRef.current || context.currentTime
      );
      const source = context.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(context.destination);
      source.start(startAt);
      nextStartTimeRef.current = startAt + audioBuffer.duration;

      // Passive UI indicator: hide after 3s without a chunk.
      setMicLive(true);
      clearTimeout(micIndicatorTimeoutRef.current);
      micIndicatorTimeoutRef.current = setTimeout(() => setMicLive(false), 3000);
    } catch (error) {
      console.error("Mic audio playback error:", error);
    }
  }

  function resetMicPlayback() {
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    nextStartTimeRef.current = 0;
    clearTimeout(micIndicatorTimeoutRef.current);
    micIndicatorTimeoutRef.current = null;
    setMicLive(false);
  }

  useEffect(() => () => resetMicPlayback(), []); // cleanup on unmount

  return (
    <div className="sender-page">
      <header className="sender-header">
        <div className="sender-logo">
          Remote<span>Support</span>
        </div>
        <div className="sender-header-status">
          <span className={connected ? "status-dot online" : "status-dot waiting"} />
          {connected ? "Connected" : "Waiting"}
        </div>
      </header>
      <main className="sender-main">
        <div className="sender-heading">
          <h1>Share Your Computer</h1>
          <p>Allow another user to view your computer screen.</p>
        </div>
        <section className="sender-card">
          <div className="card-top">
            <div className="card-icon">🖥️</div>
            <div>
              <h2>Your Session</h2>
              <p>Share this ID with the receiver.</p>
            </div>
          </div>
          <div className="session-area">
            <label>SESSION ID</label>
            <div className="session-box">
              <strong>{sessionId || "Generating..."}</strong>
              <button onClick={copySessionId} disabled={!sessionId}>Copy</button>
            </div>
          </div>
          <div className="connection-status">
            {micLive && (
              <div className="mic-live-indicator" role="status">
                🎧 Receiver's microphone is live
              </div>
            )}
            <span className={connected ? "big-status-dot connected" : "big-status-dot" } />
            <div>
              <strong>{connected ? "Receiver connected" : "Waiting for receiver"}</strong>
              <p>{connected ? "You can now start screen sharing." : "Give the Session ID to another computer."}</p>
            </div>
          </div>
          <div className="capture-exclusion-option">
            <label>
              <input
                type="checkbox"
                checked={captureExclusionRequested}
                disabled={!connected}
                onChange={(event) => updateCaptureExclusionRequest(event.target.checked)}
              />
              Request capture exclusion for this application window
            </label>
            <p>
              This requires a Windows desktop client and never affects other applications.
            </p>
            {captureExclusionStatus && (
              <p className="capture-exclusion-status" role="status">
                {captureExclusionStatus}
              </p>
            )}
          </div>
          {!sharing ? (
            <button className="share-button" onClick={startSharing} disabled={!connected}>
              🖥️ Start Screen Sharing
            </button>
          ) : (
            <button className="stop-button" onClick={stopSharing}>
              ■ Stop Screen Sharing
            </button>
          )}
        </section>
        <section className="control-card">
          <div className="control-heading">
            <div className="control-icon">🖱️</div>
            <div>
              <h2>Remote Control</h2>
              <p>Control access is permission based.</p>
            </div>
          </div>
          <div className="control-options">
            <div className={grantedControl.mouse ? "control-item granted" : "control-item"}>
              <span>🖱️</span>
              <div>
                <strong>Mouse Control</strong>
                <small>
                  {grantedControl.mouse ? "Granted to receiver" : "Permission required"}
                </small>
              </div>
              <span className={grantedControl.mouse ? "unlocked" : "locked"}>
                {grantedControl.mouse ? "✅" : "🔒"}
              </span>
            </div>
            <div className={grantedControl.keyboard ? "control-item granted" : "control-item"}>
              <span>⌨️</span>
              <div>
                <strong>Keyboard Control</strong>
                <small>
                  {grantedControl.keyboard ? "Granted to receiver" : "Permission required"}
                </small>
              </div>
              <span className={grantedControl.keyboard ? "unlocked" : "locked"}>
                {grantedControl.keyboard ? "✅" : "🔒"}
              </span>
            </div>
          </div>
          {controlActivity && (
            <div className="permission-message" role="status">🖱️ {controlActivity}</div>
          )}
          {!controlActivity && (
            <div className="permission-message">🔐 Remote control requires your approval.</div>
          )}
          {pendingControlRequest && (
            <div className="control-approval" role="alertdialog" aria-live="assertive">
              <p>
                <strong>
                  The receiver is requesting{" "}
                  {pendingControlRequest.controlType === "mouse" ? "mouse" : "keyboard"} control
                  of your computer. Allow?
                </strong>
              </p>
              <div className="control-approval-actions">
                <button
                  className="approve-button"
                  onClick={() => respondToControlRequest(true)}
                >
                  ✅ Allow
                </button>
                <button
                  className="deny-button"
                  onClick={() => respondToControlRequest(false)}
                >
                  ✖ Deny
                </button>
              </div>
            </div>
          )}
        </section>
        {(pendingDownloadRequest || receivedFile || fileTransferStatus) && (
          <section className="control-card file-transfer-card">
            <h2>File transfer</h2>
            {fileTransferStatus && <p role="status">{fileTransferStatus}</p>}
            <div className="control-approval-actions">
              {pendingDownloadRequest && (
                <button className="approve-button" onClick={chooseFileToSend}>
                  Choose file to send
                </button>
              )}
              {receivedFile && (
                <button className="approve-button" onClick={saveReceivedFile}>
                  Save received file
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              hidden
              onChange={sendSelectedFile}
              aria-label="Choose a file to send to the receiver"
            />
          </section>
        )}
      </main>
    </div>
  );
}

export default Sender;

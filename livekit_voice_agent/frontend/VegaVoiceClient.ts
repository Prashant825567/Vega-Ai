/**
 * Vega App — MAX v1 SmallWebRTC Frontend Client (React Native Android / Expo + Web)
 *
 * Replaces `@livekit/react-native` (`LiveKitRoom`) with Pipecat's self-hosted
 * SmallWebRTC signaling (`POST /api/session` -> `POST /api/offer` -> `PATCH /api/offer`).
 *
 * Android / Expo Dependencies:
 *   npm uninstall @livekit/react-native @livekit/react-native-webrtc livekit-client
 *   npx expo install react-native-webrtc
 */

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface VegaSessionResponse {
  success: boolean;
  sessionId: string;
  sessionToken: string;
  offerUrl: string;
  patchUrl: string;
  iceServers: IceServerConfig[];
  voice: string;
  expiresAt: number;
}

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export interface VegaVoiceClientOptions {
  /** Base URL of your Pipecat SmallWebRTC backend (e.g. "https://your-server.onrender.com") */
  backendUrl: string;
  /** Optional user display name */
  participantName?: string;
  /** Gemini 2.5 Female Voice (default: "Aoede") */
  voice?: string;
  /** Enable automatic ICE restart / reconnection on transient network drop */
  autoReconnect?: boolean;
  /** Maximum reconnection attempts (default: 3) */
  maxReconnectAttempts?: number;
  /** Optional custom WebRTC implementation (e.g. from `react-native-webrtc`) */
  webrtcImpl?: {
    RTCPeerConnection: any;
    RTCSessionDescription: any;
    mediaDevices: any;
  };
  onStateChange?: (state: ConnectionState) => void;
  onError?: (error: Error) => void;
  onRemoteAudioStream?: (stream: any) => void;
}

export class VegaVoiceClient {
  private opts: Required<
    Pick<
      VegaVoiceClientOptions,
      "backendUrl" | "participantName" | "voice" | "autoReconnect" | "maxReconnectAttempts"
    >
  > &
    VegaVoiceClientOptions;

  private pc: any = null;
  private pcId: string | null = null;
  private localStream: any = null;
  private dataChannel: any = null;
  private sessionToken: string | null = null;
  private pendingCandidates: Array<{
    candidate: string;
    sdp_mid: string;
    sdp_mline_index: number;
  }> = [];
  private state: ConnectionState = "idle";
  private reconnectAttempts = 0;
  private manualDisconnect = false;

  constructor(options: VegaVoiceClientOptions) {
    this.opts = {
      ...options,
      backendUrl: options.backendUrl.replace(/\/+$/, ""),
      participantName: options.participantName ?? "Vega User",
      voice: options.voice ?? "Aoede",
      autoReconnect: options.autoReconnect ?? true,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 3,
    };
  }

  private setState(next: ConnectionState): void {
    this.state = next;
    this.opts.onStateChange?.(next);
  }

  private resolveWebRTC() {
    if (this.opts.webrtcImpl) {
      return this.opts.webrtcImpl;
    }
    const g: any = globalThis as any;
    if (g.RTCPeerConnection && g.mediaDevices) {
      return {
        RTCPeerConnection: g.RTCPeerConnection,
        RTCSessionDescription: g.RTCSessionDescription,
        mediaDevices: g.mediaDevices,
      };
    }
    if (typeof navigator !== "undefined" && (navigator as any).mediaDevices) {
      return {
        RTCPeerConnection: g.RTCPeerConnection,
        RTCSessionDescription: g.RTCSessionDescription,
        mediaDevices: (navigator as any).mediaDevices,
      };
    }
    throw new Error(
      "WebRTC APIs not found. On React Native / Android, pass `webrtcImpl` from `react-native-webrtc`."
    );
  }

  /**
   * Connect to the MAX v1 Pipecat SmallWebRTC Voice Agent.
   */
  async connect(restartPc = false): Promise<void> {
    this.manualDisconnect = false;
    this.setState(restartPc ? "reconnecting" : "connecting");

    try {
      const { RTCPeerConnection, RTCSessionDescription, mediaDevices } =
        this.resolveWebRTC();

      // 1. Request a signed session token + ICE server config from the backend
      const sesRes = await fetch(`${this.opts.backendUrl}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          participant_name: this.opts.participantName,
          voice: this.opts.voice,
        }),
      });
      if (!sesRes.ok) {
        throw new Error(`Session creation failed (${sesRes.status})`);
      }
      const session: VegaSessionResponse = await sesRes.json();
      this.sessionToken = session.sessionToken;

      // 2. Capture microphone audio with hardware AEC / NS / AGC enabled
      if (!this.localStream) {
        this.localStream = await mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
          video: false,
        });
      }

      // 3. Initialize RTCPeerConnection with STUN/TURN servers
      this.pc = new RTCPeerConnection({
        iceServers: session.iceServers?.length
          ? session.iceServers
          : [{ urls: ["stun:stun.l.google.com:19302"] }],
      });

      this.dataChannel = this.pc.createDataChannel("pipecat");

      for (const track of this.localStream.getTracks()) {
        this.pc.addTrack(track, this.localStream);
      }

      // Handle remote audio track from MAX v1
      this.pc.ontrack = (event: any) => {
        const remoteStream = event?.streams?.[0];
        if (remoteStream) {
          this.opts.onRemoteAudioStream?.(remoteStream);
        }
      };

      // Handle trickle ICE candidates
      this.pc.onicecandidate = (event: any) => {
        if (!event?.candidate) return;
        const item = {
          candidate: event.candidate.candidate || "",
          sdp_mid: event.candidate.sdpMid ?? "0",
          sdp_mline_index: event.candidate.sdpMLineIndex ?? 0,
        };
        if (this.pcId) {
          void this.sendIceCandidates([item]);
        } else {
          this.pendingCandidates.push(item);
        }
      };

      // Monitor ICE connection state for automatic recovery
      this.pc.oniceconnectionstatechange = () => {
        const iceState = this.pc?.iceConnectionState;
        if (iceState === "connected" || iceState === "completed") {
          this.reconnectAttempts = 0;
          this.setState("connected");
        } else if (
          (iceState === "failed" || iceState === "disconnected") &&
          !this.manualDisconnect
        ) {
          void this.handleTransientDisconnect();
        }
      };

      // 4. Create SDP Offer and exchange with `POST /api/offer`
      const offer = await this.pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });
      await this.pc.setLocalDescription(offer);

      const offerRes = await fetch(`${this.opts.backendUrl}${session.offerUrl}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.sessionToken}`,
        },
        body: JSON.stringify({
          sdp: offer.sdp,
          type: offer.type,
          pc_id: restartPc ? this.pcId : undefined,
          restart_pc: restartPc,
          voice: this.opts.voice,
          session_token: session.sessionToken,
        }),
      });

      if (!offerRes.ok) {
        const errText = await offerRes.text();
        throw new Error(`SmallWebRTC offer failed (${offerRes.status}): ${errText}`);
      }

      const answer = await offerRes.json();
      this.pcId = answer.pc_id;

      await this.pc.setRemoteDescription(
        RTCSessionDescription ? new RTCSessionDescription(answer) : answer
      );

      // Flush any ICE candidates gathered before `pcId` was assigned
      if (this.pendingCandidates.length > 0 && this.pcId) {
        const batch = [...this.pendingCandidates];
        this.pendingCandidates = [];
        await this.sendIceCandidates(batch);
      }

      this.setState("connected");
    } catch (err: any) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.setState("error");
      this.opts.onError?.(error);
      throw error;
    }
  }

  private async sendIceCandidates(
    candidates: Array<{
      candidate: string;
      sdp_mid: string;
      sdp_mline_index: number;
    }>
  ): Promise<void> {
    if (!this.pcId || candidates.length === 0) return;
    try {
      await fetch(`${this.opts.backendUrl}/api/offer`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pc_id: this.pcId,
          candidates,
        }),
      });
    } catch {
      // Ignore transient trickle ICE patch errors
    }
  }

  private async handleTransientDisconnect(): Promise<void> {
    if (
      !this.opts.autoReconnect ||
      this.reconnectAttempts >= this.opts.maxReconnectAttempts
    ) {
      await this.disconnect();
      return;
    }
    this.reconnectAttempts += 1;
    const delayMs = Math.min(4000, 750 * Math.pow(2, this.reconnectAttempts - 1));
    this.setState("reconnecting");
    await new Promise((r) => setTimeout(r, delayMs));
    if (!this.manualDisconnect) {
      try {
        await this. cleanupPeerOnly();
        await this.connect(true);
      } catch {
        // Next ICE event or max attempts will handle fallback
      }
    }
  }

  /**
   * Mute or unmute the local microphone track.
   */
  setMicEnabled(enabled: boolean): void {
    if (!this.localStream) return;
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = enabled;
    }
  }

  private async cleanupPeerOnly(): Promise<void> {
    try {
      this.dataChannel?.close?.();
    } catch {}
    this.dataChannel = null;

    try {
      this.pc?.close?.();
    } catch {}
    this.pc = null;
  }

  /**
   * Disconnect and release all microphone tracks, peer connections, and server pipeline resources.
   */
  async disconnect(): Promise<void> {
    this.manualDisconnect = true;
    const currentPcId = this.pcId;
    this.pcId = null;
    this.pendingCandidates = [];

    await this.cleanupPeerOnly();

    if (this.localStream) {
      try {
        for (const track of this.localStream.getTracks()) {
          track.stop();
        }
      } catch {}
      this.localStream = null;
    }

    if (currentPcId) {
      try {
        await fetch(
          `${this.opts.backendUrl}/api/session/${encodeURIComponent(currentPcId)}`,
          { method: "DELETE" }
        );
      } catch {}
    }

    this.setState("disconnected");
  }
}

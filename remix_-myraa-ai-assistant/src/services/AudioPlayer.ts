export class AudioPlayer {
  private audioCtx: AudioContext | null = null;
  private nextStartTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private onSpeakingChange?: (isSpeaking: boolean) => void;
  private onVolumeChange?: (volume: number) => void;
  private silenceCheckTimeout: any = null;

  constructor(
    onSpeakingChange?: (isSpeaking: boolean) => void,
    onVolumeChange?: (volume: number) => void
  ) {
    this.onSpeakingChange = onSpeakingChange;
    this.onVolumeChange = onVolumeChange;
  }

  public init() {
    if (!this.audioCtx) {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.audioCtx = new AudioContextClass({ sampleRate: 24000 });
      this.nextStartTime = this.audioCtx.currentTime;
    }
    if (this.audioCtx.state === "suspended") {
      this.audioCtx.resume();
    }
  }

  public playChunk(base64Data: string) {
    this.init();
    if (!this.audioCtx) return;

    try {
      const pcmBuffer = this.base64ToArrayBuffer(base64Data);
      const float32Samples = this.pcmToFloat32(pcmBuffer);

      // Calculate real-time volume (RMS) for the chunk
      if (this.onVolumeChange) {
        let sum = 0;
        for (let i = 0; i < float32Samples.length; i++) {
          sum += float32Samples[i] * float32Samples[i];
        }
        const rms = Math.sqrt(sum / (float32Samples.length || 1));
        // Amplify slightly for visualization visual effect
        this.onVolumeChange(Math.min(1, rms * 4));
      }

      // Create a 1-channel (mono) audio buffer at 24kHz
      const audioBuffer = this.audioCtx.createBuffer(1, float32Samples.length, 24000);
      audioBuffer.getChannelData(0).set(float32Samples);

      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioCtx.destination);

      // Schedule precisely
      const currentTime = this.audioCtx.currentTime;
      if (this.nextStartTime < currentTime) {
        // Safe padding for jitter
        this.nextStartTime = currentTime + 0.05;
      }

      source.start(this.nextStartTime);
      this.activeSources.push(source);

      // Notify that speaking started
      if (this.onSpeakingChange) {
        this.onSpeakingChange(true);
      }

      const duration = audioBuffer.duration;
      const scheduledEndTime = this.nextStartTime;

      // Update start time for next chunk
      this.nextStartTime += duration;

      // Setup cleanup when this source finishes playing
      source.onended = () => {
        this.activeSources = this.activeSources.filter((s) => s !== source);
        this.checkIfSpeakingFinished();
      };

      // Workaround for browser-specific onended bugs: auto-check based on time
      const msToFinish = (scheduledEndTime + duration - this.audioCtx.currentTime) * 1000;
      if (this.silenceCheckTimeout) {
        clearTimeout(this.silenceCheckTimeout);
      }
      this.silenceCheckTimeout = setTimeout(() => {
        this.checkIfSpeakingFinished();
      }, msToFinish + 100);

    } catch (err) {
      console.error("Error playing audio chunk in AudioPlayer:", err);
    }
  }

  private checkIfSpeakingFinished() {
    if (this.activeSources.length === 0) {
      if (this.onSpeakingChange) {
        this.onSpeakingChange(false);
      }
      if (this.onVolumeChange) {
        this.onVolumeChange(0);
      }
    }
  }

  public interrupt() {
    console.log("AudioPlayer: Interrupted. Stopping all scheduled buffers.");
    
    // Stop all playing and queued buffer sources
    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch (e) {
        // Already stopped or not started
      }
    });
    this.activeSources = [];

    if (this.silenceCheckTimeout) {
      clearTimeout(this.silenceCheckTimeout);
      this.silenceCheckTimeout = null;
    }

    if (this.audioCtx) {
      this.nextStartTime = this.audioCtx.currentTime;
    }

    if (this.onSpeakingChange) {
      this.onSpeakingChange(false);
    }

    if (this.onVolumeChange) {
      this.onVolumeChange(0);
    }
  }

  public stop() {
    this.interrupt();
    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch (e) {
        // Ignore
      }
      this.audioCtx = null;
    }
    this.nextStartTime = 0;
  }

  // Decodes a base64 string into an ArrayBuffer
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // Converts a 16-bit signed PCM buffer to Float32Array
  private pcmToFloat32(pcmBuffer: ArrayBuffer): Float32Array {
    const view = new DataView(pcmBuffer);
    const length = pcmBuffer.byteLength / 2;
    const float32 = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const int16 = view.getInt16(i * 2, true);
      // Normalize to [-1.0, 1.0]
      float32[i] = int16 / 32768.0;
    }
    return float32;
  }
}

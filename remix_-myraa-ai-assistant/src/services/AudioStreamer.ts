export class AudioStreamer {
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private onAudioChunk: (base64Chunk: string) => void;
  private onVolumeChange?: (volume: number) => void;
  private isStreaming = false;

  constructor(
    onAudioChunk: (base64Chunk: string) => void,
    onVolumeChange?: (volume: number) => void
  ) {
    this.onAudioChunk = onAudioChunk;
    this.onVolumeChange = onVolumeChange;
  }

  public async start() {
    if (this.isStreaming) return;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      // Configure 16kHz capture as required by Gemini Live
      this.audioCtx = new AudioContextClass({ sampleRate: 16000 });
      
      this.source = this.audioCtx.createMediaStreamSource(this.stream);
      
      // Buffer size of 4096 is a good balance for low-latency voice
      this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
      
      this.source.connect(this.processor);
      this.processor.connect(this.audioCtx.destination);

      this.processor.onaudioprocess = (e) => {
        if (!this.isStreaming) return;
        const inputData = e.inputBuffer.getChannelData(0);
        
        // Calculate volume (RMS)
        if (this.onVolumeChange) {
          let sum = 0;
          for (let i = 0; i < inputData.length; i++) {
            sum += inputData[i] * inputData[i];
          }
          const rms = Math.sqrt(sum / (inputData.length || 1));
          this.onVolumeChange(Math.min(1, rms * 4));
        }

        const pcmBuffer = this.floatTo16BitPCM(inputData);
        const base64 = this.arrayBufferToBase64(pcmBuffer);
        this.onAudioChunk(base64);
      };

      this.isStreaming = true;
      console.log("AudioStreamer: Started microphone recording at 16kHz");
    } catch (err) {
      console.error("AudioStreamer: Failed to capture microphone input:", err);
      throw err;
    }
  }

  public stop() {
    if (!this.isStreaming) return;
    this.isStreaming = false;

    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }

    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch (e) {
        // Ignore
      }
      this.audioCtx = null;
    }

    console.log("AudioStreamer: Stopped microphone recording");
  }

  private floatTo16BitPCM(float32Array: Float32Array): ArrayBuffer {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    let offset = 0;
    for (let i = 0; i < float32Array.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, float32Array[i]));
      // Convert to 16-bit signed integer
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }
}

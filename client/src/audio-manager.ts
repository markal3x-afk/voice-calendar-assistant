/**
 * Resampler helper to perform linear interpolation and convert
 * Float32 audio chunks (variable rate) to 16kHz 16-bit Signed PCM.
 */
class Resampler {
  private ratio: number;
  private offset: number = 0;

  constructor(inputSampleRate: number, targetSampleRate: number) {
    this.ratio = inputSampleRate / targetSampleRate;
  }

  resample(input: Float32Array): Int16Array {
    const outputLength = Math.floor((input.length - this.offset) / this.ratio);
    const output = new Int16Array(outputLength);

    let outputIdx = 0;
    while (this.offset < input.length) {
      const index = Math.floor(this.offset);
      const weight = this.offset - index;

      const sample1 = input[index];
      const sample2 = index + 1 < input.length ? input[index + 1] : sample1;
      const interpolated = sample1 + weight * (sample2 - sample1);

      // Clamp to [-1, 1] and convert to 16-bit signed PCM
      const clamped = Math.max(-1, Math.min(1, interpolated));
      output[outputIdx++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;

      this.offset += this.ratio;
    }

    // Keep the remainder offset phase for the next chunk
    this.offset -= input.length;
    return output;
  }
}

export class AudioManager {
  private audioContext: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private resampler: Resampler | null = null;
  private onAudioChunkCallback: ((base64Pcm: string) => void) | null = null;

  // Playback properties
  private scheduledTime: number = 0;
  private activeSourceNodes: AudioBufferSourceNode[] = [];
  private playbackSampleRate = 24000; // Gemini Live output rate

  private pcmAccumulator: number[] = [];

  constructor(onAudioChunk: (base64Pcm: string) => void) {
    this.onAudioChunkCallback = onAudioChunk;
  }

  /**
   * Initializes the AudioContext and loads the recording worklet
   */
  async startRecording() {
    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      
      // Request microphone access
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      this.micSource = this.audioContext.createMediaStreamSource(this.micStream);
      
      // Initialize resampler using context's native sample rate
      const nativeSampleRate = this.audioContext.sampleRate;
      this.resampler = new Resampler(nativeSampleRate, 16000);
      console.log(`AudioManager initialized. Native sample rate: ${nativeSampleRate}Hz. Resampling to 16000Hz.`);

      // Load the audio-worklet file
      await this.audioContext.audioWorklet.addModule("/audio-worklet.js");
      this.workletNode = new AudioWorkletNode(this.audioContext, "audio-input-processor");

      // Set up message handler to receive Float32 arrays from the worklet thread
      this.workletNode.port.onmessage = (event) => {
        const floatData = event.data as Float32Array;
        this.handleIncomingMicData(floatData);
      };

      // Connect nodes: Mic -> Worklet -> Destination (destination is muted by not connecting worklet to destination)
      this.micSource.connect(this.workletNode);
      
      // Resume context if suspended (common browser security policy)
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }
    } catch (err) {
      console.error("Failed to start recording:", err);
      this.stopRecording();
      throw err;
    }
  }

  /**
   * Processes raw float microphone samples, resamples to 16kHz PCM,
   * buffers up to 100ms (1600 samples), and sends it to the server.
   */
  private handleIncomingMicData(floatData: Float32Array) {
    if (!this.resampler || !this.onAudioChunkCallback) return;

    // Resample to 16kHz 16-bit signed PCM
    const pcm16 = this.resampler.resample(floatData);
    if (pcm16.length === 0) return;

    // Accumulate samples in memory
    for (let i = 0; i < pcm16.length; i++) {
      this.pcmAccumulator.push(pcm16[i]);
    }

    // Emit chunk once we have 100ms of audio (1600 samples at 16kHz)
    if (this.pcmAccumulator.length >= 1600) {
      const chunk = new Int16Array(this.pcmAccumulator);
      const base64 = this.int16ToBase64(chunk);
      this.onAudioChunkCallback(base64);
      this.pcmAccumulator = []; // Clear accumulator
    }
  }

  /**
   * Converts an Int16Array to a Base64 string
   */
  private int16ToBase64(buffer: Int16Array): string {
    const bytes = new Uint8Array(buffer.buffer);
    let binary = "";
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  /**
   * Base64 decodes a PCM 16-bit 24kHz buffer and queues it for playback
   */
  playAudioChunk(base64Pcm: string) {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    }

    try {
      // Decode base64 to binary string
      const binaryString = window.atob(base64Pcm);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Convert byte buffer to Int16Array (16-bit PCM)
      const int16Data = new Int16Array(bytes.buffer);

      // Convert Int16Array to Float32Array (normalized between -1.0 and 1.0)
      const float32Data = new Float32Array(int16Data.length);
      for (let i = 0; i < int16Data.length; i++) {
        float32Data[i] = int16Data[i] / (int16Data[i] < 0 ? 32768 : 32767);
      }

      this.queuePlayback(float32Data);
    } catch (err) {
      console.error("Failed to play audio chunk:", err);
    }
  }

  /**
   * Queues a Float32 buffer to play sequentially back-to-back using AudioContext time
   */
  private queuePlayback(float32Data: Float32Array) {
    if (!this.audioContext) return;

    // Create an AudioBuffer at 24kHz (Gemini Live output rate)
    const audioBuffer = this.audioContext.createBuffer(1, float32Data.length, this.playbackSampleRate);
    audioBuffer.getChannelData(0).set(float32Data);

    const sourceNode = this.audioContext.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(this.audioContext.destination);

    // Keep track of active nodes so we can cancel them on interruption
    this.activeSourceNodes.push(sourceNode);
    sourceNode.onended = () => {
      this.activeSourceNodes = this.activeSourceNodes.filter(node => node !== sourceNode);
    };

    const currentTime = this.audioContext.currentTime;

    // If we've fallen behind, reset scheduledTime to the current AudioContext time
    if (this.scheduledTime < currentTime) {
      this.scheduledTime = currentTime;
    }

    // Schedule play
    sourceNode.start(this.scheduledTime);
    
    // Advance scheduled time by this buffer's duration
    this.scheduledTime += audioBuffer.duration;
  }

  /**
   * Instantly stops all playing audio buffers and clears the queue
   */
  clearPlaybackQueue() {
    console.log(`Clearing playback queue. Stopping ${this.activeSourceNodes.length} active nodes.`);
    this.activeSourceNodes.forEach(node => {
      try {
        node.stop();
      } catch (err) {
        // Source node may have already finished or not started yet
      }
    });
    this.activeSourceNodes = [];
    this.scheduledTime = 0;
  }

  /**
   * Stops recording and cleans up mic nodes
   */
  stopRecording() {
    console.log("Stopping audio recording...");
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach(track => track.stop());
      this.micStream = null;
    }
    this.resampler = null;
  }

  /**
   * Completely closes the AudioManager and disposes AudioContext
   */
  async close() {
    this.stopRecording();
    this.clearPlaybackQueue();
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
    console.log("AudioManager closed.");
  }
}

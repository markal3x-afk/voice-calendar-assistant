class AudioInputProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input[0]) {
      const channelData = input[0];
      // Post the Float32Array of raw microphone samples to the main thread
      this.port.postMessage(channelData);
    }
    return true;
  }
}

registerProcessor("audio-input-processor", AudioInputProcessor);

// Attaches an HLS playlist to a <video>. hls.js wherever Media Source exists (it gives us
// control over buffering); Safari's native HLS otherwise. hls.js is loaded on demand so the
// lobby never pays for it.

/** What the player can do with an attached film: switch audio language, and detach. */
export type HlsSource = {
  destroy: () => void;
  /** Choose audio track i (the order of Media.audio). Remembered until the next attach. */
  setAudioTrack: (i: number) => void;
  audioTrack: () => number;
};

// Safari's native HLS exposes alternate audio as video.audioTracks.
type NativeAudioTracks = ArrayLike<{ enabled: boolean }>;
const nativeAudio = (video: HTMLVideoElement) => (video as unknown as { audioTracks?: NativeAudioTracks }).audioTracks;

export async function attachHls(
  video: HTMLVideoElement,
  url: string,
  onFatal: (msg: string) => void,
  initialAudio = 0,
): Promise<HlsSource> {
  const { default: Hls } = await import("hls.js");

  if (!Hls.isSupported()) {
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      const onError = () => onFatal("This film couldn't be loaded.");
      const pick = (i: number) => {
        const tracks = nativeAudio(video);
        if (!tracks || i >= tracks.length) return;
        for (let j = 0; j < tracks.length; j++) tracks[j].enabled = j === i;
      };
      const onMeta = () => pick(initialAudio);
      video.addEventListener("error", onError);
      video.addEventListener("loadedmetadata", onMeta);
      return {
        destroy: () => {
          video.removeEventListener("error", onError);
          video.removeEventListener("loadedmetadata", onMeta);
          video.removeAttribute("src");
          video.load();
        },
        setAudioTrack: pick,
        audioTrack: () => {
          const tracks = nativeAudio(video);
          for (let j = 0; tracks && j < tracks.length; j++) if (tracks[j].enabled) return j;
          return 0;
        },
      };
    }
    onFatal("This browser can't play the film.");
    return { destroy: () => {}, setAudioTrack: () => {}, audioTrack: () => 0 };
  }

  const hls = new Hls({
    // Weak connections ride out dips with a deep buffer (plan: 60s+ for struggling clients).
    maxBufferLength: 60,
    maxMaxBufferLength: 120,
    backBufferLength: 30,
    enableWorker: true,
    // A film still downloading is an EVENT playlist, which hls.js treats as live and would
    // start at the newest segment. The room decides the position, so start at the top.
    startPosition: 0,
  });
  let networkRetries = 0;
  let recovered = false;
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 3) {
      networkRetries++;
      setTimeout(() => hls.startLoad(), 1000 * networkRetries);
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
      recovered = true;
      hls.recoverMediaError();
      return;
    }
    onFatal(data.type === Hls.ErrorTypes.NETWORK_ERROR ? "Lost the connection to the film." : "This film couldn't be played.");
  });
  hls.on(Hls.Events.FRAG_LOADED, () => {
    networkRetries = 0;
  });
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    if (initialAudio > 0 && initialAudio < hls.audioTracks.length) hls.audioTrack = initialAudio;
  });
  hls.loadSource(url);
  hls.attachMedia(video);
  return {
    destroy: () => hls.destroy(),
    setAudioTrack: (i) => {
      if (i >= 0 && i < hls.audioTracks.length) hls.audioTrack = i;
    },
    audioTrack: () => Math.max(0, hls.audioTrack),
  };
}

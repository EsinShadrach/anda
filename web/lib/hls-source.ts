// Attaches an HLS playlist to a <video>. hls.js wherever Media Source exists (it gives us
// control over buffering); Safari's native HLS otherwise. hls.js is loaded on demand so the
// lobby never pays for it.

/** What the player can do with an attached film: switch audio language, and detach. */
export type HlsSource = {
  destroy: () => void;
  /** Choose audio track i (the order of Media.audio). Remembered until the next attach. */
  setAudioTrack: (i: number) => void;
  audioTrack: () => number;
  /** Data saver: stay on the lowest quality this film has. Off = pick by connection. */
  setDataSaver: (on: boolean) => void;
};

/** The film's video qualities (heights, low to high) and the one playing now. */
export type Quality = { heights: number[]; current: number | null };

export type AttachOptions = {
  initialAudio?: number;
  dataSaver?: boolean;
  onQuality?: (q: Quality) => void;
};

// Safari's native HLS exposes alternate audio as video.audioTracks.
type NativeAudioTracks = ArrayLike<{ enabled: boolean }>;
const nativeAudio = (video: HTMLVideoElement) => (video as unknown as { audioTracks?: NativeAudioTracks }).audioTracks;

export async function attachHls(
  video: HTMLVideoElement,
  url: string,
  onFatal: (msg: string) => void,
  { initialAudio = 0, dataSaver = false, onQuality }: AttachOptions = {},
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
        setDataSaver: () => {}, // Safari's native player picks quality itself
        audioTrack: () => {
          const tracks = nativeAudio(video);
          for (let j = 0; tracks && j < tracks.length; j++) if (tracks[j].enabled) return j;
          return 0;
        },
      };
    }
    onFatal("This browser can't play the film.");
    return { destroy: () => {}, setAudioTrack: () => {}, audioTrack: () => 0, setDataSaver: () => {} };
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
    // Fast start: most films also have a 480p rung with a keyframe every 2s (server:
    // media/rungs.go), so its first segment is ~80-220 KB where the original's can be 1-3 MB.
    // Start on it (levels are sorted lowest first) and let ABR climb; measured through a
    // link like the user's: first frame 2.0s -> 0.58s, full quality after ~2.5s.
    startLevel: 0,
    // Once it's measuring, assume a decent connection rather than hls.js's 0.5 Mbit/s guess.
    abrEwmaDefaultEstimate: 3_000_000,
    capLevelToPlayerSize: false,
  });
  // The cap is a property, not a config option, and hls.js resets it when a manifest loads,
  // so it's (re)applied in MANIFEST_PARSED below. startLevel above keeps the first segment
  // low too, so the start level and the cap never disagree.
  if (process.env.NODE_ENV === "development") (window as unknown as { __hls: unknown }).__hls = hls;
  const report = () =>
    onQuality?.({
      heights: hls.levels.map((l) => l.height).sort((a, b) => a - b),
      current: hls.currentLevel >= 0 ? (hls.levels[hls.currentLevel]?.height ?? null) : null,
    });
  const applySaver = (on: boolean) => {
    // Levels are sorted by bitrate, lowest first; -1 lets hls.js choose.
    hls.autoLevelCapping = on ? 0 : -1;
    if (on && hls.currentLevel > 0) hls.nextLevel = 0; // switch at the next segment
  };
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
    if (dataSaver) hls.autoLevelCapping = 0;
    report();
  });
  hls.on(Hls.Events.LEVEL_SWITCHED, report);
  // Seeking somewhere unbuffered (a room jump, a late joiner, a resume): fetch that spot from
  // the small rung first, then climb (seek 1.8s -> 0.48s in the same measurement). Registered
  // before attachMedia so it runs before hls.js's own seeking handler.
  const onSeeking = () => {
    if (hls.levels.length < 2) return;
    const t = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= t && t < video.buffered.end(i) - 0.5) return;
    }
    hls.nextLoadLevel = 0;
  };
  video.addEventListener("seeking", onSeeking);
  hls.loadSource(url);
  hls.attachMedia(video);
  return {
    destroy: () => {
      video.removeEventListener("seeking", onSeeking);
      hls.destroy();
    },
    setAudioTrack: (i) => {
      if (i >= 0 && i < hls.audioTracks.length) hls.audioTrack = i;
    },
    audioTrack: () => Math.max(0, hls.audioTrack),
    setDataSaver: applySaver,
  };
}

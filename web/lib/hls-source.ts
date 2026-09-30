// Attaches an HLS playlist to a <video>. hls.js wherever Media Source exists (it gives us
// control over buffering); Safari's native HLS otherwise. hls.js is loaded on demand so the
// lobby never pays for it.

type Cleanup = () => void;

export async function attachHls(video: HTMLVideoElement, url: string, onFatal: (msg: string) => void): Promise<Cleanup> {
  const { default: Hls } = await import("hls.js");

  if (!Hls.isSupported()) {
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      const onError = () => onFatal("This film couldn't be loaded.");
      video.addEventListener("error", onError);
      return () => {
        video.removeEventListener("error", onError);
        video.removeAttribute("src");
        video.load();
      };
    }
    onFatal("This browser can't play the film.");
    return () => {};
  }

  const hls = new Hls({
    // Weak connections ride out dips with a deep buffer (plan: 60s+ for struggling clients).
    maxBufferLength: 60,
    maxMaxBufferLength: 120,
    backBufferLength: 30,
    enableWorker: true,
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
  hls.loadSource(url);
  hls.attachMedia(video);
  return () => hls.destroy();
}
